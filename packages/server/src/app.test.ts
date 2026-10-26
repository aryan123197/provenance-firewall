import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import { ProvenanceContext, loadPolicy } from "@pfw/core";
import { Authority, PayPalAdapter } from "@pfw/adapter";
import { createFakePayPal, fakeWebhookHeaders } from "@pfw/adapter/testing";
import { Firewall } from "@pfw/firewall";
import { Store } from "@pfw/store";
import { createApp } from "./app";

const yaml = readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8");
const policy = loadPolicy(yaml);
const authority = new Authority("test-authority-key-0123456789");

let store: Store;
let fake: ReturnType<typeof createFakePayPal>;
let firewall: Firewall;
let ctx: ProvenanceContext;
let app: ReturnType<typeof createApp>;

const propose = (o: Record<string, unknown> = {}) => ({
  agentId: "agent-1",
  idempotencyKey: "k1",
  payee: { handle: "vendor:acme#name" },
  account: { handle: "vendor:acme#account" },
  amount: { handle: "invoice:i#total" },
  currency: { handle: "user:r#currency" },
  category: { handle: "vendor:acme#category" },
  ...o,
});
const op = { authorization: "Bearer s3cret-operator-token" };

beforeEach(() => {
  store = new Store({ clock: () => new Date("2026-11-04T12:00:00.000Z") });
  store.upsertVendor({ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" });
  store.addPurchaseOrder({ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" });
  fake = createFakePayPal();
  const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch, webhookId: "WH-TEST" });
  firewall = new Firewall({ store, adapter, authority, policy, webhooks: adapter });
  ctx = new ProvenanceContext();
  ctx.register("vendor:acme#name", "Acme Supplies");
  ctx.register("vendor:acme#account", "acme@sandbox.example");
  ctx.register("vendor:acme#category", "office_supplies");
  ctx.register("user:r#currency", "USD");
  ctx.register("invoice:i#total", 4500);
  app = createApp({ runtime: () => ({ store, firewall }), policy, policyYaml: yaml, mode: "simulated", operatorToken: "s3cret-operator-token", scorecard: () => ({ hello: "card" }) });
});

describe("read endpoints", () => {
  test("status reports mode, policy, audit health and counts", async () => {
    await firewall.submit(propose(), ctx);
    const r = await app.inject({ url: "/api/status" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "simulated", policy: { name: "default", version: 1 }, audit: { ok: true }, driftOpen: 0, pendingApprovals: 0 });
  });
  test("decisions list and replay record", async () => {
    await firewall.submit(propose(), ctx);
    const list = (await app.inject({ url: "/api/decisions" })).json() as { decisions: { idempotencyKey: string; verdict: string }[] };
    expect(list.decisions[0]).toMatchObject({ idempotencyKey: "k1", verdict: "allow", execution: "executed" });
    const rec = (await app.inject({ url: "/api/decisions/k1" })).json() as { decision: { fields: { payee: { origins: { kind: string }[] } } }; audit: unknown[] };
    expect(rec.decision.fields.payee.origins[0]?.kind).toBe("vendor");
    expect(rec.audit.length).toBeGreaterThan(0);
    expect((await app.inject({ url: "/api/decisions/nope" })).statusCode).toBe(404);
  });
  test("policy, scorecard, audit and drift are served", async () => {
    expect((await app.inject({ url: "/api/policy" })).json()).toMatchObject({ policy: { name: "default" }, yaml: expect.stringContaining("approvalThreshold") });
    expect((await app.inject({ url: "/api/scorecard" })).json()).toEqual({ hello: "card" });
    expect((await app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true });
    expect((await app.inject({ url: "/api/drift" })).json()).toEqual({ drift: [] });
  });
  test("unknown API paths 404 as JSON", async () => {
    expect((await app.inject({ url: "/api/nothing" })).statusCode).toBe(404);
  });
});

describe("approvals", () => {
  const hold = async () => {
    ctx.register("invoice:i#total", 45000);
    const o = await firewall.submit(propose({ idempotencyKey: "big" }), ctx);
    if (o.status !== "needs_approval") throw new Error("expected needs_approval");
    return o.approvalId;
  };

  test("operator actions need the token", async () => {
    const id = await hold();
    expect((await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, payload: { approver: "dana" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: { authorization: "Bearer wrong" }, payload: { approver: "dana" } })).statusCode).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
  test("approving with the token executes once and a second attempt conflicts", async () => {
    const id = await hold();
    const r = await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: op, payload: { approver: "dana@company.example", note: "ok" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "executed" });
    expect(fake.payoutPosts()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: op, payload: { approver: "eve" } })).statusCode).toBe(409);
    expect(fake.payoutPosts()).toHaveLength(1);
  });
  test("rejecting records it and sends nothing", async () => {
    const id = await hold();
    const r = await app.inject({ method: "POST", url: `/api/approvals/${id}/reject`, headers: op, payload: { approver: "dana" } });
    expect(r.json()).toMatchObject({ status: "rejected" });
    expect(fake.calls).toHaveLength(0);
    expect((await app.inject({ url: "/api/approvals?status=rejected" })).json()).toMatchObject({ approvals: [{ status: "rejected" }] });
  });
  test("an approver name is required, unknown ids 404, and bad filters 400", async () => {
    const id = await hold();
    expect((await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: op, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/approvals/apr_nope/approve", headers: op, payload: { approver: "dana" } })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/approvals?status=weird" })).statusCode).toBe(400);
  });
  test("the agent id cannot approve its own request", async () => {
    const id = await hold();
    expect((await app.inject({ method: "POST", url: `/api/approvals/${id}/approve`, headers: op, payload: { approver: "agent-1" } })).statusCode).toBe(409);
  });
  test("open operator mode skips the token for public demos", async () => {
    const open = createApp({ runtime: () => ({ store, firewall }), policy, policyYaml: yaml, mode: "simulated", openOperator: true });
    const id = await hold();
    expect((await open.inject({ method: "POST", url: `/api/approvals/${id}/reject`, payload: { approver: "visitor" } })).statusCode).toBe(200);
  });
});

describe("webhook endpoint", () => {
  const body = (batch: string) =>
    JSON.stringify({ id: "WH-1", event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", resource: { payout_batch_id: batch, transaction_status: "SUCCESS", payout_item: { receiver: "acme@sandbox.example", amount: { value: "45.00", currency: "USD" } } } });

  test("a signed event updates the payment, a forged one is refused with 400", async () => {
    const o = await firewall.submit(propose(), ctx);
    if (o.status !== "executed") throw new Error("expected executed");
    const ok = await app.inject({ method: "POST", url: "/api/webhooks/paypal", headers: { ...fakeWebhookHeaders(), "content-type": "application/json" }, payload: body(o.receipt.reference) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "processed", result: "matched" });
    const bad = await app.inject({ method: "POST", url: "/api/webhooks/paypal", headers: { ...fakeWebhookHeaders("forged"), "content-type": "application/json" }, payload: body("X") });
    expect(bad.statusCode).toBe(400);
    expect(store.listDrift()).toHaveLength(0);
  });
  test("malformed JSON is a 400", async () => {
    const r = await app.inject({ method: "POST", url: "/api/webhooks/paypal", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(r.statusCode).toBe(400);
  });
});
