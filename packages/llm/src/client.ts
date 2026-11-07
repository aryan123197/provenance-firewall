import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "./gemini";

/** The slice of the SDK these modules use, so tests can pass a fake. */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

/** The model both features default to. Override with PFW_MODEL. */
export const DEFAULT_MODEL = "claude-opus-5-5";

const hasAnthropic = (env: NodeJS.ProcessEnv) => Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
const geminiKey = (env: NodeJS.ProcessEnv) => env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
/** A Gemini key is used only when no Anthropic credential is set, so adding one never changes an existing Claude setup. */
export const usesGemini = (env: NodeJS.ProcessEnv = process.env) => !hasAnthropic(env) && Boolean(geminiKey(env));

export const modelFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.PFW_MODEL ?? (usesGemini(env) ? DEFAULT_GEMINI_MODEL : DEFAULT_MODEL);

/**
 * Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile; failing that GEMINI_API_KEY or
 * GOOGLE_API_KEY for Google Gemini); nothing is read from or written to the repository. Returns undefined when no API key
 * is set, so callers can say what is missing.
 */
export function createClient(env: NodeJS.ProcessEnv = process.env): MessagesClient | undefined {
  if (hasAnthropic(env)) return new Anthropic();
  const key = geminiKey(env);
  return key ? new GeminiClient({ apiKey: key }) : undefined;
}

export class LlmRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`the model declined this request${category ? ` (${category})` : ""}`);
    this.name = "LlmRefusalError";
  }
}

export class LlmBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`the daily limit of ${limit} Claude API calls has been reached; try again tomorrow or raise LLM_DAILY_CALLS`);
    this.name = "LlmBudgetError";
  }
}

/**
 * Caps how many API calls this process makes per UTC day. A public demo with open operator access would otherwise let anyone
 * spend the owner's API budget through the policy compiler or the live agent. Counted in memory: a restart resets it, so it
 * bounds accidents and casual abuse, not a determined attacker who can restart the server.
 */
export function withDailyBudget(client: MessagesClient, maxCalls: number, now: () => Date = () => new Date()): MessagesClient & { used(): number } {
  let day = now().toISOString().slice(0, 10);
  let used = 0;
  return {
    used: () => used,
    messages: {
      async create(params) {
        const today = now().toISOString().slice(0, 10);
        if (today !== day) {
          day = today;
          used = 0;
        }
        if (used >= maxCalls) throw new LlmBudgetError(maxCalls);
        used++;
        return client.messages.create(params);
      },
    },
  };
}
