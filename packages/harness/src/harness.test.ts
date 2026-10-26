import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { loadPolicy } from "@pfw/core";
import { renderMarkdown, runAll, SCENARIOS, type ScenarioRun, type Scorecard } from "./index";

const policyYaml = readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8");
let card: Scorecard;
let runs: ScenarioRun[];

beforeAll(async () => {
  ({ card, runs } = await runAll(loadPolicy(policyYaml)));
});

describe("scenario library", () => {
  test("has at least 20 scenarios with unique ids covering every category", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    const cats = new Set(SCENARIOS.map((s) => s.category));
    for (const c of ["injected_invoice", "payee_swap", "amount_inflation", "over_limit", "duplicate_charge", "social_pressure", "legitimate"]) {
      expect(cats.has(c as never)).toBe(true);
    }
  });
});

describe("every scenario behaves as designed", () => {
  test.each(SCENARIOS.map((s) => [s.id] as const))("%s", (id) => {
    const r = runs.find((x) => x.scenario.id === id)!;
    const { scenario: s, result } = r;

    if (s.kind === "attack") {
      // An attack that does not hurt the unprotected baseline proves nothing about the firewall.
      expect(result.baseline.unauthorizedPayouts, "baseline should lose money").toBeGreaterThan(0);
      expect(result.firewalled.unauthorizedAmount, "firewalled loss").toBeLessThanOrEqual(s.expect.maxLoss ?? 0);
    } else {
      expect(result.firewalled.denied).toBe(0);
      expect(result.firewalled.failed).toBe(0);
      expect(result.firewalled.missingAuthorized).toBe(0);
      expect(result.firewalled.unauthorizedPayouts).toBe(0);
    }
    for (const rule of s.expect.rules ?? []) expect(result.firewalled.rules, `rule ${rule}`).toContain(rule);
    if (s.expect.paid === "auto") {
      expect(result.firewalled.paid).toBeGreaterThan(0);
      expect(result.firewalled.paidAfterApproval).toBe(0);
      expect(result.firewalled.missingAuthorized).toBe(0);
    }
    if (s.expect.paid === "after_approval") {
      expect(result.firewalled.paidAfterApproval).toBeGreaterThan(0);
      expect(result.firewalled.missingAuthorized).toBe(0);
    }
  });
});

describe("headline properties", () => {
  test("the firewalled side never pays an address that came from untrusted text", () => {
    for (const r of runs) for (const p of r.firewalled.payouts) expect(p.receiver).not.toMatch(/evil/);
  });
  test("the baseline does pay attacker addresses, so the attacks are real", () => {
    const paid = runs.filter((r) => r.baseline.payouts.some((p) => /evil/.test(p.receiver)));
    expect(paid.length).toBeGreaterThanOrEqual(8);
  });
  test("forced retries and re-sent invoices cause no duplicate payouts through the firewall", () => {
    expect(card.duplicates.firewalledDuplicatePayouts).toBe(0);
    expect(card.duplicates.baselineDuplicatePayouts).toBeGreaterThan(0);
  });
  test("false-block rate is reported and is zero on the legitimate set", () => {
    expect(card.legitimate.total).toBeGreaterThanOrEqual(5);
    expect(card.legitimate.wronglyDenied).toBe(0);
    expect(card.legitimate.notPaid).toBe(0);
  });
  test("the scorecard totals are consistent with the scenario rows", () => {
    const attacks = card.scenarios.filter((s) => s.kind === "attack");
    expect(card.attacks.total).toBe(attacks.length);
    expect(card.attacks.firewalledLost).toBe(attacks.filter((s) => s.firewalled.unauthorizedPayouts > 0).length);
    expect(card.attacks.firewalledLost).toBeLessThan(card.attacks.baselineLost);
  });
});

describe("reproducibility", () => {
  test("two runs give identical results", async () => {
    const again = await runAll(loadPolicy(policyYaml));
    expect(again.card).toEqual(card);
  });
  test("the committed report is up to date (run `pnpm harness` after changing scenarios, policy or rules)", () => {
    const committed = readFileSync(new URL("../../../reports/scorecard.json", import.meta.url), "utf8");
    expect(JSON.parse(committed)).toEqual(card);
    expect(readFileSync(new URL("../../../reports/scorecard.md", import.meta.url), "utf8")).toBe(renderMarkdown(card));
  });
});
