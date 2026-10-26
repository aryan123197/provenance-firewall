import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { applyPatch, diffPolicy, lintPolicy, loadPolicy, runIntentExamples, runPolicyTests } from "@pfw/core";
import type { AgentTools, PayArgs, PayResult } from "@pfw/harness";
import { AGENT_TOOLS, AnthropicPolicyCompiler, LlmAgent, LlmBudgetError, LlmRefusalError, toCompilerOutput, withDailyBudget, type MessagesClient } from "./index";

const base = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));

type Reply = Partial<Anthropic.Message> & { content: Anthropic.ContentBlock[] };
function fakeClient(replies: Reply[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        // Snapshot: the agent keeps appending to the same messages array.
        requests.push(structuredClone(params));
        const r = replies.shift();
        if (!r) throw new Error("no more scripted replies");
        return { id: "msg", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: {} as Anthropic.Usage, ...r } as Anthropic.Message;
      },
    },
  };
  return { client, requests };
}
const text = (t: string): Anthropic.ContentBlock => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;
const toolUse = (id: string, name: string, input: unknown): Anthropic.ContentBlock => ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as Anthropic.ContentBlock;

function tools(overrides: Partial<AgentTools> = {}) {
  const pays: PayArgs[] = [];
  const t: AgentTools = {
    request: { text: "Pay the Acme invoice inv_1.", fields: { currency: { handle: "user:req#currency", value: "USD" } } },
    readDocument: (id) => ({ id, kind: "invoice", text: `INVOICE ${id}`, fields: { total: { handle: `invoice:${id}#total`, value: 45000 } } }),
    findVendor: (name) => (name === "Acme Supplies" ? { id: "acme", name: { handle: "vendor:acme#name", value: name }, account: { handle: "vendor:acme#account", value: "a@x" }, category: { handle: "vendor:acme#category", value: "office_supplies" } } : null),
    pay: async (args): Promise<PayResult> => {
      pays.push(args);
      return { status: "executed", message: "paid", retryable: false };
    },
    ...overrides,
  };
  return { t, pays };
}

describe("LlmAgent", () => {
  const payInput = { idempotency_key: "pay-inv_1", payee: { handle: "vendor:acme#name" }, account: { handle: "vendor:acme#account" }, amount: { handle: "invoice:inv_1#total" }, currency: { handle: "user:req#currency" }, category: { handle: "vendor:acme#category" } };

  test("runs the tool loop: reads, looks up, pays with handles, and finishes", async () => {
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "read_document", { id: "inv_1" }), toolUse("t2", "find_vendor", { name: "Acme Supplies" })] },
      { stop_reason: "tool_use", content: [toolUse("t3", "pay", payInput)] },
      { content: [text("Paid.")] },
    ]);
    const { t, pays } = tools();
    await new LlmAgent({ client }).run([{ type: "document", id: "inv_1" }], t);

    expect(pays).toEqual([
      { idempotencyKey: "pay-inv_1", payee: { handle: "vendor:acme#name" }, account: { handle: "vendor:acme#account" }, amount: { handle: "invoice:inv_1#total" }, currency: { handle: "user:req#currency" }, category: { handle: "vendor:acme#category" } },
    ]);
    // Both results of the first turn come back together in ONE user message.
    const second = requests[1]!.messages;
    const last = second[second.length - 1]!;
    expect(last.role).toBe("user");
    expect((last.content as Anthropic.ToolResultBlockParam[]).map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
  });

  test("request shape: default model, the three tools, no forced tool choice, no sampling or disabled thinking", async () => {
    const { client, requests } = fakeClient([{ content: [text("nothing to do")] }]);
    await new LlmAgent({ client }).run([{ type: "document", id: "inv_1" }], tools().t);
    const req = requests[0]! as unknown as Record<string, unknown>;
    expect(req.model).toBe("claude-opus-5-5");
    expect(AGENT_TOOLS.map((x) => x.name)).toEqual(["read_document", "find_vendor", "pay"]);
    for (const banned of ["tool_choice", "temperature", "top_p", "top_k", "thinking"]) expect(req[banned]).toBeUndefined();
    expect(JSON.stringify(req.messages)).toContain("inv_1");
  });

  test("echoes the assistant turn back unchanged, including thinking blocks", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" } as unknown as Anthropic.ContentBlock;
    const { client, requests } = fakeClient([{ stop_reason: "tool_use", content: [thinking, toolUse("t1", "find_vendor", { name: "Nobody" })] }, { content: [text("done")] }]);
    await new LlmAgent({ client }).run([], tools().t);
    const echoed = requests[1]!.messages[1]!.content as Anthropic.ContentBlock[];
    expect(echoed[0]).toEqual(thinking);
  });

  test("malformed pay arguments become an error result, not a payment", async () => {
    const bad = { ...payInput, amount: { handle: "x", literal: 5 } }; // both given
    const { client, requests } = fakeClient([
      { stop_reason: "tool_use", content: [toolUse("t1", "pay", bad), toolUse("t2", "pay", { idempotency_key: "k" }), toolUse("t3", "nope", {})] },
      { content: [text("gave up")] },
    ]);
    const { t, pays } = tools();
    await new LlmAgent({ client }).run([], t);
    expect(pays).toHaveLength(0);
    const results = requests[1]!.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(results.every((r) => r.is_error)).toBe(true);
    expect(results[2]!.content).toMatch(/unknown tool/);
  });

  test("a denied payment is returned to the model as information, not hidden", async () => {
    const { client, requests } = fakeClient([{ stop_reason: "tool_use", content: [toolUse("t1", "pay", payInput)] }, { content: [text("It was denied.")] }]);
    const { t } = tools({ pay: async () => ({ status: "denied", message: "Payee changed", retryable: false, rule: "payee_change" }) });
    await new LlmAgent({ client }).run([], t);
    const r = (requests[1]!.messages[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(String(r.content)).toContain("payee_change");
  });

  test("a model refusal stops the run with a typed error", async () => {
    const { client } = fakeClient([{ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, content: [] }]);
    await expect(new LlmAgent({ client }).run([], tools().t)).rejects.toBeInstanceOf(LlmRefusalError);
  });

  test("the loop is capped", async () => {
    const replies = Array.from({ length: 30 }, (_, i) => ({ stop_reason: "tool_use" as const, content: [toolUse(`t${i}`, "find_vendor", { name: "x" })] }));
    const { client, requests } = fakeClient(replies);
    await new LlmAgent({ client }).run([], tools().t);
    expect(requests.length).toBe(12);
  });

  test("tool errors thrown by the harness reach the model as errors", async () => {
    const { client, requests } = fakeClient([{ stop_reason: "tool_use", content: [toolUse("t1", "read_document", { id: "missing" })] }, { content: [text("ok")] }]);
    const { t } = tools({ readDocument: () => { throw new Error("no such document: missing"); } });
    await new LlmAgent({ client }).run([], t);
    const r = (requests[1]!.messages[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(r).toMatchObject({ is_error: true });
  });
});

describe("AnthropicPolicyCompiler", () => {
  // What a model would return for: "contractors under $500, never pay new vendors on weekends, anything over $2k needs my approval".
  const specOutput = {
    summary: "Contractor invoices above $500 need approval, new vendors are refused on weekends, and anything over $2,000 needs approval.",
    approvalThreshold: 200_000,
    amountToleranceBps: null,
    perPayment: null,
    perVendorPerDay: null,
    totalPerDay: null,
    allowedCategories: null,
    maxPaymentsPerHour: null,
    categoryThresholds: [{ category: "contractors", thresholdMinor: 50_000 }],
    newPayeeDenyDays: [0, 6],
    unsupported: [],
    examples: [
      { description: "A contractor invoice of $500.00 is paid", amount: 500, category: "contractors", newPayee: false, weekday: null, expect: "allow" },
      { description: "A contractor invoice of $500.01 needs approval", amount: 500.01, category: "contractors", newPayee: false, weekday: null, expect: "require_approval" },
      { description: "A new vendor on Saturday is refused", amount: 100, category: "contractors", newPayee: true, weekday: 6, expect: "deny" },
    ],
  };
  const reply = (o: unknown): Reply => ({ content: [text(JSON.stringify(o))] });

  test("compiles the spec's example into a patch, examples and a diff, and all checks pass", async () => {
    const { client } = fakeClient([reply(specOutput)]);
    const out = await new AnthropicPolicyCompiler(client).compile("contractors under $500, never pay new vendors on weekends, anything over $2k needs my approval", base);
    expect(out.patch).toEqual({ approvalThreshold: 200_000, categoryApprovalThresholds: { contractors: 50_000 }, newPayeeDenyDays: [0, 6] });
    expect(out.unsupported).toEqual([]);
    const next = applyPatch(base, out.patch);
    expect(diffPolicy(base, next).map((c) => [c.path, c.direction])).toEqual([
      ["approvalThreshold", "looser"],
      ["categoryApprovalThresholds.contractors", "changed"],
      ["newPayeeDenyDays", "tighter"],
    ]);
    expect(runPolicyTests(next).every((t) => t.passed)).toBe(true);
    expect(runIntentExamples(next, out.examples).every((t) => t.passed)).toBe(true);
    // The $2k threshold sits above the $1k per-payment cap: the reviewer must be told approval cannot apply there.
    expect(lintPolicy(next).join(" ")).toMatch(/above the per-payment cap/);
  });

  test("sends a structured-output request with the active policy, and none of the removed parameters", async () => {
    const { client, requests } = fakeClient([reply(specOutput)]);
    await new AnthropicPolicyCompiler(client).compile("anything over $2k needs my approval", base);
    const req = requests[0]! as unknown as Record<string, unknown> & { output_config: { format: { type: string; schema: { required: string[] } } }; messages: { content: string }[] };
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.format.schema.required).toContain("unsupported");
    expect(req.messages[0]!.content).toContain('"approvalThreshold": 50000');
    expect(req.messages[0]!.content).toContain("anything over $2k needs my approval");
    for (const banned of ["tool_choice", "temperature", "top_p", "top_k", "thinking"]) expect(req[banned]).toBeUndefined();
  });

  test("unsupported clauses are passed through, not guessed", async () => {
    const out = toCompilerOutput({ ...specOutput, newPayeeDenyDays: null, categoryThresholds: [], approvalThreshold: null, unsupported: [{ clause: "never pay anything after 6pm", reason: "Policies have no time-of-day rule." }] });
    expect(out.patch).toEqual({});
    expect(out.unsupported).toHaveLength(1);
  });

  test("model output that is not a valid patch is rejected", () => {
    expect(() => toCompilerOutput({ ...specOutput, newPayeeDenyDays: [9] })).toThrow();
    expect(() => toCompilerOutput({ ...specOutput, approvalThreshold: -1 })).toThrow();
    expect(() => toCompilerOutput({ ...specOutput, approvalThreshold: 1.5 })).toThrow();
    expect(() => toCompilerOutput({ summary: "x" })).toThrow();
  });

  test("a model cannot smuggle a provenance setting in: unknown fields never reach the patch", () => {
    const out = toCompilerOutput({ ...specOutput, allowUntrustedPayee: true, provenance: "off" });
    expect(JSON.stringify(out.patch)).not.toMatch(/untrusted|provenance/i);
  });

  test("refusals, truncation, empty and non-JSON replies are errors with clear messages", async () => {
    const run = (r: Reply) => new AnthropicPolicyCompiler(fakeClient([r]).client).compile("x", base);
    await expect(run({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null }, content: [] })).rejects.toBeInstanceOf(LlmRefusalError);
    await expect(run({ stop_reason: "max_tokens", content: [text("{")] })).rejects.toThrow(/ran out of room/);
    await expect(run({ content: [] })).rejects.toThrow(/no policy/);
    await expect(run({ content: [text("sure! here you go")] })).rejects.toThrow(/valid JSON/);
  });

  test("empty and oversized input is refused before any call", async () => {
    const { client, requests } = fakeClient([]);
    const c = new AnthropicPolicyCompiler(client);
    await expect(c.compile("   ", base)).rejects.toThrow(/write the policy/);
    await expect(c.compile("x".repeat(4001), base)).rejects.toThrow(/too long/);
    expect(requests).toHaveLength(0);
  });
});

describe("withDailyBudget", () => {
  const ok = () => fakeClient(Array.from({ length: 10 }, () => ({ content: [text("hi")] }))).client;
  const call = (c: MessagesClient) => c.messages.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] });

  test("allows up to the limit, then refuses without calling the API", async () => {
    const inner = fakeClient(Array.from({ length: 10 }, () => ({ content: [text("hi")] })));
    const c = withDailyBudget(inner.client, 2);
    await call(c);
    await call(c);
    await expect(call(c)).rejects.toBeInstanceOf(LlmBudgetError);
    expect(inner.requests).toHaveLength(2);
    expect(c.used()).toBe(2);
  });
  test("the count resets on the next UTC day", async () => {
    let now = new Date("2026-11-01T23:59:00Z");
    const c = withDailyBudget(ok(), 1, () => now);
    await call(c);
    await expect(call(c)).rejects.toBeInstanceOf(LlmBudgetError);
    now = new Date("2026-11-02T00:01:00Z");
    await expect(call(c)).resolves.toBeDefined();
  });
  test("a budget error stops the agent and the compiler", async () => {
    const c = withDailyBudget(fakeClient([{ stop_reason: "tool_use", content: [toolUse("t1", "find_vendor", { name: "x" })] }]).client, 1);
    await expect(new LlmAgent({ client: c }).run([], tools().t)).rejects.toBeInstanceOf(LlmBudgetError);
    await expect(new AnthropicPolicyCompiler(withDailyBudget(ok(), 0)).compile("x", base)).rejects.toBeInstanceOf(LlmBudgetError);
  });
});
