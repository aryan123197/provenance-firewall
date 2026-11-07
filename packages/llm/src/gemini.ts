import type Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "./client";

/**
 * A Google Gemini backend behind the same `MessagesClient` interface the agent and the policy compiler already use, so they run
 * unchanged on a Gemini API key (including the free tier). It speaks Gemini's REST `generateContent` API directly, with no SDK,
 * and translates in both directions:
 *
 *   system            -> systemInstruction
 *   tools             -> functionDeclarations (JSON Schema passed through as parametersJsonSchema)
 *   tool_use blocks   <-> functionCall parts
 *   tool_result       <-> functionResponse parts
 *   output_config.format json_schema -> responseMimeType application/json + responseJsonSchema
 *
 * Only the slice of the Messages API those two modules use is implemented. Anything else is ignored rather than guessed at.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/** The model used when the operator did not set PFW_MODEL. Override it; free-tier model names and limits change. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export interface GeminiClientOptions {
  apiKey: string;
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Retries on 429 and 5xx, which the free tier returns often. */
  maxRetries?: number;
  /** For tests, so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Gemini API error ${status}: ${message}`);
    this.name = "GeminiError";
  }
}

const REFUSAL_REASONS = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "RECITATION"]);

export class GeminiClient implements MessagesClient {
  private readonly doFetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly messages: MessagesClient["messages"];

  constructor(private readonly opts: GeminiClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.messages = { create: (params) => this.create(params) };
  }

  private async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    const body = toGeminiRequest(params);
    const model = params.model.replace(/^models\//, "");
    const url = `${ENDPOINT}/models/${encodeURIComponent(model)}:generateContent`;

    let last: GeminiError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: GeminiResponse = {};
      try {
        json = text ? (JSON.parse(text) as GeminiResponse) : {};
      } catch {
        /* a non-JSON error body is reported below */
      }
      if (res.ok) return fromGeminiResponse(json, params.model);
      last = new GeminiError(res.status, json.error?.message ?? (text.slice(0, 200) || res.statusText));
      // Rate limits and transient server errors are worth waiting for; a bad key or a bad request is not.
      if (res.status !== 429 && res.status < 500) break;
      if (attempt < this.maxRetries) await this.sleep(Math.min(2000 * 2 ** attempt, 15000));
    }
    throw last ?? new GeminiError(0, "no response");
  }
}

/** Anthropic-style request -> Gemini generateContent body. Exported for tests. */
export function toGeminiRequest(params: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> {
  // A tool_result only names the call it answers by id, but Gemini wants the function's name, so remember each id's name.
  const names = new Map<string, string>();
  const contents: GeminiContent[] = [];

  for (const m of params.messages) {
    const blocks: Anthropic.ContentBlockParam[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const parts: GeminiPart[] = [];
    for (const b of blocks) {
      if (b.type === "text") {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        const sig = (b as { thoughtSignature?: string }).thoughtSignature;
        parts.push({ functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> }, ...(sig ? { thoughtSignature: sig } : {}) });
      } else if (b.type === "tool_result") {
        const raw = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
        parts.push({ functionResponse: { name: names.get(b.tool_use_id) ?? "unknown", response: toResponseObject(raw, b.is_error === true) } });
      }
      // thinking and other block types have no Gemini equivalent here and are dropped.
    }
    if (parts.length) contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }

  const system = typeof params.system === "string" ? params.system : (params.system ?? []).map((s) => s.text).join("\n");
  const generationConfig: Record<string, unknown> = { maxOutputTokens: params.max_tokens };
  const format = (params as { output_config?: { format?: { type?: string; schema?: unknown } } }).output_config?.format;
  if (format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = format.schema;
  }
  const tools = (params.tools ?? []).filter((t): t is Anthropic.Tool => "input_schema" in t);

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description ?? "", parametersJsonSchema: t.input_schema })) }] } : {}),
    generationConfig,
  };
}

/** Gemini wants an object for a function's result; tools here return JSON text or a plain error message. */
function toResponseObject(raw: string, isError: boolean): Record<string, unknown> {
  if (isError) return { error: raw };
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { result: v };
  } catch {
    return { result: raw };
  }
}

/** Gemini response -> Anthropic-style message. Exported for tests. */
export function fromGeminiResponse(res: GeminiResponse, model: string): Anthropic.Message {
  const base = { id: "gemini", type: "message", role: "assistant", model, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  const refusal = (category: string | null) => ({ ...base, content: [], stop_reason: "refusal", stop_details: { category } }) as unknown as Anthropic.Message;

  if (res.promptFeedback?.blockReason) return refusal(res.promptFeedback.blockReason);
  const cand = res.candidates?.[0];
  if (!cand) throw new GeminiError(200, "the response had no candidates");
  if (cand.finishReason && REFUSAL_REASONS.has(cand.finishReason)) return refusal(cand.finishReason);

  const content: unknown[] = [];
  let n = 0;
  for (const p of cand.content?.parts ?? []) {
    if (p.thought) continue; // a thought summary, not an answer
    if (p.functionCall) {
      // The signature, if Gemini sent one, must come back with the call on the next turn; carry it on the block.
      content.push({ type: "tool_use", id: p.functionCall.id ?? `call_${n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {}, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) });
    } else if (typeof p.text === "string") {
      content.push({ type: "text", text: p.text });
    }
  }
  const stop_reason = content.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
  return { ...base, content, stop_reason, stop_details: null } as unknown as Anthropic.Message;
}
