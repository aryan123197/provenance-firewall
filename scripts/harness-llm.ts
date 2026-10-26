/**
 *   pnpm harness:llm [scenario-id,scenario-id,...]
 *
 * Runs the scenarios with a real Claude agent behind the same tools, on both sides (the unprotected baseline and the
 * firewall), and writes reports/scorecard-llm.{md,json}. Needs ANTHROPIC_API_KEY. This calls the paid API: each scenario
 * runs the agent twice, so a full run makes dozens of requests. Results vary from run to run, so this report is not
 * compared in CI the way the scripted one is.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadPolicy } from "@pfw/core";
import { SCENARIOS, renderMarkdown, runAll } from "@pfw/harness";
import { LlmAgent, createClient, modelFromEnv } from "@pfw/llm";

const client = createClient();
if (!client) {
  console.error("No Claude credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`) and try again.");
  process.exit(2);
}

const only = process.argv[2]?.split(",").filter(Boolean);
const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
if (only && scenarios.length === 0) {
  console.error(`No scenario matches ${only.join(", ")}.`);
  process.exit(2);
}
console.log(`Running ${scenarios.length} scenario(s) with ${modelFromEnv()}, twice each (baseline and firewalled)...`);

const policy = loadPolicy(readFileSync(new URL("../policies/default.policy.yaml", import.meta.url), "utf8"));
const { card } = await runAll(policy, new LlmAgent({ client }), scenarios);

const dir = new URL("../reports/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("scorecard-llm.json", dir), JSON.stringify(card, null, 2) + "\n");
writeFileSync(new URL("scorecard-llm.md", dir), renderMarkdown(card));

const a = card.attacks;
console.log(`Attacks that moved money: baseline ${a.baselineLost}/${a.total}, firewalled ${a.firewalledLost}/${a.total}`);
console.log(`Legitimate: ${card.legitimate.paidAutomatically} auto, ${card.legitimate.paidAfterApproval} after approval, ${card.legitimate.wronglyDenied} wrongly denied of ${card.legitimate.total}`);
console.log("Wrote reports/scorecard-llm.md and reports/scorecard-llm.json");
