import { describe, expect, test } from "vitest";
import { renderReport, type ReportData } from "./report";

const HOSTILE = `<img src=x onerror=alert(1)> | [click](javascript:alert(2)) \`rm -rf\` *bold* "q" 'a' & \n# heading`;

const data = (over: Partial<ReportData> = {}): ReportData => ({
  generatedAt: "2026-11-10T12:00:00.000Z",
  mode: "simulated",
  policy: { name: "default", version: 3, hash: "abc123", currency: "USD" },
  audit: { ok: true, count: 14, head: { seq: 14, hash: "deadbeef" } },
  overview: {
    generatedAt: "2026-11-10T12:00:00.000Z",
    totals: [
      { currency: "USD", status: "paid", count: 2, amount: 90000 },
      { currency: "USD", status: "held", count: 1, amount: 80000 },
      { currency: "USD", status: "denied", count: 2, amount: 90000 },
      { currency: "EUR", status: "paid", count: 1, amount: 5000 },
    ],
    byDay: [],
    byVendor: [
      { vendorId: "acme", name: "Acme Supplies", currency: "USD", payments: 2, spent: 90000, held: 0, blocked: 0 },
      { vendorId: null, name: HOSTILE, currency: "USD", payments: 0, spent: 0, held: 0, blocked: 45000 },
    ],
    moneyProtected: [{ currency: "USD", count: 2, amount: 90000 }],
    openCommitments: [{ id: "po1", vendorId: "acme", amount: 45000, currency: "USD", status: "open", vendorName: "Acme Supplies" }],
    needsAttention: [{ idempotencyKey: "k", createdAt: "2026-11-10T10:00:00.000Z", agentId: "a", payee: HOSTILE, account: "x", vendorId: null, amount: 1200, currency: "USD", verdict: "allow", rule: "default_allow", status: "attention", providerStatus: "unclaimed" }],
    budgets: [],
  },
  digest: {
    generatedAt: "2026-11-10T12:00:00.000Z",
    day: "2026-11-10",
    today: [],
    pendingApprovals: { count: 1, oldestRequestedAt: "2026-11-10T09:00:00.000Z" },
    attention: 1,
    budgets: [{ vendorId: "acme", name: "Acme Supplies", budget: 40000, spent: 45000, percent: 113, state: "over" }],
    needsAttention: true,
  },
  blockedByRule: [
    { rule: "payee_change", currency: "USD", count: 1, amount: 45000 },
    { rule: "untrusted_payee", currency: "USD", count: 1, amount: 45000 },
  ],
  ...over,
});

describe("spend report", () => {
  const { markdown, html } = renderReport(data());

  test("has every section, with numbers that match the overview, in both formats", () => {
    for (const heading of ["Integrity", "Spend by status", "Money protected", "By payee", "Monthly budgets", "Open purchase orders", "Needs attention"]) {
      expect(markdown).toContain(`## ${heading}`);
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    for (const text of ["14 entries", "deadbeef", "default v3", "$900.00", "$800.00", "50.00 EUR", "payee\\_change", "113%", "Acme Supplies"]) {
      expect(markdown).toContain(text.replace("payee_change", "payee\\_change"));
    }
    expect(html).toContain("payee_change");
    expect(html).toContain("$450.00");
    expect(html).toContain("simulated PayPal, no real money");
  });

  test("currencies get their own table and are never added together", () => {
    expect(markdown).toContain(String.raw`USD \(currencies are never added together\)`);
    expect(markdown).toContain(String.raw`EUR \(currencies are never added together\)`);
    expect(markdown).not.toContain("$950.00");
  });

  test("a hostile payee name cannot become markup, a link, a table cell break or a script", () => {
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markdown).not.toContain("<img");
    expect(markdown).toContain("&lt;img");
    expect(markdown).not.toMatch(/\]\(javascript:/);
    expect(markdown).toContain("\\[click\\]\\(javascript:alert\\(2\\)\\)");
    // Every table row keeps its column count: the "|" in the name is escaped and the newline is flattened.
    const rows = markdown.split("\n").filter((l) => l.startsWith("| ") && l.includes("not in registry"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.split(/(?<!\\)\|/).length).toBe(9);
    expect(markdown).not.toMatch(/^# heading/m);
  });

  test("a broken audit chain is stated plainly", () => {
    const r = renderReport(data({ audit: { ok: false, seq: 7, reason: "hash mismatch" } }));
    expect(r.markdown).toContain("does NOT verify");
    expect(r.markdown).toContain("entry 7");
    expect(r.html).toContain("Treat everything below as unverified.");
  });

  test("an empty store still reads sensibly", () => {
    const empty = data({
      overview: { ...data().overview, totals: [], byVendor: [], moneyProtected: [], openCommitments: [], needsAttention: [] },
      digest: { ...data().digest, budgets: [], pendingApprovals: { count: 0, oldestRequestedAt: null }, attention: 0, needsAttention: false },
      blockedByRule: [],
    });
    const r = renderReport(empty).markdown;
    expect(r).toContain("No payments have been decided yet.");
    expect(r).toContain("Nothing has been denied or rejected.");
    expect(r).toContain("No budgets are set.");
    expect(r).toContain("Nothing needs a person.");
  });

  test("long lists are capped and say where the full list is", () => {
    const many = Array.from({ length: 60 }, (_, n) => ({ vendorId: null, name: `V${n}`, currency: "USD", payments: 0, spent: 0, held: 0, blocked: n }));
    const r = renderReport(data({ overview: { ...data().overview, byVendor: many } })).markdown;
    expect(r).toContain("Showing the first 50 of 60. The CSV ledger has every row.");
    expect(r).toContain("V49");
    expect(r).not.toContain("V50");
  });

  test("the same data always gives the same report", () => {
    expect(renderReport(data())).toEqual(renderReport(data()));
  });
});
