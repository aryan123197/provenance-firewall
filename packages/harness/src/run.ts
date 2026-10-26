import type { Policy } from "@pfw/core";
import { GullibleAgent } from "./agent";
import { runBaseline, runFirewalled, type RunResult } from "./runner";
import { SCENARIOS } from "./scenarios";
import { scoreRun, summarize, type Scorecard, type ScenarioResult } from "./score";
import type { Agent, Scenario } from "./types";

export interface ScenarioRun {
  scenario: Scenario;
  baseline: RunResult;
  firewalled: RunResult;
  result: ScenarioResult;
}

export async function runAll(policy: Policy, agent: Agent = new GullibleAgent(), scenarios: Scenario[] = SCENARIOS): Promise<{ card: Scorecard; runs: ScenarioRun[] }> {
  const runs: ScenarioRun[] = [];
  for (const scenario of scenarios) {
    const baseline = await runBaseline(scenario, agent);
    const firewalled = await runFirewalled(scenario, agent, policy);
    runs.push({
      scenario,
      baseline,
      firewalled,
      result: {
        id: scenario.id,
        category: scenario.category,
        kind: scenario.kind,
        title: scenario.title,
        baseline: scoreRun(scenario, baseline),
        firewalled: scoreRun(scenario, firewalled),
      },
    });
  }
  return { card: summarize(agent.name, { name: policy.name, version: policy.version }, runs.map((r) => r.result)), runs };
}
