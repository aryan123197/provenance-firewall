import { createHmac } from "node:crypto";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { buildServer } from "./server";

const server = buildServer({
  databasePath: ":memory:",
  policyPath: new URL("../../../policies/default.policy.yaml", import.meta.url).pathname,
  staticDir: "/nonexistent",
  scorecardPath: "/nonexistent.json",
  port: 0,
  host: "127.0.0.1",
  authorityKey: "test-authority-key-0123456789",
  openOperator: true,
  llmDailyCalls: 300,
  rateLimitPerMinute: 0,
  trustProxy: false,
  demo: true,
  llm: null,
});

const weirdString = fc.oneof(fc.string(), fc.constantFrom("", " ", "-1", "NaN", "Infinity", "1e999", "0x10", "\u0000", "../../etc/passwd", "%00", "<script>", "'; DROP TABLE decisions;--", "a".repeat(5000)), fc.string({ unit: "binary" }));
const weirdValue: fc.Arbitrary<unknown> = fc.oneof(fc.jsonValue(), weirdString, fc.double({ noNaN: false }), fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }));
const body = fc.oneof(fc.dictionary(fc.constantFrom("id", "name", "account", "category", "changedBy", "vendorId", "amount", "currency", "approver", "note", "english", "confirmedBy", "baseVersion", "patch", "examples", "unsupported", "acknowledgeUnsupported", "kind", "scenarioId", "agent", "request"), weirdValue), weirdValue);

const postRoutes = [
  "/api/approvals/x/approve",
  "/api/approvals/x/reject",
  "/api/registry/vendors",
  "/api/registry/purchase-orders",
  "/api/policy/compile",
  "/api/policy/activate",
  "/api/demo/run",
  "/api/demo/simulate-drift",
  "/api/webhooks/paypal",
];
const getRoutes = ["/api/status", "/api/decisions", "/api/approvals", "/api/audit", "/api/registry", "/api/drift", "/api/policy", "/api/scorecard"];

const fail = (status: number, method: string, url: string, detail: unknown) => `${method} ${url} returned ${status} for ${JSON.stringify(detail)?.slice(0, 300)}`;

const SLACK_SECRET = "fuzz-slack-secret";
const slackPosts: unknown[] = [];
const slackServer = buildServer({
  databasePath: ":memory:",
  policyPath: new URL("../../../policies/default.policy.yaml", import.meta.url).pathname,
  staticDir: "/nonexistent",
  scorecardPath: "/nonexistent.json",
  port: 0,
  host: "127.0.0.1",
  authorityKey: "test-authority-key-0123456789",
  openOperator: true,
  llmDailyCalls: 300,
  rateLimitPerMinute: 0,
  trustProxy: false,
  demo: true,
  llm: null,
  slack: { signingSecret: SLACK_SECRET, botToken: "xoxb-fuzz", allowedUsers: [] },
  slackFetch: (async (_u: string, init: { body: string }) => {
    slackPosts.push(init.body);
    return new Response("{}");
  }) as unknown as typeof fetch,
});

describe("API fuzzing", () => {
  test("no POST route answers 5xx, whatever the body", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...postRoutes), body, async (url, payload) => {
        const res = await server.app.inject({ method: "POST", url, payload: JSON.stringify(payload ?? null), headers: { "content-type": "application/json" } });
        // 503 is the documented answer when a feature needs a Claude key the server does not have.
        expect(res.statusCode, fail(res.statusCode, "POST", url, payload)).toBeLessThan(res.statusCode === 503 ? 504 : 500);
      }),
      { numRuns: 400 },
    );
  }, 120_000);

  test("no GET route answers 5xx, whatever the query string or path parameter", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...getRoutes), fc.dictionary(fc.constantFrom("limit", "offset", "after", "status", "x"), weirdString), async (url, query) => {
        const res = await server.app.inject({ method: "GET", url, query: query as Record<string, string> });
        expect(res.statusCode, fail(res.statusCode, "GET", url, query)).toBeLessThan(500);
      }),
      { numRuns: 400 },
    );
    await fc.assert(
      fc.asyncProperty(weirdString, async (key) => {
        const res = await server.app.inject({ method: "GET", url: `/api/decisions/${encodeURIComponent(key)}` });
        expect(res.statusCode, fail(res.statusCode, "GET", "/api/decisions/:key", key)).toBeLessThan(500);
      }),
      { numRuns: 200 },
    );
  }, 120_000);

  test("correctly signed Slack payloads of any shape never produce a 5xx or an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    const event = fc.record(
      { type: fc.constantFrom("app_mention", "message", "reaction_added", weirdString), user: weirdValue, text: weirdValue, channel: weirdValue, channel_type: fc.constantFrom("im", "channel", weirdString), ts: weirdValue, thread_ts: weirdValue, bot_id: fc.constant(undefined), subtype: fc.constant(undefined) },
      { requiredKeys: [] },
    );
    const envelope = fc.oneof(
      fc.record({ type: fc.constantFrom("event_callback", "url_verification", weirdString), event_id: weirdValue, challenge: weirdValue, event }, { requiredKeys: [] }),
      weirdValue,
    );
    try {
      await fc.assert(
        fc.asyncProperty(envelope, async (payload) => {
          const raw = JSON.stringify(payload ?? null);
          const ts = Math.floor(Date.now() / 1000);
          const res = await slackServer.app.inject({
            method: "POST",
            url: "/api/slack/events",
            payload: raw,
            headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${raw}`).digest("hex")}` },
          });
          expect(res.statusCode, fail(res.statusCode, "POST", "/api/slack/events", payload)).toBeLessThan(500);
        }),
        // The first example is an input that failed CI on a random seed: a challenge object whose toString is not callable.
        { numRuns: 600, examples: [[{ type: "url_verification", challenge: { toString: false } }]] },
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 120_000);

  test("after all of that the audit log still verifies", async () => {
    expect((await server.app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true });
    expect((await slackServer.app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true });
  });
});
