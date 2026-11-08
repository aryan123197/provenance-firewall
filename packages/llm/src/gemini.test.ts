import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadPolicy } from "@pfw/core";
import type { AgentTools, PayArgs, PayResult } from "@pfw/harness";
import { AnthropicPolicyCompiler, AGENT_TOOLS, COMPILER_JSON_SCHEMA, GeminiClient, GeminiError, LlmAgent, LlmRefusalError, createClient, fromGeminiResponse, modelFromEnv, toGeminiRequest, usesGemini } from "./index";

const base = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));

type Scripted = { status?: number; body: unknown };
/** A fetch that replays scripted responses and records what it was asked. */
function fakeFetch(script: Scripted[]) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = script.shift();
    if (!r) throw new Error("no more scripted responses");
    const status = r.status ?? 200;
    return { ok: status < 400, status, statusText: "x", text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const reply = (parts: unknown[], finishReason = "STOP") => ({ body: { candidates: [{ content: { parts }, finishReason }] } });
const client = (script: Scripted[]) => {
  const ff = fakeFetch(script);
  return { ...ff, client: new GeminiClient({ apiKey: "k", fetch: ff.f, sleep: async () => {} }) };
};

describe("request translation", () => {
  test("maps system, tools, tool calls and tool results, naming each result after its call", () => {
    const body: any = toGeminiRequest({
      model: "m",
      max_tokens: 100,
      system: "be careful",
      tools: AGENT_TOOLS,
      messages: [
        { role: "user", content: "pay it" },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "find_vendor", input: { name: "Acme" } }] as never },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ id: "acme" }) }, { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
      ],
    });
    expect(body.systemInstruction.parts[0].text).toBe("be careful");
    expect(body.generationConfig.maxOutputTokens).toBe(100);
    expect(body.tools[0].functionDeclarations.map((d: any) => d.name)).toEqual(["read_document", "find_vendor", "pay"]);
    expect(body.tools[0].functionDeclarations[2].parametersJsonSchema.required).toContain("idempotency_key");
    expect(body.contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[1].parts[1].functionCall).toEqual({ name: "find_vendor", args: { name: "Acme" } });
    expect(body.contents[2].parts[0].functionResponse).toEqual({ name: "find_vendor", response: { id: "acme" } });
    expect(body.contents[2].parts[1].functionResponse.response).toEqual({ error: "boom" });
  });

  test("a json_schema output format becomes a JSON response schema", () => {
    const body: any = toGeminiRequest({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "x" }], output_config: { format: { type: "json_schema", schema: COMPILER_JSON_SCHEMA as never } } } as never);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.required).toContain("summary");
  });
});

describe("response translation", () => {
  test("text, function calls (with thought signatures kept), refusals and truncation", () => {
    expect(fromGeminiResponse({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] }, "m")).toMatchObject({ stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] });
    const call = fromGeminiResponse({ candidates: [{ content: { parts: [{ thought: true, text: "hmm" }, { functionCall: { name: "pay", args: { a: 1 } }, thoughtSignature: "sig" }] }, finishReason: "STOP" }] }, "m") as any;
    expect(call.stop_reason).toBe("tool_use");
    expect(call.content).toEqual([{ type: "tool_use", id: "call_0", name: "pay", input: { a: 1 }, thoughtSignature: "sig" }]);
    expect(fromGeminiResponse({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] }, "m").stop_reason).toBe("max_tokens");
    expect(fromGeminiResponse({ candidates: [{ finishReason: "SAFETY" }] }, "m")).toMatchObject({ stop_reason: "refusal", stop_details: { category: "SAFETY" } });
    expect(fromGeminiResponse({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }, "m")).toMatchObject({ stop_reason: "refusal" });
  });

  test("the signature is sent back with the call on the next turn", () => {
    const body: any = toGeminiRequest({ model: "m", max_tokens: 1, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "pay", input: {}, thoughtSignature: "sig" }] as never }] });
    expect(body.contents[0].parts[0].thoughtSignature).toBe("sig");
  });
});

describe("GeminiClient", () => {
  test("sends the key as a header, not in the URL, and the model in the path", async () => {
    const { client: c, calls } = client([reply([{ text: "ok" }])]);
    await c.messages.create({ model: "models/gemini-x", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(calls[0]!.url).not.toContain("k");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("k");
  });

  test("retries a rate limit but not a bad key", async () => {
    const ok = client([{ status: 429, body: { error: { message: "slow down" } } }, reply([{ text: "ok" }])]);
    await expect(ok.client.messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })).resolves.toMatchObject({ stop_reason: "end_turn" });
    expect(ok.calls).toHaveLength(2);

    const bad = client([{ status: 400, body: { error: { message: "API key not valid" } } }]);
    await expect(bad.client.messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(GeminiError);
    expect(bad.calls).toHaveLength(1);
  });

  test("gives up after the retries are spent", async () => {
    const f = client(Array.from({ length: 4 }, () => ({ status: 503, body: { error: { message: "busy" } } })));
    await expect(f.client.messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/503/);
    expect(f.calls).toHaveLength(4);
  });
});

describe("the real agent and compiler running on Gemini", () => {
  test("the agent loop reads, pays through the tool, and stops", async () => {
    const pays: PayArgs[] = [];
    const t: AgentTools = {
      request: { text: "Pay the Acme invoice inv_1.", fields: { currency: { handle: "user:req#currency", value: "USD" } } },
      readDocument: (id) => ({ id, kind: "invoice", text: "INVOICE", fields: { total: { handle: `invoice:${id}#total`, value: 45000 } } }),
      findVendor: () => null,
      pay: async (args): Promise<PayResult> => (pays.push(args), { status: "executed", message: "paid", retryable: false }),
    };
    const { client: c, calls } = client([
      reply([{ functionCall: { name: "read_document", args: { id: "inv_1" } } }]),
      reply([{ functionCall: { name: "pay", args: { idempotency_key: "k1", payee: { handle: "vendor:acme#name" }, account: { handle: "vendor:acme#account" }, amount: { handle: "invoice:inv_1#total" }, currency: { handle: "user:req#currency" }, category: { handle: "vendor:acme#category" } } } }]),
      reply([{ text: "Paid." }]),
    ]);
    await new LlmAgent({ client: c, model: "gemini-x" }).run([{ type: "document", id: "inv_1" }], t);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.amount).toEqual({ handle: "invoice:inv_1#total" });
    // The tool result went back as a functionResponse named after the call.
    expect(calls[1]!.body.contents.at(-1).parts[0].functionResponse.name).toBe("read_document");
  });

  test("a model refusal surfaces as the same error the Claude path raises", async () => {
    const { client: c } = client([reply([], "SAFETY")]);
    await expect(new LlmAgent({ client: c, model: "m" }).run([{ type: "user_request" }], { request: { text: "x", fields: {} }, readDocument: () => null as never, findVendor: () => null, pay: async () => ({ status: "error", message: "", retryable: false }) } as AgentTools)).rejects.toThrow(LlmRefusalError);
  });

  test("the compiler parses a JSON reply into a validated patch", async () => {
    const out = { summary: "Raised the threshold.", approvalThreshold: 100000, amountToleranceBps: null, perPayment: null, perVendorPerDay: null, totalPerDay: null, allowedCategories: null, maxPaymentsPerHour: null, categoryThresholds: [], newPayeeDenyDays: null, unsupported: [], examples: [] };
    const { client: c, calls } = client([reply([{ text: JSON.stringify(out) }])]);
    const r = await new AnthropicPolicyCompiler(c, "gemini-x").compile("Approval only above $1,000", base);
    expect(r.patch).toMatchObject({ approvalThreshold: 100000 });
    expect(calls[0]!.body.generationConfig.responseMimeType).toBe("application/json");
  });
});

describe("provider selection", () => {
  test("Anthropic wins when both are set; Gemini is the fallback; neither is undefined", () => {
    expect(usesGemini({ GEMINI_API_KEY: "g" })).toBe(true);
    expect(usesGemini({ GOOGLE_API_KEY: "g" })).toBe(true);
    expect(usesGemini({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" })).toBe(false);
    expect(usesGemini({})).toBe(false);
    expect(createClient({})).toBeUndefined();
    expect(createClient({ GEMINI_API_KEY: "g" })).toBeInstanceOf(GeminiClient);
    expect(modelFromEnv({ GEMINI_API_KEY: "g" })).toBe("gemini-3.5-flash");
    expect(modelFromEnv({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" })).toBe("claude-sonnet-5-5");
    expect(modelFromEnv({ GEMINI_API_KEY: "g", PFW_MODEL: "gemini-y" })).toBe("gemini-y");
  });

  test("does not retry a spent daily quota", async () => {
    const f = client([{ status: 429, body: { error: { message: "Quota exceeded ... requests per day limit exceeded. Please retry in 6h37m49s." } } }, reply([{ text: "ok" }])]);
    await expect(f.client.messages.create({ model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/429/);
    expect(f.calls).toHaveLength(1);
  });
});
