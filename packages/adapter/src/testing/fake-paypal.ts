/** In-process stand-in for the PayPal sandbox Payouts API, for tests only. It is NOT PayPal and proves nothing about it. */
export interface FakeCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Fault = "timeout" | 500 | 401 | 400;

export function createFakePayPal(opts: { clientId?: string; clientSecret?: string } = {}) {
  const clientId = opts.clientId ?? "test-id";
  const clientSecret = opts.clientSecret ?? "test-secret";
  const calls: FakeCall[] = [];
  const faults: Fault[] = [];
  const byRequestId = new Map<string, { status: number; json: unknown }>();
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
    if (fault === "timeout") throw new Error("The operation timed out");
    if (fault === 401) return json(401, { name: "AUTHENTICATION_FAILURE" });
    if (fault) return json(fault, { name: "FAULT" });
    if (headers.Authorization !== `Bearer ${validToken}`) return json(401, { name: "AUTHENTICATION_FAILURE" });

    if (init.method === "POST" && url.pathname === "/v1/payments/payouts") {
      const rid = headers["PayPal-Request-Id"];
      if (rid && byRequestId.has(rid)) {
        const prior = byRequestId.get(rid)!;
        return json(prior.status, prior.json); // PayPal replays the original response for a repeated request id
      }
      const id = `FAKEBATCH${String(++batchSeq).padStart(4, "0")}`;
      const b = body as { items: { sender_item_id: string }[] };
      batches.set(id, { status: "PENDING", item: b.items[0]!.sender_item_id });
      const res = { batch_header: { payout_batch_id: id, batch_status: "PENDING" } };
      if (rid) byRequestId.set(rid, { status: 201, json: res });
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
