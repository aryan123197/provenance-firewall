import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { ProvenanceContext, loadPolicy } from "@pfw/core";
import { Authority, PayPalAdapter, type AllowedIntent, type PaymentAdapter } from "@pfw/adapter";
import { createFakePayPal, fakeWebhookHeaders } from "@pfw/adapter/testing";
import { Store } from "@pfw/store";
import { Firewall, type Outcome } from "./index";

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
  const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch, webhookId: "WH-TEST" });
  fw = new Firewall({ store, adapter, authority, policy, webhooks: adapter });

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

describe("approval flow", () => {
  const inflated = () => {
    ctx.register("invoice:inv_204#total", 45000); // 10x the purchase order
    return proposal({ idempotencyKey: "inflated" });
  };
  const pending = async (): Promise<Extract<Outcome, { status: "needs_approval" }>> => {
    const o = await fw.submit(inflated(), ctx);
    if (o.status !== "needs_approval") throw new Error(`expected needs_approval, got ${o.status}`);
    return o;
  };

  test("a request waits for a person and sends nothing to PayPal", async () => {
    const o = await pending();
    expect(o.approvalId).toMatch(/^apr_/);
    expect(store.listApprovals("pending")).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
    expect(await fw.submit(inflated(), ctx)).toMatchObject({ status: "needs_approval", approvalId: o.approvalId, replayed: true });
    expect(store.listApprovals()).toHaveLength(1);
  });
  test("approving executes exactly once, for the approved amount", async () => {
    const o = await pending();
    const res = await fw.resolveApproval(o.approvalId, { approver: "dana@company.example", approve: true, note: "confirmed with vendor" });
    expect(res).toMatchObject({ status: "executed", receipt: { amount: 45000 } });
    expect(fake.payoutPosts()).toHaveLength(1);
    expect(await fw.submit(inflated(), ctx)).toMatchObject({ status: "executed", replayed: true });
    expect(fake.payoutPosts()).toHaveLength(1);
    expect(store.getApproval(o.approvalId)).toMatchObject({ status: "approved", resolvedBy: "dana@company.example" });
  });
  test("an approval cannot be used twice", async () => {
    const o = await pending();
    await fw.resolveApproval(o.approvalId, { approver: "dana", approve: true });
    expect(() => store.resolveApproval(o.approvalId, { approver: "dana", approve: true }, policy)).toThrow(/already approved/);
    await expect(fw.resolveApproval(o.approvalId, { approver: "eve", approve: true })).rejects.toThrow(/already approved/);
    expect(fake.payoutPosts()).toHaveLength(1);
  });
  test("rejecting never executes, and the key stays rejected", async () => {
    const o = await pending();
    expect(await fw.resolveApproval(o.approvalId, { approver: "dana", approve: false, note: "not ours" })).toMatchObject({ status: "rejected" });
    expect(await fw.submit(inflated(), ctx)).toMatchObject({ status: "rejected", replayed: true });
    expect(fake.calls).toHaveLength(0);
  });
  test("the agent cannot approve its own request", async () => {
    const o = await pending();
    await expect(fw.resolveApproval(o.approvalId, { approver: "agent-1", approve: true })).rejects.toThrow(/own payment/);
    await expect(fw.resolveApproval(o.approvalId, { approver: "  ", approve: true })).rejects.toThrow(/approver is required/);
    expect(fake.calls).toHaveLength(0);
  });
  test("a denied payment has no approval to grant", async () => {
    await fw.submit(proposal({ account: { literal: "attacker@evil.example" } }), ctx);
    expect(store.listApprovals()).toHaveLength(0);
    await expect(fw.resolveApproval("apr_nope", { approver: "dana", approve: true })).rejects.toThrow(/unknown approval/);
  });
  test("approval cannot override a deny that appears before the person acts", async () => {
    const o = await pending();
    // Meanwhile the vendor's daily cap gets used up by other payments.
    store.db
      .prepare("INSERT INTO decisions (idempotency_key, agent_id, request_hash, verdict, decision_json, created_at) VALUES ('x','a','h','allow','{}','2026-10-28T11:00:00.000Z')")
      .run();
    store.db.prepare("INSERT INTO payments (idempotency_key, agent_id, vendor_id, amount, currency, created_at) VALUES ('x','a','acme',140000,'USD','2026-10-28T11:00:00.000Z')").run();
    const res = await fw.resolveApproval(o.approvalId, { approver: "dana", approve: true });
    expect(res).toMatchObject({ status: "blocked" });
    expect(store.getApproval(o.approvalId)?.status).toBe("pending");
    expect(fake.calls).toHaveLength(0);
  });
  test("a new payee confirmed by the user is paid once approved", async () => {
    ctx.register("user:req#payee", "Fresh Vendor");
    ctx.register("user:req#account", "fresh@sandbox.example");
    ctx.register("user:req#amount", 2000);
    const o = await fw.submit(
      proposal({ idempotencyKey: "new", payee: { handle: "user:req#payee" }, account: { handle: "user:req#account" }, amount: { handle: "user:req#amount" } }),
      ctx,
    );
    expect(o).toMatchObject({ status: "needs_approval", decision: { rule: "new_payee" } });
    if (o.status !== "needs_approval") return;
    expect(await fw.resolveApproval(o.approvalId, { approver: "dana", approve: true })).toMatchObject({ status: "executed" });
  });
  test("approved spend counts toward the daily caps and the audit log records each step", async () => {
    const o = await pending();
    await fw.resolveApproval(o.approvalId, { approver: "dana", approve: true });
    const types = store.audit.entries().map((e) => e.type);
    expect(types).toEqual(["decision", "approval_requested", "purchase_order_closed", "approval_granted", "execution"]);
    expect(store.audit.verify()).toMatchObject({ ok: true, count: 5 });
    const spent = store.db.prepare("SELECT SUM(amount) AS t FROM payments").get() as { t: number };
    expect(spent.t).toBe(45000);
  });
});

describe("webhook reconciliation", () => {
  const itemEvent = (o: { id?: string; batch: string; status?: string; senderItemId?: string; amount?: string; receiver?: string; type?: string }) =>
    JSON.stringify({
      id: o.id ?? "WH-EVT-1",
      event_type: o.type ?? "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
      resource: {
        payout_batch_id: o.batch,
        transaction_status: o.status ?? "SUCCESS",
        payout_item: { receiver: o.receiver ?? "acme@sandbox.example", sender_item_id: o.senderItemId ?? "unrelated", amount: { value: o.amount ?? "45.00", currency: "USD" } },
      },
    });
  const pay = async () => {
    const o = await fw.submit(proposal(), ctx);
    if (o.status !== "executed") throw new Error("expected executed");
    return o.receipt;
  };
  const hook = (body: string, sig = "valid-sig") => fw.handleWebhook(fakeWebhookHeaders(sig), body);

  test("a verified event for our payment updates its provider status", async () => {
    const r = await pay();
    expect(await hook(itemEvent({ batch: r.reference }))).toMatchObject({ status: "processed", result: "matched", providerStatus: "success" });
    expect(store.getExecution("pay-1")?.providerStatus).toBe("success");
    expect(store.listDrift()).toHaveLength(0);
  });
  test("an event is matched by our own id when the batch id is unfamiliar", async () => {
    const r = await pay();
    expect(await hook(itemEvent({ batch: "SOMETHINGELSE", senderItemId: r.requestId }))).toMatchObject({ result: "matched" });
  });
  test("a payment PayPal reports that we never authorized is flagged as drift", async () => {
    await pay();
    const res = await hook(itemEvent({ id: "WH-EVT-2", batch: "ATTACKERBATCH" }));
    expect(res).toMatchObject({ status: "processed", result: "drift", kind: "unmatched_payment", reference: "ATTACKERBATCH" });
    expect(store.listDrift("open")).toHaveLength(1);
    expect(store.audit.entries().some((e) => e.type === "drift")).toBe(true);
  });
  test("a different amount or receiver than authorized is drift, even for our batch", async () => {
    const r = await pay();
    expect(await hook(itemEvent({ batch: r.reference, amount: "450.00", receiver: "attacker@evil.example" }))).toMatchObject({ result: "drift", kind: "detail_mismatch" });
    const d = store.listDrift("open")[0]!;
    expect((d.detail as { mismatches: string[] }).mismatches).toHaveLength(2);
  });
  test("a retried delivery is processed once", async () => {
    const r = await pay();
    await hook(itemEvent({ batch: r.reference }));
    expect(await hook(itemEvent({ batch: r.reference }))).toEqual({ status: "processed", result: "duplicate" });
    expect(store.audit.entries().filter((e) => e.type === "webhook")).toHaveLength(1);
  });
  test("a forged or unsigned webhook is refused and changes nothing", async () => {
    const r = await pay();
    const before = store.audit.entries().length;
    expect(await hook(itemEvent({ batch: r.reference }), "forged")).toEqual({ status: "rejected", reason: "invalid signature" });
    expect(await fw.handleWebhook({}, itemEvent({ batch: r.reference }))).toMatchObject({ status: "rejected" });
    expect(store.audit.entries()).toHaveLength(before);
    expect(store.getExecution("pay-1")?.providerStatus).toBeNull();
  });
  test("without a verifier every webhook is refused", async () => {
    const bare = new Firewall({ store, adapter: new PayPalAdapter({ clientId: "a", clientSecret: "b", authority, baseUrl: "http://localhost:1" }), authority, policy });
    expect(await bare.handleWebhook(fakeWebhookHeaders(), "{}")).toMatchObject({ status: "rejected" });
  });
  test("a verifier that throws, or a verified body that is not JSON, is rejected without touching any record", async () => {
    const before = store.audit.entries().length;
    const throwing = new Firewall({ store, adapter: new PayPalAdapter({ clientId: "a", clientSecret: "b", authority, baseUrl: "http://localhost:1" }), authority, policy, webhooks: { verify: async () => { throw new Error("PayPal unreachable"); } } });
    expect(await throwing.handleWebhook(fakeWebhookHeaders(), "{}")).toEqual({ status: "rejected", reason: "signature could not be verified" });
    const accepting = new Firewall({ store, adapter: new PayPalAdapter({ clientId: "a", clientSecret: "b", authority, baseUrl: "http://localhost:1" }), authority, policy, webhooks: { verify: async () => true } });
    expect(await accepting.handleWebhook(fakeWebhookHeaders(), "not json")).toEqual({ status: "rejected", reason: "body is not JSON" });
    expect(store.audit.entries()).toHaveLength(before);
  });
  test("header names are matched case-insensitively", async () => {
    const r = await pay();
    const upper = Object.fromEntries(Object.entries(fakeWebhookHeaders()).map(([k, v]) => [k.toUpperCase(), v]));
    expect(await fw.handleWebhook(upper, itemEvent({ batch: r.reference }))).toMatchObject({ status: "processed", result: "matched" });
  });
  test("a different currency than authorized is drift", async () => {
    const r = await pay();
    const body = JSON.stringify({ id: "WH-CUR", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: r.reference, transaction_status: "SUCCESS", payout_item: { receiver: "acme@sandbox.example", amount: { value: "45.00", currency: "EUR" } } } });
    expect(await hook(body)).toMatchObject({ result: "drift", kind: "detail_mismatch" });
    expect((store.listDrift("open")[0]!.detail as { mismatches: string[] }).mismatches[0]).toMatch(/currency EUR/);
  });
  test("a returned payment outranks success, and a later success does not undo it", async () => {
    const r = await pay();
    await hook(itemEvent({ id: "s", batch: r.reference, status: "SUCCESS" }));
    await hook(itemEvent({ id: "r", batch: r.reference, status: "RETURNED", type: "PAYMENT.PAYOUTS-ITEM.RETURNED" }));
    await hook(itemEvent({ id: "s2", batch: r.reference, status: "SUCCESS" }));
    expect(store.getExecution("pay-1")?.providerStatus).toBe("returned");
  });
  test("unrelated event types are ignored", async () => {
    expect(await hook(JSON.stringify({ id: "WH-X", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} }))).toEqual({ status: "ignored" });
  });
  test("a late pending event never undoes a final status", async () => {
    const r = await pay();
    await hook(itemEvent({ id: "e1", batch: r.reference, status: "SUCCESS" }));
    await hook(itemEvent({ id: "e2", batch: r.reference, status: "PENDING", type: "PAYMENT.PAYOUTS-ITEM.HELD" }));
    expect(store.getExecution("pay-1")?.providerStatus).toBe("success");
  });
  test("batch-level events are understood", async () => {
    const r = await pay();
    const body = JSON.stringify({
      id: "WH-B1",
      event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resource: { batch_header: { payout_batch_id: r.reference, batch_status: "SUCCESS", amount: { value: "45.00", currency: "USD" }, sender_batch_header: { sender_batch_id: r.requestId } } },
    });
    expect(await hook(body)).toMatchObject({ result: "matched", providerStatus: "success" });
  });

  test("an event that arrives before the payment is recorded is resolved, not left as false drift", async () => {
    // PayPal's webhook beats our own bookkeeping: simulate by delivering the event, then recording the execution.
    const r = await pay();
    store.db.prepare("DELETE FROM executions WHERE idempotency_key = 'pay-1'").run();
    expect(await hook(itemEvent({ id: "early", batch: r.reference }))).toMatchObject({ result: "drift", kind: "unmatched_payment" });
    store.saveExecution("pay-1", { state: "executed", retryable: false, payload: r, reference: r.reference, requestId: r.requestId });
    expect(store.listDrift("open")).toHaveLength(0);
    expect(store.listDrift("resolved")).toHaveLength(1);
    expect(store.getExecution("pay-1")?.providerStatus).toBe("success");
    expect(store.audit.verify().ok).toBe(true);
  });
});

describe("strict duplicate handling end to end", () => {
  test("a lost response followed by a retry is one executed payment, not a recorded failure", async () => {
    const strictFake = createFakePayPal({ duplicates: "reject" });
    const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: strictFake.fetch });
    const f2 = new Firewall({ store, adapter, authority, policy });
    strictFake.failNext("lost_response");
    expect(await f2.submit(proposal(), ctx)).toMatchObject({ status: "execution_failed", error: { retryable: true } });
    expect(await f2.submit(proposal(), ctx)).toMatchObject({ status: "executed", receipt: { reference: "FAKEBATCH0001" } });
    expect(strictFake.payouts).toHaveLength(1);
    expect(store.getExecution("pay-1")).toMatchObject({ state: "executed" });
  });
});
