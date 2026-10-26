import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyPatch, loadPolicy, tag, type OriginKind, type ResolvedIntent } from "@pfw/core";
import { IdempotencyConflictError, PolicyConflictError, RegistryError, Store } from "./index";

const policy = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));

const f = <T>(kind: OriginKind, value: T) => tag(value, { kind, ref: `${kind}:test` });
const intent = (o: Partial<ResolvedIntent> = {}): ResolvedIntent => ({
  agentId: "agent-1",
  idempotencyKey: "k1",
  payee: f("vendor", "Acme Supplies"),
  account: f("vendor", "acct_acme"),
  amount: f("user", 4500),
  currency: f("user", "USD"),
  category: f("vendor", "office_supplies"),
  ...o,
});

let now = new Date("2026-10-27T12:00:00.000Z");
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const MIN = 60_000;
const HOUR = 60 * MIN;

let store: Store;
const open = (path?: string) => {
  const s = new Store({ ...(path ? { path } : {}), clock: () => now });
  s.upsertVendor({ id: "acme", name: "Acme Supplies", account: "acct_acme", category: "office_supplies" });
  return s;
};
const count = (table: string) => (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  now = new Date("2026-10-27T12:00:00.000Z");
  store = open();
});
afterEach(() => store.close());

describe("idempotency", () => {
  test("a retry returns the stored decision and creates no second payment", () => {
    const first = store.decide(intent(), policy);
    const second = store.decide(intent(), policy);
    expect(first).toMatchObject({ replayed: false, decision: { verdict: "allow" } });
    expect(second.replayed).toBe(true);
    expect(second.decision).toEqual(first.decision);
    expect(count("payments")).toBe(1);
    expect(count("decisions")).toBe(1);
  });
  test("ten forced retries still produce one payment", () => {
    for (let n = 0; n < 10; n++) store.decide(intent(), policy);
    expect(count("payments")).toBe(1);
  });
  test("a retry after the clock moved still returns the original decision", () => {
    const first = store.decide(intent(), policy);
    advance(2 * HOUR);
    expect(store.decide(intent(), policy).decision.evaluatedAt).toBe(first.decision.evaluatedAt);
  });
  test("reusing a key for different values is a conflict and writes nothing", () => {
    store.decide(intent(), policy);
    expect(() => store.decide(intent({ amount: f("user", 9999) }), policy)).toThrow(IdempotencyConflictError);
    expect(() => store.decide(intent({ account: f("literal", "acct_evil") }), policy)).toThrow(IdempotencyConflictError);
    expect(count("decisions")).toBe(1);
    expect(count("payments")).toBe(1);
  });
  test("denials and approvals are stored and replayed too, and are not counted as payments", () => {
    const deny = intent({ idempotencyKey: "d", payee: f("invoice", "Evil"), account: f("invoice", "acct_evil") });
    expect(store.decide(deny, policy).decision.verdict).toBe("deny");
    expect(store.decide(deny, policy).replayed).toBe(true);
    const ask = intent({ idempotencyKey: "a", amount: f("user", 60000) });
    expect(store.decide(ask, policy).decision.verdict).toBe("require_approval");
    expect(count("decisions")).toBe(2);
    expect(count("payments")).toBe(0);
  });
  test("decisions survive a restart and replay from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfw-"));
    try {
      const path = join(dir, "pfw.db");
      store.close();
      store = open(path);
      const first = store.decide(intent(), policy);
      store.close();
      store = open(path);
      const again = store.decide(intent(), policy);
      expect(again.replayed).toBe(true);
      expect(again.decision).toEqual(first.decision);
    } finally {
      store.close();
      store = open(); // afterEach closes this one
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("two connections to the same file agree on one decision per key", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfw-"));
    const path = join(dir, "pfw.db");
    const a = open(path);
    const b = open(path);
    try {
      expect(a.decide(intent(), policy).replayed).toBe(false);
      expect(b.decide(intent(), policy).replayed).toBe(true);
    } finally {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("counters", () => {
  test("velocity: the sixth payment in an hour is denied, and the window slides", () => {
    for (let n = 0; n < 5; n++) {
      expect(store.decide(intent({ idempotencyKey: `v${n}` }), policy).decision.verdict).toBe("allow");
    }
    const sixth = store.decide(intent({ idempotencyKey: "v5" }), policy).decision;
    expect(sixth).toMatchObject({ verdict: "deny", rule: "velocity" });
    advance(HOUR + MIN);
    expect(store.decide(intent({ idempotencyKey: "v6" }), policy).decision.verdict).toBe("allow");
  });
  test("velocity is per agent", () => {
    for (let n = 0; n < 5; n++) store.decide(intent({ idempotencyKey: `v${n}` }), policy);
    expect(store.decide(intent({ idempotencyKey: "other", agentId: "agent-2" }), policy).decision.verdict).toBe("allow");
  });
  test("per-vendor daily cap counts earlier allowed payments, then resets next UTC day", () => {
    const pay = (k: string) => store.decide(intent({ idempotencyKey: k, amount: f("user", 50000) }), policy).decision;
    expect(pay("c1").verdict).toBe("allow");
    advance(2 * HOUR);
    expect(pay("c2").verdict).toBe("allow");
    advance(2 * HOUR);
    expect(pay("c3").verdict).toBe("allow"); // exactly 150000
    advance(2 * HOUR);
    expect(pay("c4")).toMatchObject({ verdict: "deny", rule: "hard_limit" });
    now = new Date("2026-10-28T00:00:00.000Z");
    expect(pay("c5").verdict).toBe("allow");
  });
  test("denied and pending intents do not use up the daily cap", () => {
    store.decide(intent({ idempotencyKey: "big", amount: f("user", 100001) }), policy); // deny
    store.decide(intent({ idempotencyKey: "ask", amount: f("user", 60000) }), policy); // approval
    expect(store.decide(intent({ idempotencyKey: "ok", amount: f("user", 50000) }), policy).decision.verdict).toBe("allow");
  });
  test("total daily cap spans vendors", () => {
    store.upsertVendor({ id: "beta", name: "Beta Software", account: "acct_beta", category: "software" });
    const pay = (k: string, name: string, acct: string) =>
      store.decide(intent({ idempotencyKey: k, payee: f("vendor", name), account: f("vendor", acct), amount: f("user", 50000) }), policy).decision;
    for (let n = 0; n < 3; n++) {
      pay(`a${n}`, "Acme Supplies", "acct_acme");
      advance(HOUR + MIN);
    }
    // acme at its 150000 vendor cap; beta takes the rest of the 300000 total
    for (let n = 0; n < 3; n++) {
      expect(pay(`b${n}`, "Beta Software", "acct_beta").verdict).toBe("allow");
      advance(HOUR + MIN);
    }
    store.upsertVendor({ id: "gamma", name: "Gamma", account: "acct_gamma", category: "software" });
    expect(pay("g", "Gamma", "acct_gamma")).toMatchObject({ verdict: "deny", rule: "hard_limit" });
  });
});

describe("purchase orders", () => {
  const inv = (k: string, amount: number) => intent({ idempotencyKey: k, amount: f("invoice", amount) });
  test("an invoice amount matching an open purchase order is allowed", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
    expect(store.decide(inv("p1", 4500), policy).decision.verdict).toBe("allow");
  });
  test("an inflated invoice needs approval", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
    expect(store.decide(inv("p2", 45000), policy).decision).toMatchObject({ verdict: "require_approval", rule: "amount_mismatch" });
  });
  test("with several open orders the closest one is used", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
    store.addPurchaseOrder({ id: "po2", vendorId: "acme", amount: 20000, currency: "USD" });
    expect(store.decide(inv("p3", 20100), policy).decision.verdict).toBe("allow");
  });
  test("no purchase order: untrusted amount needs approval", () => {
    expect(store.decide(inv("p4", 4500), policy).decision.rule).toBe("amount_mismatch");
  });
});

describe("purchase order consumption", () => {
  const inv = (k: string, amount: number) => intent({ idempotencyKey: k, amount: f("invoice", amount) });
  test("a paid purchase order closes, so a re-sent invoice needs approval", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
    expect(store.decide(inv("first", 4500), policy).decision.verdict).toBe("allow");
    expect(store.decide(inv("resent", 4500), policy).decision).toMatchObject({ verdict: "require_approval", rule: "amount_mismatch" });
    expect(store.audit.entries().some((e) => e.type === "purchase_order_closed")).toBe(true);
  });
  test("a po: handle amount closes that order too", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
    const viaHandle = (k: string) => intent({ idempotencyKey: k, amount: tag(4500, { kind: "po", ref: "po:po1#amount" }) });
    store.decide(viaHandle("a"), policy);
    expect(store.db.prepare("SELECT status FROM purchase_orders WHERE id = 'po1'").get()).toEqual({ status: "closed" });
  });
  test("denied and pending intents leave the order open", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
    store.decide(inv("big", 450000), policy); // needs approval
    expect(store.db.prepare("SELECT status FROM purchase_orders WHERE id = 'po1'").get()).toEqual({ status: "open" });
  });
  test("orders are used one at a time, closest first", () => {
    store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4000, currency: "USD" });
    store.addPurchaseOrder({ id: "po2", vendorId: "acme", amount: 4000, currency: "USD" });
    expect(store.decide(inv("x1", 4000), policy).decision.verdict).toBe("allow");
    expect(store.decide(inv("x2", 4000), policy).decision.verdict).toBe("allow");
    expect(store.decide(inv("x3", 4000), policy).decision.verdict).toBe("require_approval");
  });
});

describe("dashboard queries", () => {
  test("listDecisions returns newest first with execution and approval state", () => {
    store.decide(intent({ idempotencyKey: "a" }), policy);
    store.decide(intent({ idempotencyKey: "b", amount: f("user", 60000) }), policy);
    store.saveExecution("a", { state: "executed", retryable: false, payload: {}, reference: "B1" });
    const rows = store.listDecisions();
    expect(rows.map((r) => r.idempotencyKey)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ verdict: "require_approval", approval: { status: "pending" }, execution: null, amount: 60000, payee: "Acme Supplies" });
    expect(rows[1]).toMatchObject({ verdict: "allow", execution: "executed", approval: null });
    expect(store.listDecisions({ limit: 1, offset: 1 }).map((r) => r.idempotencyKey)).toEqual(["a"]);
  });
  test("getDecisionRecord gathers the decision, execution and audit entries for one key", () => {
    store.decide(intent({ idempotencyKey: "a" }), policy);
    store.saveExecution("a", { state: "executed", retryable: false, payload: { reference: "B1" }, reference: "B1" });
    store.decide(intent({ idempotencyKey: "other" }), policy);
    const rec = store.getDecisionRecord("a")!;
    expect(rec.decision.fields.payee.origins[0]?.kind).toBe("vendor");
    expect(rec.execution?.reference).toBe("B1");
    expect(rec.audit.map((e) => e.type)).toEqual(["decision", "execution"]);
    expect(store.getDecisionRecord("missing")).toBeNull();
  });
});

describe("policy versions", () => {
  test("there is no active stored policy until one is activated", () => {
    expect(store.activePolicy()).toBeNull();
    expect(store.listPolicyVersions()).toEqual([]);
  });
  test("activating records who, why, and the exact document, in the audit log", () => {
    const next = applyPatch(policy, { approvalThreshold: 20_000 });
    const active = store.activatePolicy({ baseVersion: 1, doc: next, confirmedBy: "dana@company.example", sourceText: "approve anything over $200", patch: { approvalThreshold: 20_000 } });
    expect(active).toMatchObject({ version: 2, approvalThreshold: 20_000 });
    expect(store.activePolicy()?.hash).toBe(active.hash);
    const [v] = store.listPolicyVersions();
    expect(v).toMatchObject({ version: 2, active: true, confirmedBy: "dana@company.example", sourceText: "approve anything over $200" });
    const entry = store.audit.entries().find((e) => e.type === "policy_activated");
    expect(entry?.payload).toMatchObject({ version: 2, confirmedBy: "dana@company.example", sourceText: "approve anything over $200" });
    expect(store.audit.verify().ok).toBe(true);
  });
  test("later decisions use the new version and record its hash", () => {
    const next = applyPatch(policy, { approvalThreshold: 1_000 });
    const active = store.activatePolicy({ baseVersion: 1, doc: next, confirmedBy: "dana" });
    const d = store.decide(intent({ idempotencyKey: "pv" }), active).decision;
    expect(d.verdict).toBe("require_approval");
    expect(d.policy).toMatchObject({ version: 2, hash: active.hash });
  });
  test("a stale base version, a skipped version and a missing confirmer are conflicts", () => {
    const v2 = applyPatch(policy, { approvalThreshold: 20_000 });
    store.activatePolicy({ baseVersion: 1, doc: v2, confirmedBy: "dana" });
    expect(() => store.activatePolicy({ baseVersion: 1, doc: applyPatch(policy, { approvalThreshold: 30_000 }), confirmedBy: "eve" })).toThrow(PolicyConflictError);
    expect(() => store.activatePolicy({ baseVersion: 2, doc: { ...v2, version: 9 }, confirmedBy: "eve" })).toThrow(/version 3/);
    expect(() => store.activatePolicy({ baseVersion: 2, doc: applyPatch(v2, { approvalThreshold: 1 }), confirmedBy: "  " })).toThrow(/required/);
    expect(store.listPolicyVersions()).toHaveLength(1);
  });
  test("only one version is active and older ones are kept", () => {
    const v2 = applyPatch(policy, { approvalThreshold: 20_000 });
    store.activatePolicy({ baseVersion: 1, doc: v2, confirmedBy: "dana" });
    store.activatePolicy({ baseVersion: 2, doc: applyPatch(v2, { approvalThreshold: 30_000 }), confirmedBy: "dana" });
    const all = store.listPolicyVersions();
    expect(all.map((v) => [v.version, v.active])).toEqual([[3, true], [2, false]]);
  });
});

describe("operator-supplied text is bounded before it enters the append-only log", () => {
  test("approver, note, confirmer, policy text and registry author have limits, and a refusal writes nothing", () => {
    const before = store.audit.entries().length;
    const big = (n: number) => "x".repeat(n);
    store.decide(intent({ idempotencyKey: "held", amount: f("user", 60000) }), policy);
    const id = store.listApprovals("pending")[0]!.id;
    expect(() => store.resolveApproval(id, { approver: big(201), approve: true }, policy)).toThrow(/too long/);
    expect(() => store.resolveApproval(id, { approver: "dana", approve: true, note: big(1001) }, policy)).toThrow(/too long/);
    expect(() => store.activatePolicy({ baseVersion: 1, doc: applyPatch(policy, { approvalThreshold: 1 }), confirmedBy: big(201) })).toThrow(/too long/);
    expect(() => store.activatePolicy({ baseVersion: 1, doc: applyPatch(policy, { approvalThreshold: 1 }), confirmedBy: "dana", sourceText: big(4001) })).toThrow(/too long/);
    expect(() => store.changeVendor({ id: "newco", name: "New Co", account: "n@x.example", category: "software" }, big(201))).toThrow(/too long/);
    expect(() => store.changePurchaseOrder({ id: "po-x", vendorId: "acme", amount: 1, currency: "USD" }, big(201))).toThrow(/too long/);
    expect(store.listApprovals("pending")).toHaveLength(1); // the approval is untouched and still pending
    expect(store.audit.entries().length).toBe(before + 2); // only the held decision and its approval request
    expect(store.audit.verify().ok).toBe(true);
  });
  test("the limits themselves are accepted", () => {
    store.decide(intent({ idempotencyKey: "held2", amount: f("user", 60000) }), policy);
    const id = store.listApprovals("pending")[0]!.id;
    expect(store.resolveApproval(id, { approver: "d".repeat(200), approve: false, note: "n".repeat(1000) }, policy)).toMatchObject({ ok: true });
  });
});

describe("operator registry changes", () => {
  const acme2 = { id: "acme", name: "Acme Supplies", account: "billing@acme.example", category: "office_supplies" };

  test("adding a vendor is audited with who did it and is not flagged as an account change", () => {
    const c = store.changeVendor({ id: "beta", name: "Beta Software", account: "beta@sandbox.example", category: "software" }, "dana@company.example");
    expect(c).toMatchObject({ before: null, accountChanged: false });
    expect(store.audit.entries().at(-1)).toMatchObject({ type: "vendor_changed", payload: { vendorId: "beta", changedBy: "dana@company.example", accountChanged: false } });
  });
  test("changing where an existing vendor is paid is flagged and recorded with both accounts", () => {
    const c = store.changeVendor(acme2, "dana");
    expect(c).toMatchObject({ accountChanged: true, before: { account: "acct_acme" }, after: { account: "billing@acme.example" } });
    expect(store.audit.entries().at(-1)?.payload).toMatchObject({ accountChanged: true, before: { account: "acct_acme" }, after: { account: "billing@acme.example" } });
  });
  test("after an account change, the old account is a payee swap and the new one is the exact match", () => {
    store.changeVendor(acme2, "dana");
    expect(store.decide(intent({ idempotencyKey: "old" }), policy).decision).toMatchObject({ verdict: "deny", rule: "payee_change" });
    const fresh = intent({ idempotencyKey: "new", account: f("vendor", "billing@acme.example") });
    expect(store.decide(fresh, policy).decision.verdict).toBe("allow");
  });
  test.each([
    ["no author", { ...acme2 }, "  ", /who/],
    ["bad id", { ...acme2, id: "A B" }, "d", /vendor id/],
    ["bad account", { ...acme2, account: "not an account" }, "d", /account/],
    ["bad category", { ...acme2, category: "Office Supplies" }, "d", /category/],
    ["padded name", { ...acme2, name: " Acme Supplies" }, "d", /spaces/],
    ["empty name", { ...acme2, name: "" }, "d", /name/],
  ])("rejects %s", (_n, v, by, msg) => {
    expect(() => store.changeVendor(v, by)).toThrow(RegistryError);
    expect(() => store.changeVendor(v, by)).toThrow(msg);
  });
  test("a different vendor cannot take an existing name, even with different casing", () => {
    expect(() => store.changeVendor({ id: "imposter", name: "ACME SUPPLIES", account: "evil@x.example", category: "office_supplies" }, "d")).toThrow(/already has that name/);
  });
  test("a PayPal ID is accepted as an account", () => {
    expect(() => store.changeVendor({ id: "pid", name: "PayPal ID Co", account: "ABCDEFGHIJKLM", category: "software" }, "d")).not.toThrow();
  });
  test("purchase orders are validated, attributed and listed with their status", () => {
    store.changePurchaseOrder({ id: "po-1", vendorId: "acme", amount: 45_000, currency: "USD" }, "dana");
    expect(store.listPurchaseOrders()).toEqual([{ id: "po-1", vendorId: "acme", amount: 45_000, currency: "USD", status: "open" }]);
    expect(store.audit.entries().at(-1)).toMatchObject({ type: "purchase_order_added", payload: { changedBy: "dana" } });
    for (const bad of [{ id: "po-1", vendorId: "acme", amount: 1, currency: "USD" }, { id: "po-2", vendorId: "ghost", amount: 1, currency: "USD" }, { id: "po-3", vendorId: "acme", amount: -5, currency: "USD" }, { id: "po-4", vendorId: "acme", amount: 1.5, currency: "USD" }, { id: "po-5", vendorId: "acme", amount: 1, currency: "usd" }]) {
      expect(() => store.changePurchaseOrder(bad, "d")).toThrow(RegistryError);
    }
    expect(store.listPurchaseOrders()).toHaveLength(1);
  });
  test("rejected changes leave no audit entry", () => {
    const before = store.audit.entries().length;
    expect(() => store.changeVendor({ ...acme2, account: "bad" }, "d")).toThrow();
    expect(store.audit.entries()).toHaveLength(before);
    expect(store.audit.verify().ok).toBe(true);
  });
});

describe("audit immutability", () => {
  test("decisions cannot be updated or deleted", () => {
    store.decide(intent(), policy);
    expect(() => store.db.prepare("UPDATE decisions SET verdict = 'allow'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare("DELETE FROM decisions").run()).toThrow(/append-only/);
  });
  test("a failing evaluation rolls back and records nothing", () => {
    const broken = { ...intent(), amount: undefined } as unknown as ResolvedIntent;
    expect(() => store.decide(broken, policy)).toThrow();
    expect(count("decisions")).toBe(0);
  });
});
