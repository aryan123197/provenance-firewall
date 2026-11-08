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

export function createFakePayPal(opts: { clientId?: string; clientSecret?: string; duplicates?: "replay" | "reject" } = {}) {
  // "reject": a reused sender_batch_id is refused with a link to the original payout, whatever the request id. This is what the sandbox
  // actually did when a payout was submitted a second time with the same sender_batch_id and the same PayPal-Request-Id, so it is the
  // default. "replay": a repeated PayPal-Request-Id returns the original response (PayPal's documentation suggests this; it was not seen).
  const duplicates = opts.duplicates ?? "reject";
  const clientId = opts.clientId ?? "test-id";
  const clientSecret = opts.clientSecret ?? "test-secret";
  const calls: FakeCall[] = [];
  const faults: Fault[] = [];
  const byRequestId = new Map<string, { status: number; json: unknown }>();
  const payouts: FakePayout[] = [];
  const webhooks = new Map<string, { id: string; url: string; event_types: { name: string }[] }>();
  let hookSeq = 0;
  const invoices = new Map<string, Record<string, unknown> & { status: string }>();
  let invoiceSeq = 0;
  const batches = new Map<string, { status: string; item: string; senderBatchId: string }>();
  // Orders v2, as the sandbox behaved: create answers 200 PAYER_ACTION_REQUIRED with a payer-action link; a repeated PayPal-Request-Id
  // returns the ORIGINAL order even if the body differs; capturing an order the buyer has not approved is a 422 ORDER_NOT_APPROVED.
  const orders = new Map<string, { id: string; status: string; amount: string; currency: string; payee: string; captured: boolean }>();
  const ordersByRequestId = new Map<string, string>();
  let orderSeq = 0;
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

    // ---- Notifications (webhook registration) ----
    if (url.pathname === "/v1/notifications/webhooks" && init.method === "POST") {
      const b = body as { url: string; event_types: { name: string }[] };
      const id = `FAKEHOOK${++hookSeq}`;
      webhooks.set(id, { id, url: b.url, event_types: b.event_types });
      return json(201, webhooks.get(id));
    }
    if (url.pathname === "/v1/notifications/webhooks" && init.method === "GET") return json(200, { webhooks: [...webhooks.values()] });
    const hookMatch = /^\/v1\/notifications\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (hookMatch && init.method === "DELETE") {
      if (!webhooks.delete(hookMatch[1]!)) return json(404, { name: "INVALID_RESOURCE_ID" });
      return new Response(null, { status: 204 });
    }

    // ---- Invoicing v2 ----
    if (url.pathname === "/v2/invoicing/invoices" && init.method === "POST") {
      const id = `INV2-FAKE-${String(++invoiceSeq).padStart(4, "0")}-TEST`;
      const b = body as { detail: Record<string, unknown>; invoicer: Record<string, unknown>; primary_recipients: unknown[]; items: { unit_amount: { currency_code: string; value: string } }[] };
      const sum = b.items.reduce((a, i) => a + Number(i.unit_amount.value), 0);
      invoices.set(id, { id, status: "DRAFT", detail: b.detail, invoicer: b.invoicer, primary_recipients: b.primary_recipients, items: b.items, amount: { currency_code: b.items[0]?.unit_amount.currency_code ?? "USD", value: sum.toFixed(2) } });
      return json(201, { rel: "self", href: `${url.origin}/v2/invoicing/invoices/${id}`, method: "GET" });
    }
    if (url.pathname === "/v2/invoicing/invoices" && init.method === "GET") {
      return json(200, { total_items: invoices.size, items: [...invoices.values()] });
    }
    const invMatch = /^\/v2\/invoicing\/invoices\/([^/]+)(\/send)?$/.exec(url.pathname);
    if (invMatch) {
      const inv = invoices.get(invMatch[1]!);
      if (!inv) return json(404, { name: "RESOURCE_NOT_FOUND" });
      if (invMatch[2] && init.method === "POST") {
        inv.status = "SENT";
        // PayPal's documentation shows a 200 with a link to the invoice.
        return json(200, { rel: "self", href: `${url.origin}/v2/invoicing/invoices/${inv.id}`, method: "GET" });
      }
      if (init.method === "GET") return json(200, inv);
    }

    if (init.method === "POST" && url.pathname === "/v1/notifications/verify-webhook-signature") {
      const b = body as { transmission_sig?: string; webhook_id?: string };
      return json(200, { verification_status: b.transmission_sig === "valid-sig" && b.webhook_id === "WH-TEST" ? "SUCCESS" : "FAILURE" });
    }
    if (url.pathname.startsWith("/v2/checkout/orders")) {
      const orderJson = (o: { id: string; status: string; amount: string; currency: string; payee: string }) => ({
        id: o.id,
        intent: "CAPTURE",
        status: o.status,
        purchase_units: [{ reference_id: "pfw", amount: { currency_code: o.currency, value: o.amount }, payee: { email_address: o.payee } }],
        links: [
          { href: `${url.origin}/v2/checkout/orders/${o.id}`, rel: "self", method: "GET" },
          { href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`, rel: "payer-action", method: "GET" },
        ],
      });
      if (init.method === "POST" && url.pathname === "/v2/checkout/orders") {
        const rid = headers["PayPal-Request-Id"];
        const prior = rid ? ordersByRequestId.get(rid) : undefined;
        if (loseResponse) throw new Error("socket hang up");
        if (prior) return json(200, { id: prior, status: orders.get(prior)!.status, links: orderJson(orders.get(prior)!).links });
        const u = (body as { purchase_units: { amount: { currency_code: string; value: string }; payee: { email_address: string } }[] }).purchase_units[0]!;
        const id = `FAKEORDER${String(++orderSeq).padStart(4, "0")}`;
        orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", amount: u.amount.value, currency: u.amount.currency_code, payee: u.payee.email_address, captured: false });
        if (rid) ordersByRequestId.set(rid, id);
        return json(200, { id, status: "PAYER_ACTION_REQUIRED", links: orderJson(orders.get(id)!).links });
      }
      const m = /^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/.exec(url.pathname);
      const o = m ? orders.get(m[1]!) : undefined;
      if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
      if (init.method === "GET" && !m![2]) return json(200, orderJson(o));
      if (init.method === "POST" && m![2]) {
        if (o.status !== "APPROVED") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] });
        o.status = "COMPLETED";
        o.captured = true;
        return json(201, orderJson(o));
      }
    }
    if (init.method === "POST" && url.pathname === "/v1/payments/payouts") {
      const rid = headers["PayPal-Request-Id"];
      const sbi = (body as { sender_batch_header?: { sender_batch_id?: string } }).sender_batch_header?.sender_batch_id;
      if (duplicates === "reject" && sbi) {
        const orig = [...batches.entries()].find(([, b]) => b.senderBatchId === sbi);
        if (orig) {
          if (loseResponse) throw new Error("socket hang up");
          // The shape the sandbox really returned for a reused sender_batch_id (checked live): the link is inside details[], and links is empty.
          return json(400, {
            name: "USER_BUSINESS_ERROR",
            message: "User business error.",
            debug_id: "fakedebugid",
            information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
            details: [{ field: "SENDER_BATCH_ID", location: "body", issue: "Batch with given sender_batch_id already exists", link: [{ href: `${url.origin}/v1/payments/payouts/${orig[0]}`, rel: "self", method: "GET", encType: "application/json" }] }],
            links: [],
          });
        }
      }
      if (duplicates === "replay" && rid && byRequestId.has(rid)) {
        const prior = byRequestId.get(rid)!;
        if (loseResponse) throw new Error("socket hang up");
        return json(prior.status, prior.json); // PayPal replays the original response for a repeated request id
      }
      const id = `FAKEBATCH${String(++batchSeq).padStart(4, "0")}`;
      const b = body as { items: { sender_item_id: string; receiver: string; amount: { value: string; currency: string } }[] };
      const item = b.items[0]!;
      batches.set(id, { status: "PENDING", item: item.sender_item_id, senderBatchId: sbi ?? "" });
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
      return json(200, { batch_header: { payout_batch_id: m[1], batch_status: b.status, sender_batch_header: { sender_batch_id: b.senderBatchId } }, items: [{ transaction_status: b.status }] });
    }
    return json(404, { name: "NOT_FOUND" });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    calls,
    /** Webhooks registered with the fake Notifications API. */
    webhooks,
    /** Invoices held by the fake Invoicing API, by id. Tests can edit one to simulate a vendor injecting text. */
    invoices,
    /** Payouts that actually exist on the fake PayPal, whether or not the caller saw the response. */
    payouts,
    /** Orders held by the fake Orders API. */
    orders,
    /** The buyer approving an order on PayPal's page. Only the buyer can do this; the API has no call for it. */
    approveOrder: (id: string) => {
      const o = orders.get(id);
      if (o) o.status = "APPROVED";
    },
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
