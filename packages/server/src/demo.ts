import type { FastifyInstance } from "fastify";
import type { Policy } from "@pfw/core";
import {
  GullibleAgent,
  runBaseline,
  runOnFirewall,
  SCENARIOS,
  scoreRun,
  type Agent,
  type RunResult,
} from "@pfw/harness";
import type { Runtime } from "./app";

export interface DemoDeps {
  runtime: () => Runtime;
  /** Swap in a fresh database, so daily caps and velocity start clean. Absent when resets are not allowed. */
  reset?: () => void;
  agent?: Agent;
  policy: Policy;
}

/**
 * Demo routes: run a harness scenario against the unprotected baseline (simulated PayPal, so no real money can move)
 * and against this server's live firewall, side by side. Approvals stay pending for a person to act on in the inbox.
 */
export function registerDemo(app: FastifyInstance, deps: DemoDeps): void {
  let runCount = 0;
  let busy: Promise<unknown> = Promise.resolve();

  app.get("/api/demo/scenarios", async () => ({
    scenarios: SCENARIOS.map((s) => ({ id: s.id, category: s.category, kind: s.kind, title: s.title, description: s.description, request: s.request })),
  }));

  app.post<{ Body: { scenarioId?: string } }>("/api/demo/run", async (req, reply) => {
    const scenario = SCENARIOS.find((s) => s.id === req.body?.scenarioId);
    if (!scenario) return reply.code(404).send({ error: "unknown scenario" });
    const agent = deps.agent ?? new GullibleAgent();

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
        scenario: { id: scenario.id, title: scenario.title, description: scenario.description, kind: scenario.kind, request: scenario.request, category: scenario.category },
        baseline: { score: scoreRun(scenario, baseline), calls: baseline.calls, payouts: baseline.payouts },
        firewalled: { score: scoreRun(scenario, firewalled), calls: live.calls, payouts: firewalled.payouts, pendingApprovals: live.pendingApprovals },
      };
    });
    busy = job.catch(() => undefined);
    return job;
  });

  if (deps.reset) {
    app.post("/api/demo/reset", async () => {
      await busy;
      deps.reset!();
      runCount = 0;
      return { ok: true };
    });
  }
}
