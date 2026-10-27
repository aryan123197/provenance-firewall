import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { evaluate, loadPolicy, tag, type PolicyState, type ResolvedIntent } from "@pfw/core";
import { AdapterError, Authority, PayPalAdapter, parsePayPalEvent } from "./index";

/** PayPal is outside our control: whatever it sends back, the adapter must return a well-formed result or a typed AdapterError. */

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
const f = <T>(value: T) => tag(value, { kind: "vendor", ref: "vendor:t" });
const intent: ResolvedIntent = {
  agentId: "a1",
  idempotencyKey: "key-1",
  payee: f("Acme Supplies"),
  account: f("acme@sandbox.example"),
  amount: f(4500),
  currency: f("USD"),
  category: f("office_supplies"),
};
const state: PolicyState = {
  now: "2026-10-28T12:00:00.000Z",
  vendors: [{ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" }],
  purchaseOrder: null,
  vendorSpentToday: {},
  totalSpentToday: 0,
  paymentsLastHour: 0,
};
const authority = new Authority("test-authority-key-0123456789");
const allowed = authority.mint(intent, evaluate(intent, POLICY, state));

const junk: fc.Arbitrary<unknown> = fc.oneof(fc.jsonValue(), fc.string(), fc.constant(undefined), fc.double());
const status = fc.constantFrom(200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503);

/** A fetch that answers every request with one canned response, as raw text so non-JSON bodies are covered too. */
const respond = (code: number, body: unknown, raw: boolean) => {
  const text = raw ? String(body) : JSON.stringify(body ?? null);
  return (async () => new Response(code === 204 ? null : text, { status: code, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
};

const adapter = (fetchImpl: typeof fetch) =>
  new PayPalAdapter({ clientId: "id", clientSecret: "secret", authority, baseUrl: "http://localhost:9999", fetch: fetchImpl, webhookId: "WH", now: () => 1_000_000, retries: 0, sleep: async () => {} } as never);

const isTyped = (e: unknown) => e instanceof AdapterError;

describe("adapter against arbitrary PayPal responses", () => {
  test("execute returns a receipt with a non-empty string reference, or throws an AdapterError", async () => {
    await fc.assert(
      fc.asyncProperty(status, junk, fc.boolean(), async (code, body, raw) => {
        // The token request shares the fetch, so give it a valid answer first and the fuzzed one after.
        let calls = 0;
        const fetchImpl = (async (url: string) => {
          if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
          calls++;
          return respond(code, body, raw)(url);
        }) as unknown as typeof fetch;
        try {
          const receipt = await adapter(fetchImpl).execute(allowed);
          expect(typeof receipt.reference).toBe("string");
          expect(receipt.reference.length).toBeGreaterThan(0);
        } catch (e) {
          expect(isTyped(e), `untyped error: ${String(e)}`).toBe(true);
        }
        expect(calls).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  test("status returns a known state or throws an AdapterError", async () => {
    await fc.assert(
      fc.asyncProperty(status, junk, fc.boolean(), async (code, body, raw) => {
        const fetchImpl = (async (url: string) => {
          if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
          return respond(code, body, raw)(url);
        }) as unknown as typeof fetch;
        try {
          expect(["pending", "success", "failed", "unknown"]).toContain(await adapter(fetchImpl).status("PAYOUT123"));
        } catch (e) {
          expect(isTyped(e), `untyped error: ${String(e)}`).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("verify answers true only for an explicit SUCCESS", async () => {
    await fc.assert(
      fc.asyncProperty(status, junk, fc.boolean(), async (code, body, raw) => {
        const fetchImpl = (async (url: string) => {
          if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
          return respond(code, body, raw)(url);
        }) as unknown as typeof fetch;
        const headers = { "paypal-auth-algo": "a", "paypal-cert-url": "https://x", "paypal-transmission-id": "i", "paypal-transmission-sig": "s", "paypal-transmission-time": "t" };
        let ok: boolean | "threw" = "threw";
        try {
          ok = await adapter(fetchImpl).verify(headers, "{}");
        } catch (e) {
          expect(isTyped(e), `untyped error: ${String(e)}`).toBe(true);
        }
        if (ok === true) {
          expect(code >= 200 && code < 300).toBe(true);
          expect((body as { verification_status?: string } | null)?.verification_status).toBe("SUCCESS");
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("adapter against a broken token endpoint", () => {
  test("any token response is a typed error or a working token", async () => {
    await fc.assert(
      fc.asyncProperty(status, junk, fc.boolean(), async (code, body, raw) => {
        try {
          await adapter(respond(code, body, raw)).status("PAYOUT123");
        } catch (e) {
          expect(isTyped(e), `untyped error: ${String(e)}`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("a success status with an unusable body", () => {
  const withBody = (code: number, text: string | null) =>
    adapter((async (url: string) =>
      String(url).includes("/oauth2/token") ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 }) : new Response(text, { status: code })) as unknown as typeof fetch);

  test.each([
    ["an empty body", 200, ""],
    ["no content", 204, null],
    ["JSON null", 200, "null"],
    ["an array", 200, "[]"],
    ["text", 200, "OK"],
    ["a payout with no batch id", 201, '{"batch_header":{}}'],
  ])("%s on execute is a typed error, retryable where the payout may have happened", async (_n, code, text) => {
    const err = await withBody(code, text).execute(allowed).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    if (_n !== "a payout with no batch id") expect((err as AdapterError).retryable).toBe(true);
  });
});

describe("parsePayPalEvent", () => {
  test("never throws, and a result always carries the event id and a string type", () => {
    fc.assert(
      fc.property(fc.oneof(junk, fc.record({ id: junk, event_type: junk, resource: junk }, { requiredKeys: [] }), fc.record({ id: fc.string(), event_type: fc.constantFrom("PAYMENT.PAYOUTSBATCH.SUCCESS", "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "X"), resource: junk }, { requiredKeys: [] })), (raw) => {
        const ev = parsePayPalEvent(raw);
        if (ev) {
          expect(typeof ev.id).toBe("string");
          expect(typeof ev.type).toBe("string");
        }
      }),
      { numRuns: 2000 },
    );
  });
});
