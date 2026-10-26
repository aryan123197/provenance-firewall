import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { evaluate, isTrusted, loadPolicy, tag, ORIGIN_KINDS, type OriginKind, type PolicyState, type PurchaseOrder, type ResolvedIntent, type VendorRecord } from "./index";

const policy = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));
const vendors: VendorRecord[] = [
  { id: "acme", name: "Acme Supplies", account: "acme@x.example", category: "office_supplies" },
  { id: "beta", name: "Beta Software", account: "beta@x.example", category: "software" },
  { id: "lucky", name: "Lucky Co", account: "lucky@x.example", category: "gambling" },
];

const RANK = { allow: 0, require_approval: 1, deny: 2 } as const;

// Values biased toward the interesting ones: registry entries, near-misses and attacker strings.
const names = fc.oneof(
  fc.constantFrom(...vendors.map((v) => v.name), "acme supplies", " Acme Supplies ", "Acme Suplies", "Evil Corp", ""),
  fc.string({ maxLength: 12 }),
);
const accounts = fc.oneof(fc.constantFrom(...vendors.map((v) => v.account), "evil@x.example", "ACME@X.EXAMPLE"), fc.string({ minLength: 1, maxLength: 12 }));
const amounts = fc.oneof(fc.constantFrom(0, 1, 4500, 49_999, 50_000, 50_001, 99_999, 100_000, 100_001, 10_000_000), fc.integer({ min: 0, max: 300_000 }));
const kinds = fc.constantFrom<OriginKind>(...ORIGIN_KINDS);
const currencies = fc.constantFrom("USD", "USD", "USD", "EUR");
const categories = fc.constantFrom("office_supplies", "software", "gambling", "weapons");

const field = <T>(value: T, kind: OriginKind) => tag(value, { kind, ref: `${kind}:p` });

const intents = fc
  .record({
    payee: fc.tuple(names, kinds),
    account: fc.tuple(accounts, kinds),
    amount: fc.tuple(amounts, kinds),
    currency: currencies,
    category: categories,
    categoryKind: kinds,
  })
  .map(
    (r): ResolvedIntent => ({
      agentId: "a",
      idempotencyKey: "k",
      payee: field(r.payee[0], r.payee[1]),
      account: field(r.account[0], r.account[1]),
      amount: field(r.amount[0], r.amount[1]),
      currency: field(r.currency, "user"),
      category: field(r.category, r.categoryKind),
    }),
  );

const states = fc
  .record({
    po: fc.option(fc.record({ amount: amounts, vendor: fc.constantFrom("acme", "beta", "lucky"), currency: currencies }), { nil: null }),
    vendorSpent: fc.integer({ min: 0, max: 200_000 }),
    totalSpent: fc.integer({ min: 0, max: 400_000 }),
    recent: fc.integer({ min: 0, max: 8 }),
  })
  .map(
    (r): PolicyState => ({
      now: "2026-11-03T15:00:00.000Z",
      vendors,
      purchaseOrder: r.po ? ({ id: "po", vendorId: r.po.vendor, amount: r.po.amount, currency: r.po.currency } satisfies PurchaseOrder) : null,
      vendorSpentToday: { acme: r.vendorSpent, beta: r.vendorSpent, lucky: r.vendorSpent },
      totalSpentToday: r.totalSpent,
      paymentsLastHour: r.recent,
    }),
  );

const runs = { numRuns: 20_000 };

describe("engine safety properties (independent of the rule code)", { timeout: 60_000 }, () => {
  test("allow implies an exact registry match for payee and account", () => {
    fc.assert(
      fc.property(intents, states, (i, s) => {
        const d = evaluate(i, policy, s);
        if (d.verdict !== "allow") return;
        expect(vendors.some((v) => v.name === i.payee.value && v.account === i.account.value)).toBe(true);
      }),
      runs,
    );
  });

  test("a registered name with a different account is never allowed and never merely held", () => {
    fc.assert(
      fc.property(intents, states, (i, s) => {
        const exact = vendors.some((v) => v.name === i.payee.value && v.account === i.account.value);
        const sameName = vendors.some((v) => v.name.normalize("NFKC").trim().toLowerCase() === i.payee.value.normalize("NFKC").trim().toLowerCase());
        if (exact || !sameName) return;
        const d = evaluate(i, policy, s);
        expect(d.verdict).toBe("deny");
        expect(d.alert).toBe(true);
      }),
      runs,
    );
  });

  test("an untrusted amount is only allowed when a same-currency purchase order for that vendor is within tolerance", () => {
    fc.assert(
      fc.property(intents, states, (i, s) => {
        const d = evaluate(i, policy, s);
        if (d.verdict !== "allow" || isTrusted(i.amount.trust)) return;
        const v = vendors.find((x) => x.name === i.payee.value && x.account === i.account.value)!;
        const po = s.purchaseOrder;
        expect(po).not.toBeNull();
        expect(po!.vendorId).toBe(v.id);
        expect(po!.currency).toBe(i.currency.value);
        expect(Math.abs(i.amount.value - po!.amount) * 10_000).toBeLessThanOrEqual(po!.amount * policy.amountToleranceBps);
      }),
      runs,
    );
  });

  test("allow respects every numeric limit, the allowlist and the currency", () => {
    fc.assert(
      fc.property(intents, states, (i, s) => {
        const d = evaluate(i, policy, s);
        if (d.verdict !== "allow") return;
        const v = vendors.find((x) => x.name === i.payee.value && x.account === i.account.value)!;
        expect(i.currency.value).toBe(policy.currency);
        expect(i.amount.value).toBeLessThanOrEqual(policy.approvalThreshold);
        expect(i.amount.value).toBeLessThanOrEqual(policy.limits.perPayment);
        expect((s.vendorSpentToday[v.id] ?? 0) + i.amount.value).toBeLessThanOrEqual(policy.limits.perVendorPerDay);
        expect(s.totalSpentToday + i.amount.value).toBeLessThanOrEqual(policy.limits.totalPerDay);
        expect(policy.allowedCategories).toContain(v.category);
        expect(s.paymentsLastHour + 1).toBeLessThanOrEqual(policy.velocity.maxPerHour);
      }),
      runs,
    );
  });

  test("nothing over a hard limit is ever merely held for approval", () => {
    fc.assert(
      fc.property(intents, states, (i, s) => {
        const d = evaluate(i, policy, s);
        if (i.amount.value > policy.limits.perPayment || i.currency.value !== policy.currency || s.totalSpentToday + i.amount.value > policy.limits.totalPerDay) {
          expect(d.verdict).toBe("deny");
        }
      }),
      runs,
    );
  });

  test("lowering the trust of any field never improves the verdict", () => {
    const degrade = (i: ResolvedIntent, which: "payee" | "account" | "amount" | "category"): ResolvedIntent => ({
      ...i,
      [which]: field(i[which].value, "email"),
    });
    fc.assert(
      fc.property(intents, states, fc.constantFrom("payee", "account", "amount", "category" as const), (i, s, which) => {
        const before = evaluate(i, policy, s).verdict;
        const after = evaluate(degrade(i, which as "payee"), policy, s).verdict;
        expect(RANK[after]).toBeGreaterThanOrEqual(RANK[before]);
      }),
      runs,
    );
  });

  test("the verdict depends only on values and trust, not on which source produced them", () => {
    const relabel = (i: ResolvedIntent): ResolvedIntent => ({
      ...i,
      payee: field(i.payee.value, i.payee.trust === 3 ? "web" : i.payee.trust === 0 ? "user" : "vendor"),
      account: field(i.account.value, i.account.trust === 3 ? "tool" : i.account.trust === 0 ? "user" : "vendor"),
    });
    fc.assert(
      fc.property(intents, states, (i, s) => {
        const a = evaluate(i, policy, s);
        const b = evaluate(relabel(i), policy, s);
        if (i.payee.trust === 2 || i.account.trust === 2) return; // T2 only arises from derive(); skip relabelling it
        expect(b.verdict).toBe(a.verdict);
        expect(b.rule).toBe(a.rule);
      }),
      runs,
    );
  });

  test("evaluation is deterministic", () => {
    fc.assert(
      fc.property(intents, states, (i, s) => {
        expect(evaluate(i, policy, s)).toEqual(evaluate(i, policy, s));
      }),
      { numRuns: 2_000 },
    );
  });
});
