import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { PolicySchema, hashPolicy, applyPatch, diffPolicy, lintPolicy, loadPolicy, runIntentExamples, runPolicyTests, type PolicyDoc } from "./index";

const base: PolicyDoc = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));

describe("applyPatch", () => {
  test("changes only what the patch names, bumps the version and keeps the name", () => {
    const next = applyPatch(base, { approvalThreshold: 20_000 });
    expect(next).toMatchObject({ version: base.version + 1, name: base.name, approvalThreshold: 20_000, limits: base.limits });
  });
  test("merges nested limits and category overrides, and null removes an override", () => {
    const a = applyPatch(base, { limits: { perPayment: 90_000 }, categoryApprovalThresholds: { contractors: 50_000 } });
    expect(a.limits).toEqual({ ...base.limits, perPayment: 90_000 });
    expect(a.categoryApprovalThresholds).toEqual({ contractors: 50_000 });
    const b = applyPatch(a, { categoryApprovalThresholds: { contractors: null } });
    expect(b.categoryApprovalThresholds).toEqual({});
  });
  test("deny days are de-duplicated and sorted", () => {
    expect(applyPatch(base, { newPayeeDenyDays: [6, 0, 6] }).newPayeeDenyDays).toEqual([0, 6]);
  });
  test("there is no way to express loosening a provenance rule", () => {
    for (const bad of [{ allowUntrustedPayee: true }, { provenance: { untrustedPayee: "allow" } }, { limits: { everything: 1 } }, { approvalThreshold: -5 }, { approvalThreshold: 1.5 }, { newPayeeDenyDays: [7] }]) {
      expect(() => applyPatch(base, bad as never)).toThrow();
    }
  });
  test("a result that is not a valid policy is rejected", () => {
    expect(() => applyPatch(base, { allowedCategories: [] })).toThrow();
    expect(PolicySchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("diffPolicy", () => {
  test("marks loosening and tightening", () => {
    const next = applyPatch(base, { approvalThreshold: base.approvalThreshold * 2, limits: { perPayment: base.limits.perPayment / 2 }, newPayeeDenyDays: [0, 6], allowedCategories: [...base.allowedCategories, "travel"] });
    const d = Object.fromEntries(diffPolicy(base, next).map((c) => [c.path, c.direction]));
    expect(d).toEqual({ approvalThreshold: "looser", "limits.perPayment": "tighter", newPayeeDenyDays: "tighter", allowedCategories: "looser" });
  });
  test("category overrides compare against the effective threshold", () => {
    const tighter = applyPatch(base, { categoryApprovalThresholds: { contractors: 10_000 } });
    expect(diffPolicy(base, tighter)[0]).toMatchObject({ path: "categoryApprovalThresholds.contractors", direction: "tighter", before: expect.stringContaining("default") });
    const looser = applyPatch(base, { categoryApprovalThresholds: { contractors: 90_000 } });
    expect(diffPolicy(base, looser)[0]?.direction).toBe("looser");
  });
  test("no change, no diff", () => {
    expect(diffPolicy(base, { ...base, version: 9 })).toEqual([]);
  });
});

describe("lintPolicy", () => {
  test("warns when approval is unreachable because of a lower cap", () => {
    const w = lintPolicy(applyPatch(base, { approvalThreshold: 200_000 }));
    expect(w.join(" ")).toMatch(/above the per-payment cap/);
  });
  test("the default policy is clean", () => expect(lintPolicy(base)).toEqual([]));
});

describe("generated policy tests", () => {
  test("the default policy passes all of them, and they cover every group", () => {
    const r = runPolicyTests(base);
    expect(r.filter((t) => !t.passed)).toEqual([]);
    expect(new Set(r.map((t) => t.group))).toEqual(new Set(["thresholds", "limits", "new payees", "allowlist", "provenance (built in)"]));
    expect(r.length).toBeGreaterThanOrEqual(15);
  });
  test("includes the $500.00 / $500.01 boundary", () => {
    const r = runPolicyTests(base).map((t) => t.description);
    expect(r.some((d) => d.includes("$500.00") && d.includes("not above"))).toBe(true);
    expect(r.some((d) => d.includes("$500.01"))).toBe(true);
  });
  test("a policy edited the way the spec describes still passes, and gains the new cases", () => {
    const next = applyPatch(base, { categoryApprovalThresholds: { contractors: 50_000 }, newPayeeDenyDays: [0, 6], approvalThreshold: 100_000 });
    const r = runPolicyTests(next);
    expect(r.filter((t) => !t.passed)).toEqual([]);
    expect(r.some((t) => t.id === "new-payee-sunday" && t.expected.startsWith("deny"))).toBe(true);
    expect(r.some((t) => t.id === "new-payee-tuesday" && t.expected.startsWith("require approval"))).toBe(true);
    expect(r.some((t) => t.id.startsWith("threshold-over:contractors"))).toBe(true);
  });
  test.each([
    ["tiny limits", { limits: { perPayment: 100, perVendorPerDay: 100, totalPerDay: 100 }, approvalThreshold: 50 }],
    ["zero tolerance", { amountToleranceBps: 0 }],
    ["huge limits", { limits: { perPayment: 5_000_000, perVendorPerDay: 5_000_000, totalPerDay: 5_000_000 }, approvalThreshold: 1_000_000 }],
    ["velocity of one", { velocity: { maxPerHour: 1 } }],
    ["every day denied", { newPayeeDenyDays: [0, 1, 2, 3, 4, 5, 6] }],
  ])("generated tests stay consistent for %s", (_n, patch) => {
    expect(runPolicyTests(applyPatch(base, patch as never)).filter((t) => !t.passed)).toEqual([]);
  });
  test("the built-in provenance tests hold even for the loosest policy", () => {
    const loose = applyPatch(base, { approvalThreshold: 5_000_000, limits: { perPayment: 5_000_000, perVendorPerDay: 5_000_000, totalPerDay: 5_000_000 }, amountToleranceBps: 10_000 });
    const prov = runPolicyTests(loose).filter((t) => t.group === "provenance (built in)");
    expect(prov.length).toBe(3);
    expect(prov.every((t) => t.passed)).toBe(true);
  });
});

describe("author intent examples", () => {
  const spec = applyPatch(base, { categoryApprovalThresholds: { contractors: 50_000 }, newPayeeDenyDays: [0, 6] });
  test("examples that match the compiled policy pass", () => {
    const r = runIntentExamples(spec, [
      { description: "A contractor invoice of $500.00 is paid", amount: 500, category: "contractors", expect: "allow" },
      { description: "A contractor invoice of $500.01 needs approval", amount: 500.01, category: "contractors", expect: "require_approval" },
      { description: "A new vendor on Saturday is refused", amount: 100, category: "contractors", newPayee: true, weekday: 6, expect: "deny" },
      { description: "A new vendor on a Wednesday needs approval", amount: 100, category: "contractors", newPayee: true, weekday: 3, expect: "require_approval" },
    ]);
    expect(r.every((t) => t.passed)).toBe(true);
  });
  test("a unit slip (dollars compiled as cents) is caught as a mismatch with what the author meant", () => {
    const slipped = applyPatch(base, { categoryApprovalThresholds: { contractors: 500 } }); // $5.00 instead of $500.00
    const r = runIntentExamples(slipped, [{ description: "A contractor invoice of $500.00 is paid", amount: 500, category: "contractors", expect: "allow" }]);
    expect(r[0]).toMatchObject({ passed: false, expected: "allow", actual: "require approval" });
  });
});

describe("vendor monthly budgets in a patch", () => {
  const withBudget = applyPatch(base, { vendorMonthlyBudgets: { acme: 20_000 } });
  test("sets, merges and removes budgets, and a policy with none keeps the original hash", () => {
    expect(withBudget.vendorMonthlyBudgets).toEqual({ acme: 20_000 });
    expect(applyPatch(withBudget, { vendorMonthlyBudgets: { beta: 5_000 } }).vendorMonthlyBudgets).toEqual({ acme: 20_000, beta: 5_000 });
    const removed = applyPatch(withBudget, { vendorMonthlyBudgets: { acme: null } });
    expect(removed.vendorMonthlyBudgets).toBeUndefined();
    // Apart from the version bump, removing the last budget gives back exactly the policy that had none, so its hash is unchanged.
    expect(hashPolicy({ ...removed, version: base.version })).toBe((base as PolicyDoc & { hash: string }).hash);
  });
  test("negative or fractional budgets are rejected", () => {
    expect(() => applyPatch(base, { vendorMonthlyBudgets: { acme: -1 } })).toThrow();
    expect(() => applyPatch(base, { vendorMonthlyBudgets: { acme: 10.5 } })).toThrow();
  });
  test("the diff calls a new budget stricter, a raise looser and a removal looser", () => {
    expect(diffPolicy(base, withBudget)).toEqual([{ path: "vendorMonthlyBudgets.acme", label: "Monthly budget, acme", before: "none", after: "$200.00", direction: "tighter" }]);
    expect(diffPolicy(withBudget, applyPatch(withBudget, { vendorMonthlyBudgets: { acme: 30_000 } }))[0]).toMatchObject({ before: "$200.00", after: "$300.00", direction: "looser" });
    expect(diffPolicy(withBudget, applyPatch(withBudget, { vendorMonthlyBudgets: { acme: null } }))[0]).toMatchObject({ after: "none", direction: "looser" });
  });
  test("lint warns about a $0 budget and is quiet about an ordinary one", () => {
    expect(lintPolicy(applyPatch(base, { vendorMonthlyBudgets: { acme: 0 } })).join(" ")).toContain("is $0");
    expect(lintPolicy(withBudget)).toEqual([]);
  });
  test("generated tests gain a budgets group and all of them pass, including at the edges", () => {
    for (const budget of [20_000, 2, 1, 150_000]) {
      const r = runPolicyTests(applyPatch(base, { vendorMonthlyBudgets: { acme: budget } }));
      expect(r.filter((t) => !t.passed)).toEqual([]);
      expect(r.some((t) => t.group === "budgets")).toBe(true);
    }
    const budgets = runPolicyTests(withBudget).filter((t) => t.group === "budgets");
    expect(budgets.map((t) => t.expected)).toEqual(["allow", "require approval (vendor_budget)"]);
  });
});
