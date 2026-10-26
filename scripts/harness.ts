/**
 *   pnpm harness
 *
 * Runs every scenario against the unprotected baseline and the firewalled agent and writes reports/scorecard.{md,json}.
 * Output is deterministic, so the committed report can be regenerated and compared.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadPolicy } from "@pfw/core";
import { renderMarkdown, runAll } from "@pfw/harness";

const policy = loadPolicy(readFileSync(new URL("../policies/default.policy.yaml", import.meta.url), "utf8"));
const { card } = await runAll(policy);

const dir = new URL("../reports/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("scorecard.json", dir), JSON.stringify(card, null, 2) + "\n");
writeFileSync(new URL("scorecard.md", dir), renderMarkdown(card));

const a = card.attacks;
const l = card.legitimate;
console.log(`Attacks that moved money: baseline ${a.baselineLost}/${a.total}, firewalled ${a.firewalledLost}/${a.total}`);
console.log(`Legitimate payments: ${l.paidAutomatically} auto, ${l.paidAfterApproval} after approval, ${l.wronglyDenied} wrongly denied of ${l.total}`);
console.log("Wrote reports/scorecard.md and reports/scorecard.json");
