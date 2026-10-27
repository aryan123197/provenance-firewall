import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GullibleAgent,
  runBaseline,
  runOnFirewall,
  SCENARIOS,
  scoreRun,
  type Agent,
  type PayCall,
  type RunResult,
  type Scenario,
  type SideScore,
} from "@pfw/harness";
import { LlmBudgetError, LlmRefusalError } from "@pfw/llm";
import type { Runtime } from "./app";

/** Runs one scenario on both sides, one at a time. Shared by the HTTP route and the Slack input so they never overlap. */
export interface DemoRunner {
  run(scenario: Scenario, agent: Agent): Promise<DemoOutcome>;
}

type Payout = { receiver: string; amount: number; currency: string };

export interface DemoOutcome {
  agent: string;
  agentKind: "scripted" | "llm";
  scenario: { id: string; title: string; description: string; kind: "attack" | "legit"; request: string; category: string };
  baseline: { score: SideScore; calls: PayCall[]; payouts: Payout[] };
  firewalled: { score: SideScore; calls: PayCall[]; payouts: Payout[]; pendingApprovals: number };
}

export interface DemoDeps {
  runtime: () => Runtime;
  /** Swap in a fresh database, so daily caps and velocity start clean. Absent when resets are not allowed. */
  reset?: () => void;
  /** A live Claude agent, when an API key is configured. Chosen per run with `agent: "llm"`. */
  llmAgent?: Agent;
}

/**
 * Demo routes (running a scenario moves money through the live firewall, and reset wipes history, so both need the operator token
 * unless the server is in open demo mode): run a harness scenario against the unprotected baseline (simulated PayPal, so no real money can move)
 * and against this server's live firewall, side by side. Approvals stay pending for a person to act on in the inbox.
 */
export function registerDemo(app: FastifyInstance, deps: DemoDeps, guard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): DemoRunner {
  let runCount = 0;
  let busy: Promise<unknown> = Promise.resolve();

  const runDemo = (scenario: Scenario, agent: Agent): Promise<DemoOutcome> => {
    const job = busy.then(async () => {
      const prefix = `demo${++runCount}-`;
      const baseline = await runBaseline(scenario, agent);
      const { store, firewall } = deps.runtime();
      const live = await runOnFirewall(scenario, agent, { store, firewall, keyPrefix: prefix });
      const firewalled: RunResult = {
        side: "firewalled",
        payouts: live.receipts.map((r) => ({ batchId: r.reference, receiver: r.receiver, amount: r.amount, currency: r.currency, requestId: r.requestId })),
        calls: live.calls,
        approvedKeys: live.approvedKeys,
        pendingApprovals: live.pendingApprovals,
      };
      return {
        agent: agent.name,
        agentKind: agent.kind ?? "scripted",
        scenario: { id: scenario.id, title: scenario.title, description: scenario.description, kind: scenario.kind, request: scenario.request, category: scenario.category },
        baseline: { score: scoreRun(scenario, baseline), calls: baseline.calls, payouts: baseline.payouts },
        firewalled: { score: scoreRun(scenario, firewalled), calls: live.calls, payouts: firewalled.payouts, pendingApprovals: live.pendingApprovals },
      };
    });
    busy = job.catch(() => undefined);
    return job;
  };

  app.get("/api/demo/scenarios", async () => ({
    scenarios: SCENARIOS.map((s) => ({ id: s.id, category: s.category, kind: s.kind, title: s.title, description: s.description, request: s.request })),
  }));

  app.post<{ Body: { scenarioId?: string; agent?: "scripted" | "llm"; request?: string } }>("/api/demo/run", { preHandler: guard }, async (req, reply) => {
    const found = SCENARIOS.find((s) => s.id === req.body?.scenarioId);
    if (!found) return reply.code(404).send({ error: "unknown scenario" });
    if (req.body?.agent === "llm" && !deps.llmAgent) return reply.code(503).send({ error: "A live Claude agent needs a Claude API key (ANTHROPIC_API_KEY) on the server." });
    const agent = req.body?.agent === "llm" ? deps.llmAgent! : new GullibleAgent();
    // A custom request only changes what the user said; the documents and registry stay the scenario's.
    const custom = typeof req.body?.request === "string" ? req.body.request.trim().slice(0, 500) : "";
    const scenario = custom ? { ...found, request: custom } : found;

    const job = runDemo(scenario, agent);
    try {
      return await job;
    } catch (e) {
      if (e instanceof LlmBudgetError) return reply.code(429).send({ error: e.message });
      if (e instanceof LlmRefusalError) return reply.code(422).send({ error: e.message });
      if (req.body?.agent === "llm") return reply.code(502).send({ error: `The Claude agent failed: ${e instanceof Error ? e.message : String(e)}` });
      throw e;
    }
  });

  // Shows reconciliation without a live PayPal: report a payment we never authorized, or one that differs from what was authorized.
  let simSeq = 0;
  app.post<{ Body: { kind?: "unauthorized" | "mismatch" } }>("/api/demo/simulate-drift", { preHandler: guard }, async (req, reply) => {
    const { store } = deps.runtime();
    const id = `sim-${Date.now().toString(36)}-${++simSeq}`;
    if (req.body?.kind === "mismatch") {
      const paid = store.listDecisions({ limit: 200 }).find((d) => d.execution === "executed");
      const exec = paid ? store.getExecution(paid.idempotencyKey) : null;
      if (!paid || !exec?.reference) return reply.code(409).send({ error: "Run a scenario that pays something first, then report a different amount for it." });
      return store.recordProviderEvent({ id, type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", reference: exec.reference, status: "success", amount: paid.amount * 10, currency: paid.currency, receiver: "attacker@evil.example" });
    }
    return store.recordProviderEvent({ id, type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", reference: `SIMBATCH${id.toUpperCase().replace(/[^A-Z0-9]/g, "")}`, status: "success", amount: 99_900, currency: "USD", receiver: "vendor-support@evil.example" });
  });

  if (deps.reset) {
    app.post("/api/demo/reset", { preHandler: guard }, async () => {
      await busy;
      deps.reset!();
      runCount = 0;
      return { ok: true };
    });
  }

  return { run: runDemo };
}
