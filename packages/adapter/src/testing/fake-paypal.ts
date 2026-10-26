/** In-process stand-in for the PayPal sandbox Payouts API, for tests only. It is NOT PayPal and proves nothing about it. */
import { parseMinorUnits } from "../webhook";

export interface FakeCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Fault = "timeout" | "lost_response" | 500 | 401 | 400;

export interface FakePayout {
  batchId: string;
  receiver: string;
  /** Minor units. */
  amount: number;
  currency: string;
  requestId: string | undefined;
}

export function createFakePayPal(opts: { clientId?: string; clientSecret?: string } = {}) {
  const clientId = opts.clientId ?? "test-id";
  const clientSecret = opts.clientSecret ?? "test-secret";
  const calls: FakeCall[] = [];
  const faults: Fault[] = [];
  const byRequestId = new Map<string, { status: number; json: unknown }>();
  const payouts: FakePayout[] = [];
  const batches = new Map<string, { status: string; item: string }>();
  let validToken = "tok-1";
  let tokenSeq = 1;
  let batchSeq = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" && headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method ?? "GET", path: url.pathname, headers, body });

    if (url.pathname === "/v1/oauth2/token") {
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      if (headers.Authorization !== expected) return json(401, { error: "invalid_client" });
      validToken = `tok-${++tokenSeq}`;
      return json(200, { access_token: validToken, expires_in: 32400 });
    }

    const fault = faults.shift();
    // The request is processed but the response never arrives, so the caller cannot tell whether it worked.
    const loseResponse = fault === "lost_response";
    if (fault === "timeout") throw new Error("The operation timed out");
    if (fault === 401) return json(401, { name: "AUTHENTICATION_FAILURE" });
    if (fault && !loseResponse) return json(fault, { name: "FAULT" });
    if (headers.Authorization !== `Bearer ${validToken}`) return json(401, { name: "AUTHENTICATION_FAILURE" });

    if (init.method === "POST" && url.pathname === "/v1/notifications/verify-webhook-signature") {
      const b = body as { transmission_sig?: string; webhook_id?: string };
      return json(200, { verification_status: b.transmission_sig === "valid-sig" && b.webhook_id === "WH-TEST" ? "SUCCESS" : "FAILURE" });
    }
    if (init.method === "POST" && url.pathname === "/v1/payments/payouts") {
      const rid = headers["PayPal-Request-Id"];
      if (rid && byRequestId.has(rid)) {
        const prior = byRequestId.get(rid)!;
        if (loseResponse) throw new Error("socket hang up");
        return json(prior.status, prior.json); // PayPal replays the original response for a repeated request id
      }
      const id = `FAKEBATCH${String(++batchSeq).padStart(4, "0")}`;
      const b = body as { items: { sender_item_id: string; receiver: string; amount: { value: string; currency: string } }[] };
      const item = b.items[0]!;
      batches.set(id, { status: "PENDING", item: item.sender_item_id });
      payouts.push({ batchId: id, receiver: item.receiver, amount: parseMinorUnits(item.amount.value) ?? -1, currency: item.amount.currency, requestId: rid });
      const res = { batch_header: { payout_batch_id: id, batch_status: "PENDING" } };
      if (rid) byRequestId.set(rid, { status: 201, json: res });
      if (loseResponse) throw new Error("socket hang up");
      return json(201, res);
    }
    const m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(url.pathname);
    if (init.method === "GET" && m) {
      const b = batches.get(m[1]!);
      if (!b) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, { batch_header: { payout_batch_id: m[1], batch_status: b.status }, items: [{ transaction_status: b.status }] });
    }
    return json(404, { name: "NOT_FOUND" });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    calls,
    /** Payouts that actually exist on the fake PayPal, whether or not the caller saw the response. */
    payouts,
    /** Queue a failure for the next non-token request. */
    failNext: (f: Fault) => faults.push(f),
    expireToken: () => {
      validToken = "revoked";
    },
    setBatchStatus: (id: string, status: string) => {
      const b = batches.get(id);
      if (b) b.status = status;
    },
    payoutPosts: () => calls.filter((c) => c.method === "POST" && c.path === "/v1/payments/payouts"),
  };
}

/** Headers PayPal sends with a webhook. Only transmission_sig "valid-sig" passes the fake's verification. */
export const fakeWebhookHeaders = (sig = "valid-sig"): Record<string, string> => ({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": sig,
  "paypal-transmission-time": "2026-10-30T12:00:00Z",
});
