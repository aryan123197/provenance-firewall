import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { ProvenanceContext, loadPolicy } from "@pfw/core";
import { Authority, PayPalAdapter, type AllowedIntent, type PaymentAdapter } from "@pfw/adapter";
import { createFakePayPal } from "@pfw/adapter/testing";
import { Store } from "@pfw/store";
import { Firewall } from "./index";

const policy = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));
const authority = new Authority("test-authority-key-0123456789");

let store: Store;
let fake: ReturnType<typeof createFakePayPal>;
let fw: Firewall;
let ctx: ProvenanceContext;

const proposal = (o: Record<string, unknown> = {}) => ({
  agentId: "agent-1",
  idempotencyKey: "pay-1",
  payee: { handle: "vendor:acme#name" },
  account: { handle: "vendor:acme#account" },
  amount: { handle: "invoice:inv_204#total" },
  currency: { handle: "user:req#currency" },
  category: { handle: "vendor:acme#category" },
  ...o,
});

beforeEach(() => {
  store = new Store({ clock: () => new Date("2026-10-28T12:00:00.000Z") });
  store.upsertVendor({ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" });
  store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
  fake = createFakePayPal();
  const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
  fw = new Firewall({ store, adapter, authority, policy });

  ctx = new ProvenanceContext();
  ctx.register("vendor:acme#name", "Acme Supplies");
  ctx.register("vendor:acme#account", "acme@sandbox.example");
  ctx.register("vendor:acme#category", "office_supplies");
  ctx.register("user:req#currency", "USD");
  ctx.register("invoice:inv_204#total", 4500);
});

describe("legitimate payment", () => {
  test("is allowed and reaches PayPal exactly once", async () => {
    const o = await fw.submit(proposal(), ctx);
    expect(o).toMatchObject({ status: "executed", replayed: false, receipt: { provider: "paypal", amount: 4500 } });
    expect(fake.payoutPosts()).toHaveLength(1);
  });
  test("a retry returns the stored receipt without another PayPal call", async () => {
    const first = await fw.submit(proposal(), ctx);
    const again = await fw.submit(proposal(), ctx);
    expect(again).toMatchObject({ status: "executed", replayed: true });
    expect(again.status === "executed" && first.status === "executed" && again.receipt).toEqual(first.status === "executed" && first.receipt);
    expect(fake.payoutPosts()).toHaveLength(1);
  });
  test("concurrent submissions with one key make one PayPal request", async () => {
    await Promise.all([fw.submit(proposal(), ctx), fw.submit(proposal(), ctx), fw.submit(proposal(), ctx)]);
    expect(fake.payoutPosts()).toHaveLength(1);
  });
});

describe("attacks never reach PayPal", () => {
  test("injected invoice payee: denied, zero PayPal traffic", async () => {
    ctx.register("invoice:inv_204#payee", "vendor-support@evil.example");
    const o = await fw.submit(proposal({ payee: { handle: "invoice:inv_204#payee" }, account: { handle: "invoice:inv_204#payee" } }), ctx);
    expect(o).toMatchObject({ status: "denied", decision: { rule: "untrusted_payee" } });
    expect(fake.calls).toHaveLength(0);
  });
  test("payee swap: denied with an alert", async () => {
    ctx.register("invoice:inv_204#account", "attacker@evil.example");
    const o = await fw.submit(proposal({ account: { handle: "invoice:inv_204#account" } }), ctx);
    expect(o).toMatchObject({ status: "denied", decision: { rule: "payee_change", alert: true } });
    expect(fake.calls).toHaveLength(0);
  });
  test("raw literals typed by the model are untrusted", async () => {
    const o = await fw.submit(proposal({ account: { literal: "attacker@evil.example" } }), ctx);
    expect(o.status).toBe("denied");
    expect(fake.calls).toHaveLength(0);
  });
  test("amount inflation needs approval and sends nothing", async () => {
    ctx.register("invoice:inv_204#total", 45000);
    const o = await fw.submit(proposal(), ctx);
    expect(o).toMatchObject({ status: "needs_approval", decision: { rule: "amount_mismatch" } });
    expect(fake.calls).toHaveLength(0);
  });
  test("a denied key stays denied on retry", async () => {
    const bad = proposal({ account: { literal: "attacker@evil.example" } });
    await fw.submit(bad, ctx);
    expect(await fw.submit(bad, ctx)).toMatchObject({ status: "denied", replayed: true });
  });
  test("invalid proposals and unknown handles are rejected", async () => {
    expect(await fw.submit({ nonsense: true }, ctx)).toMatchObject({ status: "invalid" });
    expect(await fw.submit(proposal({ payee: { handle: "vendor:ghost#name" } }), ctx)).toMatchObject({ status: "invalid" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("forced retries and failures", () => {
  test("a timeout is recorded as retryable, and the retry completes with one payout", async () => {
    fake.failNext("timeout");
    const first = await fw.submit(proposal(), ctx);
    expect(first).toMatchObject({ status: "execution_failed", error: { retryable: true } });
    const second = await fw.submit(proposal(), ctx);
    expect(second.status).toBe("executed");
    const ids = new Set(fake.payoutPosts().map((p) => p.headers["PayPal-Request-Id"]));
    expect(ids.size).toBe(1);
    expect(await fw.submit(proposal(), ctx)).toMatchObject({ status: "executed", replayed: true });
  });
  test("a non-retryable failure is not retried", async () => {
    fake.failNext(400);
    expect(await fw.submit(proposal(), ctx)).toMatchObject({ status: "execution_failed", error: { retryable: false } });
    const before = fake.calls.length;
    expect(await fw.submit(proposal(), ctx)).toMatchObject({ status: "execution_failed", replayed: true });
    expect(fake.calls.length).toBe(before);
  });
});

describe("no bypass", () => {
  test("a different adapter instance with a different authority rejects the firewall's authorization", async () => {
    const stranger = new PayPalAdapter({
      clientId: "test-id",
      clientSecret: "test-secret",
      authority: new Authority("some-other-authority-key-99999"),
      baseUrl: "http://localhost:9999",
      fetch: fake.fetch,
    });
    let captured: AllowedIntent | undefined;
    const spy: PaymentAdapter = {
      propose: (a) => stranger.propose(a),
      status: (r) => stranger.status(r),
      execute: async (a) => {
        captured = a;
        return stranger.execute(a);
      },
    };
    const tapped = new Firewall({ store, adapter: spy, authority, policy });
    await expect(tapped.submit(proposal(), ctx)).rejects.toThrow(/authorization/);
    expect(captured).toBeDefined();
    expect(fake.calls).toHaveLength(0);
  });
});
