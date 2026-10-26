import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  evaluate,
  loadPolicy,
  tag,
  type OriginKind,
  type PolicyState,
  type PurchaseOrder,
  type ResolvedIntent,
  type VendorRecord,
} from "./index";

const policy = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));

const acme: VendorRecord = { id: "acme", name: "Acme Supplies", account: "acct_acme", category: "office_supplies" };
const casino: VendorRecord = { id: "lucky", name: "Lucky Co", account: "acct_lucky", category: "gambling" };
const po = (amount: number, vendorId = "acme", currency = "USD"): PurchaseOrder => ({ id: "po_1", vendorId, amount, currency });

const f = <T>(kind: OriginKind, value: T) => tag(value, { kind, ref: `${kind}:test` });

type Overrides = Partial<{ [K in keyof ResolvedIntent]: ResolvedIntent[K] }>;
const intent = (o: Overrides = {}): ResolvedIntent => ({
  agentId: "agent-1",
  idempotencyKey: "k1",
  payee: f("vendor", acme.name),
  account: f("vendor", acme.account),
  amount: f("po", 4500),
  currency: f("user", "USD"),
  category: f("vendor", "office_supplies"),
  ...o,
});
const state = (o: Partial<PolicyState> = {}): PolicyState => ({
  now: "2026-10-26T12:00:00.000Z",
  vendors: [acme, casino],
  purchaseOrder: po(4500),
  vendorSpentToday: {},
  totalSpentToday: 0,
  paymentsLastHour: 0,
  ...o,
});
const run = (i: Overrides = {}, s: Partial<PolicyState> = {}) => evaluate(intent(i), policy, state(s));

describe("legitimate payments", () => {
  test("trusted fields within policy are allowed", () => {
    const d = run();
    expect(d.verdict).toBe("allow");
    expect(d.rule).toBe("default_allow");
  });
  test("invoice amount matching the purchase order is allowed", () => {
    expect(run({ amount: f("invoice", 4500) }).verdict).toBe("allow");
  });
  test("payee and account from invoice text are fine when they exactly match the registry", () => {
    expect(run({ payee: f("invoice", acme.name), account: f("invoice", acme.account) }).verdict).toBe("allow");
  });
});

describe("provenance rules", () => {
  test("injected invoice payee/account not in registry: deny untrusted_payee", () => {
    const d = run({ payee: f("invoice", "Evil Corp"), account: f("invoice", "acct_evil") });
    expect(d).toMatchObject({ verdict: "deny", rule: "untrusted_payee", alert: false });
  });
  test("raw literal account is untrusted even if the payee is trusted and unknown", () => {
    const d = run({ payee: f("user", "New Vendor"), account: f("literal", "acct_x") });
    expect(d).toMatchObject({ verdict: "deny", rule: "untrusted_payee" });
  });
  test("payee swap (real name, attacker account): deny and alert", () => {
    const d = run({ payee: f("invoice", acme.name), account: f("invoice", "acct_evil") });
    expect(d).toMatchObject({ verdict: "deny", rule: "payee_change", alert: true });
  });
  test("payee swap is caught even when the account is stated by the user (T0)", () => {
    expect(run({ account: f("user", "acct_evil") })).toMatchObject({ verdict: "deny", rule: "payee_change" });
  });
  test("name lookalike with different case/spacing but wrong account is a payee change", () => {
    const d = run({ payee: f("invoice", "  acme supplies "), account: f("invoice", "acct_evil") });
    expect(d.rule).toBe("payee_change");
  });
  test("lookalike name with the right account is not an exact match: deny and alert", () => {
    const d = run({ payee: f("invoice", "acme supplies"), account: f("invoice", acme.account) });
    expect(d).toMatchObject({ verdict: "deny", rule: "payee_change", alert: true });
  });
  test("new payee confirmed by the user (T0): require approval at any amount", () => {
    const d = run({ payee: f("user", "New Vendor"), account: f("user", "acct_new"), amount: f("user", 100) });
    expect(d).toMatchObject({ verdict: "require_approval", rule: "new_payee" });
  });
  test("a trusted exact registry match is not a new payee", () => {
    expect(run().findings.some((x) => x.rule === "new_payee")).toBe(false);
  });
});

describe("amount rules", () => {
  test.each([
    [10500, "allow"],
    [10501, "require_approval"],
    [9500, "allow"],
    [9499, "require_approval"],
  ])("T3 amount %i against a 10000 PO (5%% tolerance) is %s", (amt, verdict) => {
    const d = run({ amount: f("invoice", amt) }, { purchaseOrder: po(10000) });
    expect(d.verdict).toBe(verdict);
    if (verdict !== "allow") expect(d.rule).toBe("amount_mismatch");
  });
  test("10x inflation: require approval", () => {
    expect(run({ amount: f("invoice", 45000) })).toMatchObject({ verdict: "require_approval", rule: "amount_mismatch" });
  });
  test("T3 amount with no purchase order needs approval", () => {
    expect(run({ amount: f("invoice", 4500) }, { purchaseOrder: null })).toMatchObject({ rule: "amount_mismatch" });
  });
  test("a purchase order for another vendor cannot confirm the amount", () => {
    expect(run({ amount: f("invoice", 4500) }, { purchaseOrder: po(4500, "lucky") }).rule).toBe("amount_mismatch");
  });
  test("purchase order in another currency does not confirm the amount", () => {
    expect(run({ amount: f("invoice", 4500) }, { purchaseOrder: po(4500, "acme", "EUR") }).rule).toBe("amount_mismatch");
  });
  test("user-stated amounts need no purchase order", () => {
    expect(run({ amount: f("user", 4500) }, { purchaseOrder: null }).verdict).toBe("allow");
  });
});

describe("limits and thresholds", () => {
  test("approval threshold is strictly greater-than", () => {
    expect(run({ amount: f("user", 50000) }).verdict).toBe("allow");
    expect(run({ amount: f("user", 50001) })).toMatchObject({ verdict: "require_approval", rule: "approval_threshold" });
  });
  test("per-payment cap: at the cap needs approval, above it is denied", () => {
    expect(run({ amount: f("user", 100000) }).verdict).toBe("require_approval");
    expect(run({ amount: f("user", 100001) })).toMatchObject({ verdict: "deny", rule: "hard_limit" });
  });
  test("per-vendor daily cap", () => {
    const s = { vendorSpentToday: { acme: 100000 } };
    expect(run({ amount: f("user", 50000) }, s).verdict).toBe("allow"); // exactly 150000
    expect(run({ amount: f("user", 50001) }, s)).toMatchObject({ verdict: "deny", rule: "hard_limit" });
  });
  test("total daily cap", () => {
    const s = { totalSpentToday: 270000 };
    expect(run({ amount: f("user", 30000) }, s).verdict).toBe("allow");
    expect(run({ amount: f("user", 30001) }, s)).toMatchObject({ verdict: "deny", rule: "hard_limit" });
  });
  test("five payments just under the threshold are stopped by the daily cap", () => {
    const d = run({ amount: f("user", 49999) }, { vendorSpentToday: { acme: 4 * 49999 }, totalSpentToday: 4 * 49999 });
    expect(d).toMatchObject({ verdict: "deny", rule: "hard_limit" });
  });
  test("currency outside the policy is denied", () => {
    expect(run({ currency: f("user", "EUR") })).toMatchObject({ verdict: "deny", rule: "currency" });
  });
});

describe("category thresholds and weekday rule", () => {
  const custom = (o: Partial<typeof policy>) => ({ ...policy, ...o });
  const contractor: VendorRecord = { id: "c", name: "Casey Contracting", account: "acct_casey", category: "contractors" };
  const ci = (amount: number) => intent({ payee: f("vendor", contractor.name), account: f("vendor", contractor.account), amount: f("user", amount), category: f("vendor", "contractors") });
  const cs = (o: Partial<PolicyState> = {}) => state({ vendors: [acme, contractor], ...o });

  test("a category override replaces the global threshold for that category only", () => {
    const p = custom({ categoryApprovalThresholds: { contractors: 20_000 } });
    expect(evaluate(ci(20_000), p, cs()).verdict).toBe("allow");
    expect(evaluate(ci(20_001), p, cs())).toMatchObject({ verdict: "require_approval", rule: "approval_threshold" });
    expect(evaluate(intent({ amount: f("user", 20_001) }), p, cs()).verdict).toBe("allow"); // office supplies keep the $500 default
  });
  test("an override above the global threshold lets that category pay more without approval", () => {
    const p = custom({ categoryApprovalThresholds: { contractors: 90_000 } });
    expect(evaluate(ci(60_000), p, cs()).verdict).toBe("allow");
  });
  test("the override follows the vendor's category on file, not the one claimed", () => {
    const p = custom({ categoryApprovalThresholds: { contractors: 20_000 } });
    const claimed = ci(30_000);
    expect(evaluate({ ...claimed, category: f("literal", "office_supplies") }, p, cs()).rule).toBe("approval_threshold");
  });
  test.each([
    [0, "deny"], // Sunday
    [6, "deny"], // Saturday
    [2, "require_approval"], // Tuesday
  ])("a new payee on UTC weekday %i is %s when weekends are blocked", (day, verdict) => {
    const p = custom({ newPayeeDenyDays: [0, 6] });
    const when = new Date(Date.UTC(2026, 10, 1 + day, 12)).toISOString();
    const d = evaluate(intent({ payee: f("user", "Fresh"), account: f("user", "acct_fresh"), amount: f("user", 100) }), p, state({ now: when }));
    expect(d.verdict).toBe(verdict);
    expect(d.rule).toBe("new_payee");
  });
  test("the weekday rule does not touch registered vendors", () => {
    const p = custom({ newPayeeDenyDays: [0, 1, 2, 3, 4, 5, 6] });
    expect(evaluate(intent(), p, state()).verdict).toBe("allow");
  });
});

describe("allowlist and velocity", () => {
  test("registered vendor in a disallowed category is denied", () => {
    const d = run(
      { payee: f("vendor", casino.name), account: f("vendor", casino.account), category: f("vendor", "office_supplies") },
      { purchaseOrder: po(4500, "lucky") },
    );
    expect(d).toMatchObject({ verdict: "deny", rule: "allowlist" });
  });
  test("an agent-claimed category cannot launder a disallowed registered vendor", () => {
    expect(run({ payee: f("vendor", casino.name), account: f("vendor", casino.account), category: f("literal", "software") }).rule).toBe("allowlist");
  });
  test("unknown payee falls back to the stated category", () => {
    const d = run({ payee: f("user", "New Vendor"), account: f("user", "a"), category: f("user", "weapons") });
    expect(d.findings.map((x) => x.rule)).toContain("allowlist");
  });
  test("velocity: the sixth payment in an hour is denied", () => {
    expect(run({}, { paymentsLastHour: 4 }).verdict).toBe("allow");
    expect(run({}, { paymentsLastHour: 5 })).toMatchObject({ verdict: "deny", rule: "velocity" });
  });
});

describe("decision record", () => {
  test("deny beats require_approval and every finding is recorded", () => {
    const d = run({ payee: f("user", "New Vendor"), account: f("user", "a"), amount: f("user", 100001) });
    expect(d.verdict).toBe("deny");
    expect(d.rule).toBe("hard_limit");
    expect(d.findings.map((x) => x.rule)).toEqual(expect.arrayContaining(["new_payee", "approval_threshold", "hard_limit"]));
  });
  test("is deterministic and carries policy identity and field provenance", () => {
    const a = run({ amount: f("invoice", 45000) });
    const b = run({ amount: f("invoice", 45000) });
    expect(a).toEqual(b);
    expect(a.policy).toEqual({ name: "default", version: 1, hash: policy.hash });
    expect(a.fields.amount.trust).toBe(3);
    expect(a.fields.amount.origins[0]?.kind).toBe("invoice");
    expect(a.evaluatedAt).toBe("2026-10-26T12:00:00.000Z");
  });
});

describe("policy loading", () => {
  const base = readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8");
  test("hash ignores comments, whitespace and key order", () => {
    const reordered = loadPolicy(
      "velocity: {maxPerHour: 5}\nallowedCategories: [office_supplies, software, contractors]\nlimits: {totalPerDay: 300000, perVendorPerDay: 150000, perPayment: 100000}\namountToleranceBps: 500\napprovalThreshold: 50000\ncurrency: USD\nversion: 1\nname: default\n",
    );
    expect(reordered.hash).toBe(policy.hash);
  });
  test("a changed value changes the hash", () => {
    expect(loadPolicy(base.replace("approvalThreshold: 50000", "approvalThreshold: 60000")).hash).not.toBe(policy.hash);
  });
  test.each([
    ["unknown key (cannot loosen built-in rules)", base + "allowUntrustedPayee: true\n"],
    ["missing section", base.replace(/velocity:\n  maxPerHour: 5\n/, "")],
    ["negative limit", base.replace("perPayment: 100000", "perPayment: -1")],
    ["fractional amount", base.replace("approvalThreshold: 50000", "approvalThreshold: 500.5")],
  ])("rejects %s", (_n, text) => {
    expect(() => loadPolicy(text)).toThrow(/invalid policy/);
  });
});
