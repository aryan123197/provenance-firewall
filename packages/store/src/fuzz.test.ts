import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { loadPolicy, tag, type OriginKind, type ResolvedIntent } from "@pfw/core";
import { RegistryError, Store } from "./index";

/** Operator input and provider events arrive as arbitrary values. The store must accept them or refuse with a typed error, and the audit log must stay verifiable. */

const policy = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));
const weird = fc.oneof(
  fc.string(),
  fc.string({ unit: "binary" }),
  fc.constantFrom("", " ", "\u0000", "\n", "a".repeat(5000), "acme", "acme@sandbox.example", "ABCDEFGHIJKLM", "Acme Supplies", "USD", "'; DROP TABLE vendors;--"),
);
const num = fc.oneof(fc.integer(), fc.double(), fc.constantFrom(0, -1, 0.5, 1e308, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, Infinity, -Infinity, NaN));

const f = <T>(kind: OriginKind, value: T) => tag(value, { kind, ref: `${kind}:fuzz` });
const intent = (key: string): ResolvedIntent => ({
  agentId: "a",
  idempotencyKey: key,
  payee: f("vendor", "Acme Supplies"),
  account: f("vendor", "acme@sandbox.example"),
  amount: f("user", 4500),
  currency: f("user", "USD"),
  category: f("vendor", "office_supplies"),
});

const typedOrOk = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e instanceof RegistryError, `untyped error: ${String(e)}`).toBe(true);
  }
};

describe("store against arbitrary input", () => {
  test("registry changes are accepted or refused with a RegistryError, and every accepted one is audited", () => {
    const store = new Store();
    store.changeVendor({ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" }, "seed");
    fc.assert(
      fc.property(weird, weird, weird, weird, weird, (id, name, account, category, who) => {
        typedOrOk(() => store.changeVendor({ id, name, account, category }, who));
      }),
      { numRuns: 1500 },
    );
    fc.assert(
      fc.property(weird, weird, num, weird, weird, (id, vendorId, amount, currency, who) => {
        typedOrOk(() => store.changePurchaseOrder({ id, vendorId: Math.random() < 0.5 ? "acme" : vendorId, amount, currency }, who));
      }),
      { numRuns: 1500 },
    );
    expect(store.audit.verify()).toMatchObject({ ok: true });
    for (const po of store.listPurchaseOrders()) {
      expect(Number.isSafeInteger(po.amount) && po.amount >= 0).toBe(true);
      expect(po.currency).toMatch(/^[A-Z]{3}$/);
    }
    for (const v of store.listVendors()) expect(v.name).toBe(v.name.trim());
    store.close();
  });

  test("provider events of any shape are recorded without throwing, and never mark something paid that was not", () => {
    const store = new Store();
    store.upsertVendor({ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" });
    const decided = store.decide(intent("k1"), policy);
    expect(decided.decision.verdict).toBe("allow");
    fc.assert(
      fc.property(
        fc.record({ id: weird, type: weird, status: fc.constantFrom("success", "failed", "pending", "unclaimed", "returned", "unknown", "weird"), reference: fc.option(weird, { nil: undefined }), senderRef: fc.option(weird, { nil: undefined }), amount: fc.option(num, { nil: undefined }), currency: fc.option(weird, { nil: undefined }), receiver: fc.option(weird, { nil: undefined }) }),
        (ev) => {
          store.recordProviderEvent(ev as never);
        },
      ),
      { numRuns: 1500 },
    );
    expect(store.audit.verify()).toMatchObject({ ok: true });
    // The decision was never executed, so no event referencing nothing we sent may have attached a provider status to it.
    expect(store.getExecution("k1")).toBeNull();
    store.close();
  });
});
