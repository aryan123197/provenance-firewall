import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { ZodError } from "zod";
import { PolicyPatchSchema, applyPatch, diffPolicy, lintPolicy, loadPolicy, runIntentExamples, runPolicyTests, PolicySchema, type PolicyDoc } from "./index";

const active: PolicyDoc = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));

const minor = fc.oneof(fc.nat({ max: 10_000_000 }), fc.constantFrom(0, 1, 49_999, 50_000, 50_001, Number.MAX_SAFE_INTEGER), fc.integer(), fc.double());
const category = fc.oneof(fc.constantFrom("office_supplies", "software", "contractors", "gambling", "__proto__", "constructor", " "), fc.string());
const patch = fc.record(
  {
    approvalThreshold: minor,
    amountToleranceBps: fc.oneof(fc.integer({ min: -5, max: 10_005 }), fc.double()),
    limits: fc.record({ perPayment: minor, perVendorPerDay: minor, totalPerDay: minor }, { requiredKeys: [] }),
    allowedCategories: fc.array(category, { maxLength: 6 }),
    velocity: fc.record({ maxPerHour: fc.oneof(fc.integer({ min: -2, max: 100 }), fc.double()) }, { requiredKeys: [] }),
    categoryApprovalThresholds: fc.dictionary(category, fc.oneof(minor, fc.constant(null)), { maxKeys: 4 }),
    newPayeeDenyDays: fc.array(fc.integer({ min: -2, max: 9 }), { maxLength: 8 }),
  },
  { requiredKeys: [] },
);

describe("policy patches", () => {
  test.each([
    ["a $50 daily total cap", { limits: { totalPerDay: 5000 } }],
    ["a $50 per-vendor daily cap", { limits: { perVendorPerDay: 5000 } }],
    ["a one-cent daily total cap", { limits: { totalPerDay: 1 } }],
    ["a zero daily total cap (nothing may be paid)", { limits: { totalPerDay: 0 } }],
    ["a zero per-vendor daily cap", { limits: { perVendorPerDay: 0 } }],
  ])("%s still passes every generated test, so it can be activated", (_name, p) => {
    const failed = runPolicyTests(applyPatch(active, p as never)).filter((t) => !t.passed);
    expect(failed).toEqual([]);
  });

  test("a patch is either rejected with a validation error or yields a valid policy that passes its own generated tests", () => {
    fc.assert(
      fc.property(patch, (p) => {
        let next: PolicyDoc;
        try {
          next = applyPatch(active, p as never);
        } catch (e) {
          expect(e instanceof ZodError, `untyped error: ${String(e)}`).toBe(true);
          return;
        }
        expect(PolicySchema.safeParse(next).success).toBe(true);
        expect(next.version).toBe(active.version + 1);
        expect(Array.isArray(lintPolicy(next))).toBe(true);
        expect(Array.isArray(diffPolicy(active, next))).toBe(true);
        const failed = runPolicyTests(next).filter((t) => !t.passed);
        expect(failed, `generated tests fail for ${JSON.stringify(p)}`).toEqual([]);
      }),
      { numRuns: 1500 },
    );
  });

  test("the patch schema never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(() => PolicyPatchSchema.safeParse(v)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});

describe("intent examples", () => {
  const example = fc.record(
    {
      description: fc.string(),
      amount: fc.oneof(fc.double({ min: 0, max: 1e12 }), fc.constantFrom(0, 0.001, 499.995, 1e15, 1e300)),
      category,
      newPayee: fc.boolean(),
      weekday: fc.integer({ min: 0, max: 6 }),
      expect: fc.constantFrom("allow", "require_approval", "deny"),
    },
    { requiredKeys: ["description", "amount", "category", "expect"] },
  );
  test("any example yields a result and never throws", () => {
    fc.assert(
      fc.property(fc.array(example, { maxLength: 4 }), (examples) => {
        const results = runIntentExamples(active, examples as never);
        expect(results).toHaveLength(examples.length);
        for (const r of results) expect(typeof r.passed).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
  });
});
