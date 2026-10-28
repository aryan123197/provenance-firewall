import { describe, expect, test } from "vitest";
import { evaluate, loadPolicy, tag, type Decision, type OriginKind, type PolicyState, type ResolvedIntent } from "@pfw/core";
import { Authority, AdapterError, PayPalAdapter, UnauthorizedPaymentError, formatAmount, mapPayPalStatus, type AllowedIntent } from "./index";
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
  idempotencyKey: "key-1",
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
});

const authority = new Authority("test-authority-key-0123456789");
const decide = (i: ResolvedIntent): Decision => evaluate(i, POLICY, state());
const allowed = (i = intent()): AllowedIntent => authority.mint(i, decide(i));

function setup(clockMs = { t: 1_000_000 }) {
  const fake = createFakePayPal();
  const adapter = new PayPalAdapter({
    clientId: "test-id",
    clientSecret: "test-secret",
    authority,
    baseUrl: "http://localhost:9999",
    fetch: fake.fetch,
    now: () => clockMs.t,
  });
  return { fake, adapter, clock: clockMs };
}

describe("formatAmount", () => {
  test.each([
    [0, "0.00"],
    [5, "0.05"],
    [4500, "45.00"],
    [123456, "1234.56"],
  ])("%i -> %s", (n, s) => expect(formatAmount(n, "USD")).toBe(s));
  test("rejects floats, negatives and unsupported currencies", () => {
    expect(() => formatAmount(1.5, "USD")).toThrow();
    expect(() => formatAmount(-1, "USD")).toThrow();
    expect(() => formatAmount(100, "JPY")).toThrow();
  });
});

describe("Authority: no bypass path", () => {
  test("refuses to mint for deny and require_approval decisions", () => {
    const evil = intent({ payee: f("invoice", "Evil"), account: f("invoice", "evil@x.example") });
    expect(decide(evil).verdict).toBe("deny");
    expect(() => authority.mint(evil, decide(evil))).toThrow(UnauthorizedPaymentError);
    const big = intent({ amount: f("user", 60000) });
    expect(() => authority.mint(big, decide(big))).toThrow(/require_approval/);
  });
  test("refuses a decision that belongs to a different intent", () => {
    const good = intent();
    const other = intent({ amount: f("po", 99999) });
    expect(() => authority.mint(other, decide(good))).toThrow(/does not match/);
  });
  test("a forged or tampered authorization is rejected before anything is sent", async () => {
    const { adapter, fake } = setup();
    const a = allowed();
    const forged: AllowedIntent = { ...a, tag: "00".repeat(32) };
    const tamperedAmount: AllowedIntent = { ...a, intent: { ...a.intent, amount: f("po", 999999) } };
    const tamperedAccount: AllowedIntent = { ...a, intent: { ...a.intent, account: f("po", "evil@x.example") } };
    const otherKey: AllowedIntent = new Authority("a-different-key-0123456789").mint(intent(), decide(intent()));
    for (const bad of [forged, tamperedAmount, tamperedAccount, otherKey]) {
      await expect(adapter.execute(bad)).rejects.toThrow(UnauthorizedPaymentError);
    }
    expect(fake.calls).toHaveLength(0);
  });
  test("a hand-built object with no tag is rejected", () => {
    const { adapter } = setup();
    expect(() => adapter.propose({ intent: intent(), decision: decide(intent()), authorizedBy: "policy" } as unknown as AllowedIntent)).toThrow(
      UnauthorizedPaymentError,
    );
  });
  test("short keys are rejected", () => expect(() => new Authority("short")).toThrow());
});

describe("Authority: approvals", () => {
  const big = () => intent({ amount: f("user", 60000) });
  const grant = { approvalId: "apr_1", idempotencyKey: "key-1", approver: "dana" };
  test("an approval authorizes a require_approval decision for the same payment", () => {
    const a = authority.mintApproved(big(), decide(big()), grant);
    expect(() => authority.verify(a)).not.toThrow();
    expect(a.authorizedBy).toBe("approval:apr_1:dana");
  });
  test("an approval cannot authorize a deny, and cannot be applied to an allow", () => {
    const evil = intent({ account: f("invoice", "evil@x.example"), payee: f("invoice", "Evil") });
    expect(() => authority.mintApproved(evil, decide(evil), grant)).toThrow(/"deny"/);
    expect(() => authority.mintApproved(intent(), decide(intent()), grant)).toThrow(/"allow"/);
  });
  test("an approval for one payment cannot authorize another", () => {
    expect(() => authority.mintApproved(big(), decide(big()), { ...grant, idempotencyKey: "other" })).toThrow(/different payment/);
  });
  test("relabelling an approval as policy, or the reverse, invalidates the tag", () => {
    const a = authority.mintApproved(big(), decide(big()), grant);
    expect(() => authority.verify({ ...a, authorizedBy: "policy" })).toThrow(UnauthorizedPaymentError);
    const p = allowed();
    expect(() => authority.verify({ ...p, authorizedBy: "approval:apr_1:dana" })).toThrow(UnauthorizedPaymentError);
  });
});

describe("PayPalAdapter", () => {
  test("refuses non-sandbox hosts", () => {
    expect(() => new PayPalAdapter({ clientId: "a", clientSecret: "b", authority, baseUrl: "https://api-m.paypal.com" })).toThrow(/non-sandbox/);
  });

  test("propose builds the payout request without touching the network", () => {
    const { adapter, fake } = setup();
    const p = adapter.propose(allowed());
    expect(fake.calls).toHaveLength(0);
    expect(p.request).toMatchObject({
      items: [{ recipient_type: "EMAIL", receiver: "acme@sandbox.example", amount: { value: "45.00", currency: "USD" } }],
    });
    expect(p.requestId).toMatch(/^pfw-[0-9a-f]{32}$/);
    expect(adapter.propose(allowed()).requestId).toBe(p.requestId);
  });
  test("a PayPal ID receiver uses PAYPAL_ID", () => {
    const { adapter } = setup();
    const i = intent({ account: f("vendor", "ABCDEFGHIJKLM") });
    const st = { ...state(), vendors: [{ id: "acme", name: "Acme Supplies", account: "ABCDEFGHIJKLM", category: "office_supplies" }] };
    const a = authority.mint(i, evaluate(i, POLICY, st));
    expect(adapter.propose(a).request).toMatchObject({ items: [{ recipient_type: "PAYPAL_ID", receiver: "ABCDEFGHIJKLM" }] });
  });

  test("execute authenticates with Basic, then pays with Bearer and the request id", async () => {
    const { adapter, fake } = setup();
    const r = await adapter.execute(allowed());
    const [token, pay] = fake.calls;
    expect(token?.headers.Authorization).toMatch(/^Basic /);
    expect(pay?.headers.Authorization).toBe("Bearer tok-2");
    expect(pay?.headers["PayPal-Request-Id"]).toMatch(/^pfw-/);
    expect(r).toMatchObject({ provider: "paypal", reference: "FAKEBATCH0001", status: "pending", amount: 4500, currency: "USD" });
  });
  test("the access token is reused until it nears expiry", async () => {
    const { adapter, fake, clock } = setup();
    await adapter.execute(allowed(intent({ idempotencyKey: "a" })));
    await adapter.execute(allowed(intent({ idempotencyKey: "b" })));
    expect(fake.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(1);
    clock.t += 32_400_000;
    await adapter.execute(allowed(intent({ idempotencyKey: "c" })));
    expect(fake.calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(2);
  });
  test("an expired token is refreshed once and the call retried", async () => {
    const { adapter, fake } = setup();
    await adapter.execute(allowed(intent({ idempotencyKey: "a" })));
    fake.expireToken();
    const r = await adapter.execute(allowed(intent({ idempotencyKey: "b" })));
    expect(r.reference).toBe("FAKEBATCH0002");
  });

  test("a timeout is retryable and the retry reuses the same request id: one payout only", async () => {
    const { adapter, fake } = setup();
    fake.failNext("timeout");
    const a = allowed();
    await expect(adapter.execute(a)).rejects.toMatchObject({ retryable: true });
    const r = await adapter.execute(a);
    const posts = fake.payoutPosts();
    expect(new Set(posts.map((p) => p.headers["PayPal-Request-Id"])).size).toBe(1);
    expect(r.reference).toBe("FAKEBATCH0001");
  });
  test("a repeated request id returns the same batch", async () => {
    const { adapter } = setup();
    const a = allowed();
    expect((await adapter.execute(a)).reference).toBe((await adapter.execute(a)).reference);
  });
  test("5xx is retryable, 4xx is not", async () => {
    const { adapter, fake } = setup();
    fake.failNext(500);
    await expect(adapter.execute(allowed())).rejects.toMatchObject({ retryable: true, httpStatus: 500 });
    fake.failNext(400);
    const err = await adapter.execute(allowed()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toMatchObject({ retryable: false, httpStatus: 400 });
  });
  test("bad client credentials fail without retry loops", async () => {
    const fake = createFakePayPal();
    const adapter = new PayPalAdapter({ clientId: "x", clientSecret: "y", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
    await expect(adapter.execute(allowed())).rejects.toMatchObject({ retryable: false, httpStatus: 401 });
    expect(fake.calls).toHaveLength(1);
  });

  test("status maps PayPal transaction states", async () => {
    const { adapter, fake } = setup();
    const r = await adapter.execute(allowed());
    expect(await adapter.status(r.reference)).toBe("pending");
    fake.setBatchStatus(r.reference, "SUCCESS");
    expect(await adapter.status(r.reference)).toBe("success");
    fake.setBatchStatus(r.reference, "UNCLAIMED");
    expect(await adapter.status(r.reference)).toBe("unclaimed");
    await expect(adapter.status("nope")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("webhook parsing and verification", () => {
  test("parseMinorUnits", async () => {
    const { parseMinorUnits } = await import("./webhook");
    expect(parseMinorUnits("45.00")).toBe(4500);
    expect(parseMinorUnits("0.5")).toBe(50);
    expect(parseMinorUnits("12")).toBe(1200);
    for (const bad of ["1.234", "-1", "abc", "", 5, undefined]) expect(parseMinorUnits(bad)).toBeUndefined();
  });
  test("verify sends PayPal's verification request and trusts only SUCCESS", async () => {
    const fake = createFakePayPal();
    const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch, webhookId: "WH-TEST" });
    const { fakeWebhookHeaders } = await import("./testing/fake-paypal");
    expect(await adapter.verify(fakeWebhookHeaders(), '{"id":"x"}')).toBe(true);
    expect(await adapter.verify(fakeWebhookHeaders("nope"), '{"id":"x"}')).toBe(false);
    expect(await adapter.verify({}, '{"id":"x"}')).toBe(false);
    expect(await adapter.verify(fakeWebhookHeaders(), "not json")).toBe(false);
  });
  test("verify needs a webhook id", async () => {
    const { adapter } = setup();
    await expect(adapter.verify({}, "{}")).rejects.toThrow(/webhookId/);
  });
});


describe("a reused sender_batch_id (PayPal's strict duplicate handling)", () => {
  const strict = () => {
    const fake = createFakePayPal({ duplicates: "reject" });
    const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
    return { fake, adapter };
  };

  test("a retry after a lost response is the original payout, not a failure, and there is still only one payout", async () => {
    const { fake, adapter } = strict();
    fake.failNext("lost_response");
    const a = allowed();
    await expect(adapter.execute(a)).rejects.toMatchObject({ retryable: true });
    const r = await adapter.execute(a); // PayPal answers 400 with a link to the original; we recognise it as ours
    expect(r).toMatchObject({ reference: "FAKEBATCH0001", status: "pending", amount: 4500 });
    expect(fake.payouts).toHaveLength(1);
  });

  test("a repeat after a normal success also resolves to the same payout", async () => {
    const { fake, adapter } = strict();
    const a = allowed();
    const first = await adapter.execute(a);
    expect((await adapter.execute(a)).reference).toBe(first.reference);
    expect(fake.payouts).toHaveLength(1);
  });

  test("a 400 that links to someone else's payout is a real error, not a success", async () => {
    const fake = createFakePayPal();
    const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
    // Another party's payout exists with a different sender_batch_id.
    const other = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
    await other.execute(allowed(intent({ idempotencyKey: "someone-else" })));
    const realFetch = fake.fetch;
    const lying: typeof fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (String(input).endsWith("/v1/payments/payouts") && init?.method === "POST") {
        return new Response(JSON.stringify({ name: "USER_BUSINESS_ERROR", links: [{ href: "http://localhost:9999/v1/payments/payouts/FAKEBATCH0001" }] }), { status: 400 });
      }
      return res;
    };
    const a2 = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: lying });
    await expect(a2.execute(allowed(intent({ idempotencyKey: "mine" })))).rejects.toMatchObject({ retryable: false, httpStatus: 400 });
    void adapter;
  });

  test("a 400 with no link is a plain non-retryable error", async () => {
    const { fake, adapter } = strict();
    fake.failNext(400);
    await expect(adapter.execute(allowed())).rejects.toMatchObject({ retryable: false, httpStatus: 400 });
  });

  test("a 409 (a concurrent request with the same key) is retryable, so the retry can pick up the result", async () => {
    const fake = createFakePayPal();
    const realFetch = fake.fetch;
    const conflict: typeof fetch = async (input, init) =>
      String(input).endsWith("/v1/payments/payouts") && init?.method === "POST" ? new Response(JSON.stringify({ name: "DUPLICATE_REQUEST_ID" }), { status: 409 }) : realFetch(input, init);
    const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999", fetch: conflict });
    await expect(adapter.execute(allowed())).rejects.toMatchObject({ retryable: true, httpStatus: 409 });
  });
});

describe("mapPayPalStatus", () => {
  test.each([
    ["SUCCESS", "success"], ["PENDING", "pending"], ["PROCESSING", "pending"], ["NEW", "pending"], ["ONHOLD", "pending"],
    ["FAILED", "failed"], ["DENIED", "failed"], ["CANCELED", "failed"], ["BLOCKED", "failed"], ["REFUNDED", "failed"], ["REVERSED", "failed"],
    ["UNCLAIMED", "unclaimed"], ["RETURNED", "returned"], ["SOMETHING_NEW", "unknown"], [undefined, "unknown"],
  ])("%s -> %s", (input, expected) => expect(mapPayPalStatus(input)).toBe(expected));
});

describe("PayPalHttp error handling", () => {
  test("a token response without an access_token is a non-retryable error", async () => {
    const adapter = new PayPalAdapter({ clientId: "a", clientSecret: "b", authority, baseUrl: "http://localhost:9999", fetch: (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as typeof fetch });
    await expect(adapter.execute(allowed())).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("access_token") });
  });
  test("a non-JSON error body is kept as text on the error", async () => {
    const fake = createFakePayPal();
    const real = fake.fetch;
    const adapter = new PayPalAdapter({
      clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: "http://localhost:9999",
      fetch: (async (i, init) => (String(i).endsWith("/payouts") ? new Response("Bad Gateway from a proxy", { status: 502 }) : real(i, init))) as typeof fetch,
    });
    await expect(adapter.execute(allowed())).rejects.toMatchObject({ retryable: true, httpStatus: 502, body: "Bad Gateway from a proxy" });
  });
});

describe("OAuth tokens under concurrency", () => {
  const tokenCalls = (fake: ReturnType<typeof createFakePayPal>) => fake.calls.filter((c) => c.path === "/v1/oauth2/token").length;

  test("simultaneous first requests share one token request", async () => {
    const { fake, adapter } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => adapter.execute(allowed(intent({ idempotencyKey: `c${i}` })))));
    expect(results).toHaveLength(10);
    expect(tokenCalls(fake)).toBe(1);
    expect(fake.payoutPosts()).toHaveLength(10);
  });

  test("a revoked token is replaced once for all callers that hit it, and every payout still goes through", async () => {
    const { fake, adapter } = setup();
    await adapter.execute(allowed(intent({ idempotencyKey: "warm" }))); // token cached
    fake.expireToken();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => adapter.execute(allowed(intent({ idempotencyKey: `r${i}` })))));
    expect(results.every((r) => r.reference)).toBe(true);
    expect(tokenCalls(fake)).toBe(2); // the first one, and a single refresh
  });

  test("a failed token request is not remembered: the next call tries again", async () => {
    const { fake, adapter } = setup();
    const bad = new PayPalAdapter({ clientId: "wrong", clientSecret: "creds", authority, baseUrl: "http://localhost:9999", fetch: fake.fetch });
    await expect(bad.execute(allowed())).rejects.toBeInstanceOf(AdapterError);
    await expect(bad.execute(allowed())).rejects.toBeInstanceOf(AdapterError);
    expect(tokenCalls(fake)).toBe(2);
  });
});
