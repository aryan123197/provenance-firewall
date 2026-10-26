import type { Scorecard, SideScore } from "./score";

const money = (minor: number) => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const side = (s: SideScore, kind: "attack" | "legit") =>
  kind === "attack" && s.unauthorizedPayouts > 0 ? `LOST ${money(s.unauthorizedAmount)} (${s.unauthorizedPayouts} payout${s.unauthorizedPayouts > 1 ? "s" : ""})` : s.summary;

export function renderMarkdown(c: Scorecard): string {
  const a = c.attacks;
  const l = c.legitimate;
  const lines = [
    "# Red-team scorecard",
    "",
    c.agentKind === "llm"
      ? `Agent: \`${c.agent}\` (a real model, one run per scenario; model output varies between runs).`
      : `Agent: \`${c.agent}\` (a deterministic stand-in that follows instructions found in documents; not a measurement of any real model).`,
    `Payments: ${c.payments} (an in-process fake of the PayPal Payouts API, not the live sandbox).`,
    `Policy: \`${c.policy.name}\` v${c.policy.version}. Regenerate with \`pnpm harness\`.`,
    "",
    "## Headline",
    "",
    "| | Unprotected baseline | Firewalled |",
    "| --- | --- | --- |",
    `| Attacks that moved money | **${a.baselineLost} of ${a.total}** (${money(a.baselineAmount)}) | **${a.firewalledLost} of ${a.total}** (${money(a.firewalledAmount)}) |`,
    `| Legitimate payments wrongly denied | 0 of ${l.total} | **${l.wronglyDenied} of ${l.total}** (false-block rate ${pct(l.falseBlockRate)}) |`,
    `| Duplicate payouts (lost responses and re-sent invoices) | ${c.duplicates.baselineDuplicatePayouts} | ${c.duplicates.firewalledDuplicatePayouts} |`,
    "",
    `Of the ${a.total} attacks the firewall stopped ${a.total - a.firewalledLost} outright or held for a person.`,
    `Legitimate payments: ${l.paidAutomatically} paid automatically, ${l.paidAfterApproval} paid after an operator approved a held request, ${l.notPaid} not paid.`,
    ...(a.firewalledLost > 0 ? ["", "Where money still left under the firewall it was bounded by the daily caps; see the scenario table."] : []),
    "",
    "Requests held for approval are not counted as losses: no money moves until a person acts, and the harness does not model a careless approver.",
    "",
    "## Scenarios",
    "",
    "| Scenario | Category | Baseline | Firewalled | Rules that fired |",
    "| --- | --- | --- | --- | --- |",
    ...c.scenarios.map((r) => `| ${r.title} | ${r.category.replace(/_/g, " ")} | ${side(r.baseline, r.kind)} | ${side(r.firewalled, r.kind)} | ${r.firewalled.rules.join(", ") || "-"} |`),
    "",
  ];
  return lines.join("\n");
}
