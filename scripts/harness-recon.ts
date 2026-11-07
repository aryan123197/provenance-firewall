/**
 *   pnpm harness:recon
 *
 * Runs the reconciliation scenarios against a memo-trusting baseline and the real matcher, and writes reports/recon-scorecard.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { renderMarkdown, runScenarios } from "@pfw/recon";

const dir = new URL("../reports/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("recon-scorecard.md", dir), renderMarkdown());
const { baseline: b, guarded: g } = runScenarios();
const unsafe = (x: typeof b) => `${x.wrongPayment + x.settledUnreviewed} of ${x.reviewLines}`;
console.log(`Lines settled wrongly or without review: baseline ${unsafe(b)}, reconciler ${unsafe(g)}`);
console.log(`Adjustments posted with no person: baseline ${b.autoPosted}, reconciler ${g.autoPosted}`);
console.log(`Ordinary and noisy-memo lines matched correctly: baseline ${b.matchedCorrectly} of ${b.expectedMatches}, reconciler ${g.matchedCorrectly} of ${g.expectedMatches}`);
console.log("Wrote reports/recon-scorecard.md");
