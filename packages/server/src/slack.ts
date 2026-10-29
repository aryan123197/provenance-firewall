import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SCENARIOS, GullibleAgent, type Agent, type Scenario } from "@pfw/harness";
import { LlmBudgetError, LlmRefusalError } from "@pfw/llm";
import type { DemoOutcome, DemoRunner } from "./demo";

/** Slack signs every request; anything older than this is treated as a replay. */
const MAX_AGE_SECONDS = 300;
const MAX_REQUEST_CHARS = 500;
const SEEN_LIMIT = 1000;

export interface SlackConfig {
  signingSecret: string;
  botToken: string;
  /** Slack user ids allowed to run scenarios. Empty means anyone in a channel the app is in. */
  allowedUsers: string[];
}

export interface SlackDeps {
  config: SlackConfig;
  runner: DemoRunner;
  llmAgent?: Agent;
  /** Test seam. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

/** Slack's `v0` request signature: HMAC-SHA256 over `v0:<timestamp>:<raw body>`. */
export function verifySlackSignature(secret: string, timestamp: string | undefined, signature: string | undefined, rawBody: string, nowMs = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export type Command = { kind: "help" } | { kind: "run"; scenario: Scenario; request: string };

/** `@bot <scenario-id> [what the user asks]`. The mention, any other `<@U...>` tokens and Slack's link markup are dropped. */
export function parseCommand(text: string): Command {
  const clean = text.replace(/<@[A-Z0-9]+>/g, " ").replace(/<([^|>]+)\|([^>]+)>/g, "$2").replace(/<([^>]+)>/g, "$1").trim();
  const [first = "", ...rest] = clean.split(/\s+/);
  const scenario = SCENARIOS.find((s) => s.id === first.toLowerCase());
  if (!scenario) return { kind: "help" };
  return { kind: "run", scenario, request: rest.join(" ").slice(0, MAX_REQUEST_CHARS).trim() };
}

const dollars = (minor: number) => `$${(minor / 100).toFixed(2)}`;

export function helpText(): string {
  const lines = SCENARIOS.map((s) => `• \`${s.id}\` (${s.kind === "attack" ? "attack" : "legitimate"}): ${s.title}`);
  return `Run a scenario with \`<scenario-id> [what the user asks]\`. The text after the id only changes what the user says, and only the live Claude agent reads it.\n${lines.join("\n")}`;
}

export function formatOutcome(o: DemoOutcome): string {
  const base = o.baseline.score;
  const fw = o.firewalled.score;
  const unprotected = base.unauthorizedPayouts ? `lost ${dollars(base.unauthorizedAmount)} to ${base.unauthorizedPayouts} unauthorized payout${base.unauthorizedPayouts === 1 ? "" : "s"}` : `paid ${base.paid}`;
  const firewalled = fw.unauthorizedPayouts ? `lost ${dollars(fw.unauthorizedAmount)}` : "lost nothing";
  const lines = [
    `*${o.scenario.title}* (${o.scenario.kind}; ${o.agentKind} agent \`${o.agent}\`)`,
    `Unprotected: ${unprotected}.`,
    `Firewalled: ${firewalled}. ${fw.summary}`,
  ];
  for (const c of o.firewalled.calls) lines.push(`• \`${c.key}\`: ${c.status}${c.rule ? ` (${c.rule})` : ""}: ${c.message}`);
  if (o.firewalled.pendingApprovals) lines.push(`${o.firewalled.pendingApprovals} payment${o.firewalled.pendingApprovals === 1 ? " is" : "s are"} waiting in the dashboard's approval inbox. Approving happens there, not in Slack.`);
  return lines.join("\n");
}

type SlackEvent = { type?: string; user?: string; text?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string; bot_id?: string; subtype?: string };
type Envelope = { type?: string; challenge?: string; event_id?: string; event?: SlackEvent };

/**
 * Slack Events API input: someone mentions the app (or direct-messages it) with a scenario id, the same scenario runner behind the
 * dashboard runs it against the live firewall, and the verdicts come back in a thread. Slack text is only ever a scenario id plus a
 * user request: it never supplies a payee, an account or an amount, and approving a held payment stays a dashboard action.
 */
export function registerSlack(app: FastifyInstance, deps: SlackDeps): void {
  const { config } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const seen = new Set<string>();

  const post = async (channel: string, threadTs: string | undefined, text: string) => {
    try {
      await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${config.botToken}` },
        body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false }),
      });
    } catch {
      /* Slack being unreachable must not take the firewall down; the dashboard still shows the run. */
    }
  };

  const handle = async (ev: SlackEvent) => {
    const channel = ev.channel!;
    const thread = ev.thread_ts ?? ev.ts;
    const cmd = parseCommand(ev.text ?? "");
    if (cmd.kind === "help") return post(channel, thread, helpText());
    const useLlm = Boolean(deps.llmAgent && cmd.request);
    const agent: Agent = useLlm ? deps.llmAgent! : new GullibleAgent();
    const scenario = cmd.request && useLlm ? { ...cmd.scenario, request: cmd.request } : cmd.scenario;
    try {
      const out = await deps.runner.run(scenario, agent);
      const note = cmd.request && !useLlm ? "\n(The scripted agent ignores the text after the id; a Claude API key on the server lets a live agent read it.)" : "";
      await post(channel, thread, formatOutcome(out) + note);
    } catch (e) {
      const msg = e instanceof LlmBudgetError || e instanceof LlmRefusalError ? e.message : "The run failed; see the server log.";
      await post(channel, thread, msg);
    }
  };

  app.post("/api/slack/events", async (req: FastifyRequest, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const h = req.headers;
    if (!verifySlackSignature(config.signingSecret, h["x-slack-request-timestamp"] as string | undefined, h["x-slack-signature"] as string | undefined, raw, now())) {
      return reply.code(401).send({ error: "bad signature" });
    }
    const body = (req.body ?? {}) as Envelope;
    if (body.type === "url_verification") {
      // Slack sends a string. Anything else is not a challenge to echo (and stringifying an arbitrary value can throw).
      if (typeof body.challenge !== "string") return reply.code(400).send({ error: "challenge must be a string" });
      return reply.send({ challenge: body.challenge });
    }
    if (body.type !== "event_callback" || !body.event) return reply.send({ ok: true });

    // Slack retries after 3 seconds if it has not seen a 200, and a run can take longer than that. Acknowledge first, work after.
    if (h["x-slack-retry-num"] !== undefined) return reply.send({ ok: true });
    if (body.event_id) {
      if (seen.has(body.event_id)) return reply.send({ ok: true });
      seen.add(body.event_id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    }

    const ev = body.event;
    const addressed = ev.type === "app_mention" || (ev.type === "message" && ev.channel_type === "im");
    // Ignore bots (including ourselves, which would loop) and edits, joins and other message subtypes.
    if (!addressed || ev.bot_id || ev.subtype || !ev.user || !ev.channel) return reply.send({ ok: true });
    if (config.allowedUsers.length && !config.allowedUsers.includes(ev.user)) return reply.send({ ok: true });

    handle(ev).catch(() => undefined);
    return reply.send({ ok: true });
  });
}
