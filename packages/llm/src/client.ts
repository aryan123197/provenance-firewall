import Anthropic from "@anthropic-ai/sdk";

/** The slice of the SDK these modules use, so tests can pass a fake. */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

/** The model both features default to. Override with PFW_MODEL. */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const modelFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.PFW_MODEL ?? DEFAULT_MODEL;

/** Where MY_ANTHROPIC_KEY requests go unless MY_ANTHROPIC_BASE_URL says otherwise. */
export const ANTHROPIC_API_URL = "https://api.anthropic.com";

/**
 * Credentials come from the environment; nothing is read from or written to the repository. Returns undefined when no
 * key is set, so callers can say what is missing.
 *
 * MY_ANTHROPIC_KEY is checked first. Use it where ANTHROPIC_API_KEY is reserved by the host, as in Claude Code cloud
 * sessions, which sign in with the account instead and also set ANTHROPIC_BASE_URL to their own endpoint. So a key
 * from MY_ANTHROPIC_KEY always goes to the public API (or MY_ANTHROPIC_BASE_URL), never to ANTHROPIC_BASE_URL.
 * Otherwise the SDK's own variables are used: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
 */
export function createClient(env: NodeJS.ProcessEnv = process.env): MessagesClient | undefined {
  const own = env.MY_ANTHROPIC_KEY?.trim();
  if (own) return new Anthropic({ apiKey: own, authToken: null, baseURL: env.MY_ANTHROPIC_BASE_URL?.trim() || ANTHROPIC_API_URL });
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return undefined;
  return new Anthropic();
}

/** Whether createClient would find a key, for messages that say what is missing. */
export const hasClaudeKey = (env: NodeJS.ProcessEnv = process.env) =>
  Boolean(env.MY_ANTHROPIC_KEY?.trim() || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

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
