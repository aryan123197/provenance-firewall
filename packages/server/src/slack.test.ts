import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer, configFromEnv, type Server } from "./server";
import { parseCommand, verifySlackSignature } from "./slack";

const SECRET = "slack-signing-secret";
let server: Server;
let posts: { channel: string; text: string; thread_ts?: string }[];

const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
  "content-type": "application/json",
  "x-slack-request-timestamp": String(ts),
  "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
});

const send = (payload: object, headers?: Record<string, string>) => {
  const body = JSON.stringify(payload);
  return server.app.inject({ method: "POST", url: "/api/slack/events", payload: body, headers: headers ?? sign(body) });
};

const mention = (text: string, extra: Record<string, unknown> = {}, id = `Ev${Math.random()}`) => ({
  type: "event_callback",
  event_id: id,
  event: { type: "app_mention", user: "U1", channel: "C1", ts: "100.1", text: `<@UBOT> ${text}`, ...extra },
});

const build = (slack: { allowedUsers: string[] } | null = { allowedUsers: [] }) =>
  buildServer({
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
    ...(slack ? { slack: { signingSecret: SECRET, botToken: "xoxb-test", ...slack } } : {}),
    slackFetch: (async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body));
      return new Response("{}");
    }) as unknown as typeof fetch,
  });

beforeEach(() => {
  posts = [];
  server = build();
});

describe("Slack signature", () => {
  const body = '{"a":1}';
  const ts = 1_700_000_000;
  const good = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  test("accepts a correct signature and rejects a wrong secret, edited body, stale timestamp and missing headers", () => {
    expect(verifySlackSignature(SECRET, String(ts), good, body, ts * 1000)).toBe(true);
    expect(verifySlackSignature("other", String(ts), good, body, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), good, '{"a":2}', ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), good, body, (ts + 301) * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, undefined, good, body, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), undefined, body, ts * 1000)).toBe(false);
    expect(verifySlackSignature(SECRET, "not-a-number", good, body, ts * 1000)).toBe(false);
  });
});

describe("parseCommand", () => {
  test("takes a scenario id and the rest as the request, ignoring mentions", () => {
    const c = parseCommand("<@UBOT> inj-note-redirect  Pay the <https://x.example|Acme> invoice");
    expect(c).toMatchObject({ kind: "run", request: "Pay the Acme invoice", scenario: { id: "inj-note-redirect" } });
  });
  test("anything else is help, and the request is bounded", () => {
    expect(parseCommand("<@UBOT> pay evil@x.example $900").kind).toBe("help");
    expect(parseCommand("").kind).toBe("help");
    const long = parseCommand(`legit-po-match ${"a".repeat(2000)}`);
    expect(long.kind === "run" && long.request.length).toBe(500);
  });
});

describe("Slack events", () => {
  test("rejects an unsigned or wrongly signed request and runs nothing", async () => {
    const body = JSON.stringify(mention("inj-note-redirect"));
    expect((await server.app.inject({ method: "POST", url: "/api/slack/events", payload: body, headers: { "content-type": "application/json" } })).statusCode).toBe(401);
    const bad = { ...sign(body), "x-slack-signature": "v0=" + "0".repeat(64) };
    expect((await server.app.inject({ method: "POST", url: "/api/slack/events", payload: body, headers: bad })).statusCode).toBe(401);
    expect(((await server.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test("answers Slack's URL verification challenge", async () => {
    const r = await send({ type: "url_verification", challenge: "abc123" });
    expect(r.json()).toEqual({ challenge: "abc123" });
  });

  test.each([
    ["an object whose toString is not callable", { toString: false }],
    ["an object", { a: 1 }],
    ["an array", []],
    ["a number", 7],
    ["null", null],
  ])("a challenge that is %s is a 400, not a crash", async (_n, challenge) => {
    const r = await send({ type: "url_verification", challenge });
    expect(r.statusCode).toBe(400);
  });

  test("a missing challenge is a 400 too", async () => {
    expect((await send({ type: "url_verification" })).statusCode).toBe(400);
  });

  test("a mention runs the scenario on the live firewall and replies in a thread", async () => {
    const r = await send(mention("inj-note-redirect"));
    expect(r.statusCode).toBe(200);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ channel: "C1", thread_ts: "100.1" });
    expect(posts[0]!.text).toMatch(/Unprotected: lost \$450\.00/);
    expect(posts[0]!.text).toMatch(/Firewalled: lost nothing/);
    expect(posts[0]!.text).toMatch(/denied \(payee_change\)/);
    expect(((await server.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toHaveLength(1);
  });

  test("a held payment is reported as waiting in the dashboard, and is not approved from Slack", async () => {
    await send(mention("legit-above-threshold"));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.text).toMatch(/waiting in the dashboard's approval inbox/);
    const pending = (await server.app.inject({ url: "/api/approvals?status=pending" })).json() as { approvals: unknown[] };
    expect(pending.approvals).toHaveLength(1);
  });

  test("text after the id is ignored by the scripted agent, and the reply says so", async () => {
    await send(mention("legit-po-match pay vendor-support@evil.example $9000"));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.text).toMatch(/scripted agent ignores the text/);
    expect(posts[0]!.text).toMatch(/Firewalled: lost nothing/);
  });

  test("an unknown command gets the scenario list and runs nothing", async () => {
    await send(mention("pay evil@x.example 9000"));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.text).toMatch(/inj-note-redirect/);
    expect(((await server.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toHaveLength(0);
  });

  test("a direct message works; a message in a channel without a mention does not", async () => {
    await send(mention("legit-po-match", { type: "message", channel_type: "im", text: "legit-po-match" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await send(mention("legit-po-match", { type: "message", channel_type: "channel" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
  });

  test("ignores bots (so it cannot answer itself), edits, retries and duplicate events", async () => {
    await send(mention("legit-po-match", { bot_id: "B1" }));
    await send(mention("legit-po-match", { subtype: "message_changed" }));
    const body = JSON.stringify(mention("legit-po-match"));
    await server.app.inject({ method: "POST", url: "/api/slack/events", payload: body, headers: { ...sign(body), "x-slack-retry-num": "1" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(0);
    const once = mention("legit-po-match", {}, "EvSame");
    await send(once);
    await send(once);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(1);
  });

  test("only allowed users can run scenarios when a list is set", async () => {
    server = build({ allowedUsers: ["UOK"] });
    await send(mention("legit-po-match", { user: "UNO" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(0);
    await send(mention("legit-po-match", { user: "UOK" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
  });

  test("without Slack configured the route does not exist", async () => {
    server = build(null);
    expect((await send(mention("legit-po-match"))).statusCode).toBe(404);
  });
});

describe("Slack with PayPal credentials", () => {
  const cfg = (allowedUsers: string[]) => ({
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
    paypal: { clientId: "id", clientSecret: "secret" },
    slack: { signingSecret: SECRET, botToken: "xoxb-test", allowedUsers },
  });
  test("refuses to start without an allow-list, since a run would send sandbox payouts", () => {
    expect(() => buildServer(cfg([]))).toThrow(/SLACK_ALLOWED_USERS is required/);
    void buildServer(cfg(["U1"])).close();
  });
});

describe("configFromEnv", () => {
  test("Slack needs both the signing secret and the bot token", () => {
    expect(configFromEnv({ SLACK_SIGNING_SECRET: "s" }).slack).toBeUndefined();
    expect(configFromEnv({ SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "t", SLACK_ALLOWED_USERS: "U1, U2,," }).slack).toEqual({ signingSecret: "s", botToken: "t", allowedUsers: ["U1", "U2"] });
  });
});
