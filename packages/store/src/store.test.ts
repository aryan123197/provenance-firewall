import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadPolicy, tag, type OriginKind, type ResolvedIntent } from "@pfw/core";
import { IdempotencyConflictError, Store } from "./index";

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
