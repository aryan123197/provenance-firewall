import Anthropic from "@anthropic-ai/sdk";

/** The slice of the SDK these modules use, so tests can pass a fake. */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

/** The model both features default to. Override with PFW_MODEL. */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const modelFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.PFW_MODEL ?? DEFAULT_MODEL;

/**
 * Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile); nothing is read from or
 * written to the repository. Returns undefined when no API key is set, so callers can say what is missing.
 */
export function createClient(env: NodeJS.ProcessEnv = process.env): MessagesClient | undefined {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return undefined;
  return new Anthropic();
}

export class LlmRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`the model declined this request${category ? ` (${category})` : ""}`);
    this.name = "LlmRefusalError";
  }
}
