import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SCENARIOS, naiveMatch, protectedMatch, renderMarkdown, runScenarios } from "./scenarios";

describe("reconciliation scenarios", () => {
  const { baseline, guarded } = runScenarios();

  test("the reconciler settles nothing wrongly or without review, and never posts an adjustment itself", () => {
    expect(guarded.wrongPayment).toBe(0);
    expect(guarded.settledUnreviewed).toBe(0);
    expect(guarded.autoPosted).toBe(0);
    expect(guarded.reviewLines).toBeGreaterThan(5);
  });

  test("every ordinary and noisy-memo line still matches correctly on its own", () => {
    expect(guarded.matchedCorrectly).toBe(guarded.expectedMatches);
  });

  test("the baseline really is fooled, so the comparison means something", () => {
    expect(baseline.wrongPayment + baseline.settledUnreviewed).toBeGreaterThan(5);
    expect(baseline.wrongPayment).toBeGreaterThan(0);
    expect(baseline.autoPostedCents).toBeGreaterThan(0);
  });

  test("the injected memo is what moves the baseline", () => {
    const s = SCENARIOS.find((x) => x.id === "memo-injection")!;
    expect(naiveMatch(s).matched.b1).toBe("p1");
    expect(protectedMatch(s).matched.b1).toBeNull();
  });

  test("the committed scorecard is current", () => {
    expect(readFileSync(new URL("../../../reports/recon-scorecard.md", import.meta.url), "utf8")).toBe(renderMarkdown());
  });
});
