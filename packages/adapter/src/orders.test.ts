import { describe, expect, test } from "vitest";
import { evaluate, loadPolicy, tag, type OriginKind, type PolicyState, type ResolvedIntent } from "@pfw/core";
import { AdapterError, Authority, PayPalOrdersAdapter, UnauthorizedPaymentError, mapOrderStatus, type AllowedIntent } from "./index";
import { createFakePayPal } from "./testing/fake-paypal";

const POLICY = loadPolicy(`
name: t
version: 1
currency: USD
approvalThreshold: 50000
amountToleranceBps: 500
limits: {perPayment: 100000, perVendorPerDay: 150000, totalPerDay: 300000}
allowedCategories: [office_supplies]
velocity: {maxPerHour: 5}
`);
const f = <T>(kind: OriginKind, value: T) => tag(value, { kind, ref: `${kind}:t` });
const intent = (o: Partial<ResolvedIntent> = {}): ResolvedIntent => ({
  agentId: "a1",
  idempotencyKey: "order-key-1",
  payee: f("vendor", "Acme Supplies"),
  account: f("vendor", "acme@sandbox.example"),
  amount: f("po", 4500),
  currency: f("user", "USD"),
  category: f("vendor", "office_supplies"),
  ...o,
});
const state = (): PolicyState => ({
  now: "2026-10-28T12:00:00.000Z",
  vendors: [{ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" }],
  purchaseOrder: null,
  vendorSpentToday: {},
  totalSpentToday: 0,
  paymentsLastHour: 0,
  categorySpentThisMonth: {},
  vendorHistory: {},
});
const authority = new Authority("test-authority-key-0123456789");
const allowed = (i = intent()): AllowedIntent => authority.mint(i, evaluate(i, POLICY, state()));
const setup = () => {
  const fake = createFakePayPal();
  const adapter = new PayPalOrdersAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
  return { fake, adapter };
};
const want = { amount: 4500, currency: "USD", receiver: "acme@sandbox.example" };

describe("PayPalOrdersAdapter", () => {
  test("the order body names the merchant, the amount and that the buyer approves it; nothing moves yet", () => {
    const { adapter } = setup();
    const p = adapter.propose(allowed());
    expect(p.request).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "45.00" }, payee: { email_address: "acme@sandbox.example" } }],
      payment_source: { paypal: { experience_context: { user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
    });
    expect(p.requestId).toMatch(/^pfw-[0-9a-f]{32}$/);
  });

  test("execute creates the order and reports it pending with the link the buyer must open", async () => {
    const { fake, adapter } = setup();
    const r = await adapter.execute(allowed());
    expect(r).toMatchObject({ provider: "paypal-orders", status: "pending", amount: 4500, receiver: "acme@sandbox.example" });
    expect(r.approvalUrl).toMatch(/checkoutnow\?token=/);
    expect(fake.orders.size).toBe(1);
    expect(await adapter.status(r.reference)).toBe("pending");
  });

  test("a retry with the same idempotency key resolves to the same order, not a second", async () => {
    const { fake, adapter } = setup();
    const a = await adapter.execute(allowed());
    const b = await adapter.execute(allowed());
    expect(b.reference).toBe(a.reference);
    expect(fake.orders.size).toBe(1);
  });

  test("a replayed request id that now carries a different amount is refused, because PayPal returns the original order", async () => {
    const { adapter } = setup();
    await adapter.execute(allowed());
    // The same idempotency key (so the same request id) with a different authorized amount: PayPal would hand back the $45.00 order.
    const other = allowed(intent({ amount: f("po", 9900) }));
    await expect(adapter.execute(other)).rejects.toThrow(/does not match what was authorized.*amount/);
  });

  test("an unauthorized intent is refused before anything is sent", async () => {
    const { fake, adapter } = setup();
    const denied = intent({ payee: f("invoice", "Acme Supplies"), account: f("invoice", "evil@sandbox.example") });
    expect(() => authority.mint(denied, evaluate(denied, POLICY, state()))).toThrow(UnauthorizedPaymentError);
    expect(fake.calls.filter((c) => c.path.startsWith("/v2/checkout/orders"))).toHaveLength(0);
  });

  test("capture is refused until the buyer has approved, and the order is not completed", async () => {
    const { fake, adapter } = setup();
    const r = await adapter.execute(allowed());
    await expect(adapter.capture(r.reference, want)).rejects.toThrow(/buyer has not approved/);
    expect(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/capture"))).toBe(false);
  });

  test("after the buyer approves, capture completes it, and capturing again does not charge twice", async () => {
    const { fake, adapter } = setup();
    const r = await adapter.execute(allowed());
    fake.approveOrder(r.reference);
    expect(await adapter.capture(r.reference, want)).toBe("success");
    expect(await adapter.capture(r.reference, want)).toBe("success");
    expect(fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/capture"))).toHaveLength(1);
    expect(await adapter.status(r.reference)).toBe("success");
  });

  test("capture refuses an approved order that is not the one the firewall authorized", async () => {
    const { fake, adapter } = setup();
    const r = await adapter.execute(allowed());
    fake.approveOrder(r.reference);
    for (const wrong of [{ ...want, amount: 4600 }, { ...want, receiver: "evil@sandbox.example" }, { ...want, currency: "EUR" }]) {
      await expect(adapter.capture(r.reference, wrong)).rejects.toBeInstanceOf(AdapterError);
    }
    expect(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/capture"))).toBe(false);
  });

  test("status mapping: only COMPLETED is success; waiting states are pending; voided is failed", () => {
    expect(["COMPLETED", "PAYER_ACTION_REQUIRED", "APPROVED", "CREATED", "VOIDED", "WHAT"].map(mapOrderStatus)).toEqual(["success", "pending", "pending", "pending", "failed", "unknown"]);
  });
});
