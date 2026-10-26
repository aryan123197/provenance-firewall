import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, test } from "vitest";
import type { PolicyDoc } from "@pfw/core";
import type { Agent } from "@pfw/harness";
import { LlmBudgetError, LlmRefusalError, type CompilerOutput, type MessagesClient, type PolicyCompiler } from "@pfw/llm";
import { verifyAuditExport } from "@pfw/store";
import { buildServer, type Server } from "./server";

const policyPath = new URL("../../../policies/default.policy.yaml", import.meta.url).pathname;
const op = { authorization: "Bearer s3cret-operator-token" };

const SPEC_OUTPUT: CompilerOutput = {
  summary: "Contractors need approval above $500; new vendors are refused on weekends.",
  patch: { categoryApprovalThresholds: { contractors: 50_000 }, newPayeeDenyDays: [0, 6] },
  unsupported: [],
  examples: [
    { description: "A contractor invoice of $500.00 is paid", amount: 500, category: "contractors", expect: "allow" },
    { description: "A contractor invoice of $500.01 needs approval", amount: 500.01, category: "contractors", expect: "require_approval" },
    { description: "A new vendor on Saturday is refused", amount: 100, category: "contractors", newPayee: true, weekday: 6, expect: "deny" },
  ],
};

let server: Server;
let output: CompilerOutput;
let calls: { english: string; active: PolicyDoc }[];

const build = (extra: Partial<Parameters<typeof buildServer>[0]> = {}, withCompiler = true) =>
  buildServer({
    databasePath: ":memory:",
    policyPath,
    staticDir: "/nonexistent",
    scorecardPath: "/nonexistent.json",
    port: 0,
    host: "127.0.0.1",
    authorityKey: "test-authority-key-0123456789",
    operatorToken: "s3cret-operator-token",
    openOperator: false,
    llmDailyCalls: 300,
    demo: false,
    llm: null,
    ...(withCompiler ? { compiler: { compile: async (english, active) => (calls.push({ english, active }), output) } satisfies PolicyCompiler } : {}),
    ...extra,
  });

beforeEach(() => {
  output = structuredClone(SPEC_OUTPUT);
  calls = [];
  server = build();
});

const compile = async (english = "contractors under $500, never pay new vendors on weekends") => {
  const r = await server.app.inject({ method: "POST", url: "/api/policy/compile", headers: op, payload: { english } });
  return { status: r.statusCode, body: r.json() as Record<string, any> };
};
const activate = (body: Record<string, unknown>, headers: Record<string, string> = op) =>
  server.app.inject({ method: "POST", url: "/api/policy/activate", headers, payload: body });

describe("compile", () => {
  test("returns the patch, a diff, generated tests and examples, and nothing is activated yet", async () => {
    const { status, body } = await compile();
    expect(status).toBe(200);
    expect(body).toMatchObject({ baseVersion: 1, canActivate: true, summary: expect.stringContaining("Contractors") });
    expect(body.diff.map((d: { path: string }) => d.path)).toEqual(["categoryApprovalThresholds.contractors", "newPayeeDenyDays"]);
    expect(body.tests.length).toBeGreaterThan(15);
    expect(body.tests.every((t: { passed: boolean }) => t.passed)).toBe(true);
    expect(body.proposed.version).toBe(2);
    expect(calls[0]!.active.version).toBe(1);
    expect(((await server.app.inject({ url: "/api/policy" })).json() as { policy: { version: number } }).policy.version).toBe(1);
  });
  test("without an API key the endpoint says what is missing", async () => {
    const bare = build({}, false);
    const r = await bare.app.inject({ method: "POST", url: "/api/policy/compile", headers: op, payload: { english: "x" } });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: expect.stringContaining("ANTHROPIC_API_KEY") });
    expect((await bare.app.inject({ url: "/api/status" })).json()).toMatchObject({ compilerAvailable: false, llmAgentAvailable: false });
  });
  test("empty text is a 400, a garbage compile is a 422 and a failing compiler a 502", async () => {
    expect((await compile("   ")).status).toBe(400);
    output = { ...SPEC_OUTPUT, patch: { newPayeeDenyDays: [9] } };
    expect((await compile()).status).toBe(422);
    const broken = build({ compiler: { compile: async () => { throw new Error("upstream down"); } } });
    const r = await broken.app.inject({ method: "POST", url: "/api/policy/compile", headers: op, payload: { english: "x" } });
    expect(r.statusCode).toBe(502);
  });
  test("unsupported clauses are returned for the reviewer, never guessed into rules", async () => {
    output = { ...SPEC_OUTPUT, patch: {}, unsupported: [{ clause: "never pay anything after 6pm", reason: "Policies have no time-of-day rule." }], examples: [] };
    const { body } = await compile();
    expect(body.unsupported).toHaveLength(1);
    expect(body.diff).toEqual([]);
  });
  test("a compile whose own examples disagree with its numbers cannot be activated", async () => {
    output = { ...SPEC_OUTPUT, patch: { categoryApprovalThresholds: { contractors: 500 } } }; // dollars slipped to $5.00
    const { body } = await compile();
    expect(body.canActivate).toBe(false);
    expect(body.tests.filter((t: { passed: boolean }) => !t.passed).map((t: { description: string }) => t.description)).toContain("A contractor invoice of $500.00 is paid");
  });
});

describe("compile needs the operator token, because it spends the API budget", () => {
  test("refused without it, and the compiler is never called", async () => {
    const r = await server.app.inject({ method: "POST", url: "/api/policy/compile", payload: { english: "x" } });
    expect(r.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("activate", () => {
  const confirmed = async () => {
    const { body } = await compile();
    return { baseVersion: body.baseVersion, patch: body.patch, english: body.english, examples: body.examples, unsupported: body.unsupported, confirmedBy: "dana@company.example" };
  };

  test("needs the operator token", async () => {
    expect((await activate(await confirmed(), {})).statusCode).toBe(401);
  });
  test("a confirmed policy becomes the next version, used by later decisions, with who/what/why in the audit log", async () => {
    const r = await activate(await confirmed());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, version: 2 });
    const policy = (await server.app.inject({ url: "/api/policy" })).json() as { policy: { version: number; newPayeeDenyDays: number[] }; versions: { version: number; confirmedBy: string; sourceText: string }[] };
    expect(policy.policy).toMatchObject({ version: 2, newPayeeDenyDays: [0, 6] });
    expect(policy.versions[0]).toMatchObject({ confirmedBy: "dana@company.example", sourceText: expect.stringContaining("contractors") });
    expect(((await server.app.inject({ url: "/api/status" })).json() as { policy: { version: number } }).policy.version).toBe(2);
    const audit = (await server.app.inject({ url: "/api/audit" })).json() as { entries: { type: string; payload: { confirmedBy?: string; sourceText?: string } }[] };
    expect(audit.entries.find((e) => e.type === "policy_activated")?.payload).toMatchObject({ confirmedBy: "dana@company.example" });
    expect((await server.app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true });
  });
  test("failing tests block activation even if the browser claims otherwise", async () => {
    output = { ...SPEC_OUTPUT, patch: { categoryApprovalThresholds: { contractors: 500 } } };
    const r = await activate(await confirmed());
    expect(r.statusCode).toBe(422);
    expect((r.json() as { failed: unknown[] }).failed.length).toBeGreaterThan(0);
    expect(((await server.app.inject({ url: "/api/policy" })).json() as { versions: unknown[] }).versions).toEqual([]);
  });
  test("unsupported clauses must be acknowledged", async () => {
    const body = { ...(await confirmed()), unsupported: [{ clause: "after 6pm", reason: "no such rule" }] };
    expect((await activate(body)).statusCode).toBe(400);
    expect((await activate({ ...body, acknowledgeUnsupported: true })).statusCode).toBe(200);
  });
  test("a stale base version is a conflict, and a confirmer is required", async () => {
    const first = await confirmed();
    expect((await activate({ ...first, confirmedBy: "  " })).statusCode).toBe(400);
    expect((await activate(first)).statusCode).toBe(200);
    expect((await activate(first)).statusCode).toBe(409); // still based on version 1
  });
  test("an invalid or malicious patch is rejected, whatever the source", async () => {
    for (const patch of [{ allowUntrustedPayee: true }, { approvalThreshold: -1 }, { newPayeeDenyDays: [12] }, "oops"]) {
      const r = await activate({ baseVersion: 1, patch, confirmedBy: "dana" });
      expect(r.statusCode, JSON.stringify(patch)).toBe(400);
    }
  });
  test("a manual patch with no English text can be activated too", async () => {
    const r = await activate({ baseVersion: 1, patch: { approvalThreshold: 30_000 }, confirmedBy: "dana" });
    expect(r.statusCode).toBe(200);
  });
});

describe("registry endpoints", () => {
  const vendor = { id: "gamma", name: "Gamma Consulting", account: "gamma@sandbox.example", category: "contractors", changedBy: "dana@company.example" };
  const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = op) => server.app.inject({ method: "POST", url, headers, payload });

  test("reading is open; writing needs the operator token", async () => {
    expect((await server.app.inject({ url: "/api/registry" })).statusCode).toBe(200);
    expect((await post("/api/registry/vendors", vendor, {})).statusCode).toBe(401);
    expect((await post("/api/registry/purchase-orders", { id: "po-1", vendorId: "gamma", amount: 1, currency: "USD", changedBy: "d" }, {})).statusCode).toBe(401);
  });
  test("adding a vendor and an order shows up in the registry and the audit log", async () => {
    expect((await post("/api/registry/vendors", vendor)).json()).toMatchObject({ accountChanged: false, after: { id: "gamma" } });
    expect((await post("/api/registry/purchase-orders", { id: "po-g1", vendorId: "gamma", amount: 25_000, currency: "USD", changedBy: "dana" })).statusCode).toBe(200);
    const reg = (await server.app.inject({ url: "/api/registry" })).json() as { vendors: { id: string }[]; purchaseOrders: { id: string; status: string }[] };
    expect(reg.vendors.map((v) => v.id)).toContain("gamma");
    expect(reg.purchaseOrders[0]).toMatchObject({ id: "po-g1", status: "open" });
    const types = ((await server.app.inject({ url: "/api/audit" })).json() as { entries: { type: string }[] }).entries.map((e) => e.type);
    expect(types).toEqual(["vendor_changed", "purchase_order_added"]);
  });
  test("an account change is reported as such", async () => {
    await post("/api/registry/vendors", vendor);
    const r = await post("/api/registry/vendors", { ...vendor, account: "gamma-new@sandbox.example" });
    expect(r.json()).toMatchObject({ accountChanged: true, before: { account: "gamma@sandbox.example" } });
  });
  test("invalid input is a 400 with the reason, and missing fields too", async () => {
    const bad = await post("/api/registry/vendors", { ...vendor, account: "nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: expect.stringContaining("account") });
    expect((await post("/api/registry/vendors", { id: "x" })).statusCode).toBe(400);
    expect((await post("/api/registry/purchase-orders", { id: "po-z", vendorId: "ghost", amount: 1, currency: "USD", changedBy: "d" })).statusCode).toBe(400);
  });
});

describe("demo routes need the operator token unless the server is in open demo mode", () => {
  test("run and reset are refused without it and work with it", async () => {
    const d = build({ demo: true });
    expect((await d.app.inject({ method: "POST", url: "/api/demo/run", payload: { scenarioId: "legit-po-match" } })).statusCode).toBe(401);
    expect((await d.app.inject({ method: "POST", url: "/api/demo/reset" })).statusCode).toBe(401);
    expect((await d.app.inject({ method: "POST", url: "/api/demo/run", headers: { authorization: "Bearer wrong" }, payload: { scenarioId: "legit-po-match" } })).statusCode).toBe(401);
    expect(((await d.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toHaveLength(0);
    expect((await d.app.inject({ method: "POST", url: "/api/demo/run", headers: op, payload: { scenarioId: "legit-po-match" } })).statusCode).toBe(200);
    expect((await d.app.inject({ method: "POST", url: "/api/demo/reset", headers: op })).statusCode).toBe(200);
  });
  test("listing scenarios stays public", async () => {
    expect((await build({ demo: true }).app.inject({ url: "/api/demo/scenarios" })).statusCode).toBe(200);
  });
});

describe("demo runner with a live agent", () => {
  const live: Agent = { name: "fake-llm", kind: "llm", run: async () => undefined };

  test("agent: llm is refused when no key is configured, and allowed when one is", async () => {
    const noKey = build({ demo: true });
    expect((await noKey.app.inject({ method: "POST", url: "/api/demo/run", headers: op, payload: { scenarioId: "legit-po-match", agent: "llm" } })).statusCode).toBe(503);
    const withKey = build({ demo: true, llmAgent: live });
    const r = await withKey.app.inject({ method: "POST", url: "/api/demo/run", headers: op, payload: { scenarioId: "legit-po-match", agent: "llm" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ agent: "fake-llm", agentKind: "llm" });
    expect((await withKey.app.inject({ url: "/api/status" })).json()).toMatchObject({ llmAgentAvailable: true });
  });
  test("the scripted agent stays the default", async () => {
    const d = build({ demo: true });
    expect((await d.app.inject({ method: "POST", url: "/api/demo/run", headers: op, payload: { scenarioId: "legit-po-match" } })).json()).toMatchObject({ agent: "gullible-scripted", agentKind: "scripted" });
  });
});

describe("the Claude budget and agent failures reach the client as clear errors", () => {
  const failing = (e: Error): Agent => ({ name: "failing-llm", kind: "llm", run: async () => { throw e; } });
  const run = async (agent: Agent) => {
    const s = build({ demo: true, llmAgent: agent });
    return s.app.inject({ method: "POST", url: "/api/demo/run", headers: op, payload: { scenarioId: "legit-po-match", agent: "llm" } });
  };

  test("an exhausted daily budget is a 429", async () => {
    const r = await run(failing(new LlmBudgetError(5)));
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ error: expect.stringContaining("daily limit") });
  });
  test("a model refusal is a 422 and any other agent failure is a 502 naming the cause", async () => {
    expect((await run(failing(new LlmRefusalError("cyber")))).statusCode).toBe(422);
    const r = await run(failing(new Error("upstream overloaded")));
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: expect.stringContaining("upstream overloaded") });
  });
  test("the compile endpoint maps a budget error to 429", async () => {
    const s = build({}, false);
    const budgeted = build({ compiler: { compile: async () => { throw new LlmBudgetError(5); } } }, false);
    expect((await budgeted.app.inject({ method: "POST", url: "/api/policy/compile", headers: op, payload: { english: "x" } })).statusCode).toBe(429);
    void s;
  });
  test("the server wraps its Claude client in the configured daily budget", async () => {
    const calls: number[] = [];
    const client: MessagesClient = { messages: { async create() { calls.push(1); throw new Error("stop"); } } };
    const s = build({ llm: client, llmDailyCalls: 1 }, false);
    const compile = () => s.app.inject({ method: "POST", url: "/api/policy/compile", headers: op, payload: { english: "approve over $2k" } });
    expect((await compile()).statusCode).toBe(502); // first call reaches the (failing) client
    expect((await compile()).statusCode).toBe(429); // second is stopped by the budget
    expect(calls).toHaveLength(1);
  });
});

describe("audit export", () => {
  test("the export downloads as a file and verifies offline, and a doctored copy does not", async () => {
    await post0("/api/registry/vendors", { id: "zeta", name: "Zeta Co", account: "zeta@sandbox.example", category: "software", changedBy: "dana" });
    const res = await server.app.inject({ url: "/api/audit/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("audit-export.json");
    const exp = res.json() as Parameters<typeof verifyAuditExport>[0];
    expect(verifyAuditExport(exp)).toMatchObject({ ok: true, count: 1 });
    (exp.entries[0]!.payload as { changedBy: string }).changedBy = "someone-else";
    expect(verifyAuditExport(exp).ok).toBe(false);
  });
});

const post0 = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: "POST", url, headers: op, payload });
