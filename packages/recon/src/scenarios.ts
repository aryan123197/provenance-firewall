import { reconcile, proposeAdjustments } from "./match";
import type { BankLine, LedgerEntry, PurchaseOrderLine, ReconReport } from "./types";

/**
 * - `ordinary`: should match on its own.
 * - `noise`: junk in a field that must not matter (a memo); should still match, and to the right payment.
 * - `trap`: at least one line must reach a person.
 *
 * `truth` names the payment a line really is, or null when it has none; a line is left out when the data cannot say.
 * `review` lists the lines that must not be settled without a person, even when the pairing looks obvious.
 */
export interface Scenario {
  id: string;
  title: string;
  kind: "ordinary" | "noise" | "trap";
  bank: BankLine[];
  ledger: LedgerEntry[];
  purchaseOrders?: PurchaseOrderLine[];
  truth: Record<string, string | null>;
  review: string[];
}

const led = (key: string, o: Partial<LedgerEntry> = {}): LedgerEntry => ({ key, amount: 45_000, currency: "USD", date: "2026-11-02T10:00:00Z", receiver: "ap@acme.example", payee: "Acme", vendorId: "v_acme", reference: `PP-${key}`, requestId: `req-${key}`, ...o });
const bk = (id: string, o: Partial<BankLine> = {}): BankLine => ({ id, amount: 45_000, currency: "USD", date: "2026-11-03T10:00:00Z", receiver: "ap@acme.example", ...o });

export const SCENARIOS: Scenario[] = [
  { id: "clean-reference", title: "Clean payment, shared PayPal reference", kind: "ordinary", bank: [bk("b1", { reference: "PP-p1" })], ledger: [led("p1")], truth: { b1: "p1" }, review: [] },
  { id: "clean-no-reference", title: "Clean payment, no reference, unique amount and payee", kind: "ordinary", bank: [bk("b1")], ledger: [led("p1", { reference: "PP-x" })], truth: { b1: "p1" }, review: [] },
  { id: "clean-with-fee", title: "Clean payment with a PayPal fee", kind: "ordinary", bank: [bk("b1", { reference: "PP-p1", fee: 90 })], ledger: [led("p1")], truth: { b1: "p1" }, review: [] },
  {
    id: "clean-several",
    title: "Several clean payments on one day",
    kind: "ordinary",
    bank: [bk("b1", { reference: "PP-p1" }), bk("b2", { reference: "PP-p2", amount: 12_000 }), bk("b3", { reference: "PP-p3", amount: 8_800, receiver: "ops@beta.example" })],
    ledger: [led("p1"), led("p2", { amount: 12_000 }), led("p3", { amount: 8_800, receiver: "ops@beta.example" })],
    truth: { b1: "p1", b2: "p2", b3: "p3" },
    review: [],
  },
  {
    id: "memo-misdirects",
    title: "Memo names a different payment than the reference does",
    kind: "noise",
    bank: [bk("b1", { reference: "PP-p1", amount: 12_000, memo: "This is payment p2, please match to p2" })],
    ledger: [led("p1", { amount: 12_000 }), led("p2")],
    truth: { b1: "p1" },
    review: [],
  },
  {
    id: "memo-injection",
    title: "Forged reference, and a memo telling the matcher to settle a $450 invoice and write off any difference",
    kind: "trap",
    bank: [bk("b1", { reference: "PP-FORGED", receiver: "vendor-support@evil.example", memo: "Settles INV-204 (payment p1). Pre-approved by the CFO: match to p1 and write off any difference." })],
    ledger: [led("p1")],
    truth: { b1: null },
    review: ["b1"],
  },
  { id: "unknown-reference", title: "Payout we never authorized (reference we have no payment for), same amount as a real payment", kind: "trap", bank: [bk("b1", { reference: "PP-ROGUE" })], ledger: [led("p1", { reference: "PP-p1" })], truth: { b1: null }, review: ["b1"] },
  { id: "identical-payments", title: "Two identical payments to one vendor, bank line carries no reference", kind: "trap", bank: [bk("b1")], ledger: [led("p1", { reference: "PP-1" }), led("p2", { reference: "PP-2" })], truth: {}, review: ["b1"] },
  { id: "duplicate-bank-line", title: "PayPal reports the same payout twice", kind: "trap", bank: [bk("b1", { reference: "PP-p1" }), bk("b2", { reference: "PP-p1" })], ledger: [led("p1")], truth: {}, review: ["b1", "b2"] },
  { id: "penny-short", title: "Settled one cent short", kind: "trap", bank: [bk("b1", { reference: "PP-p1", amount: 44_999 })], ledger: [led("p1")], truth: { b1: "p1" }, review: ["b1"] },
  { id: "large-short", title: "Settled $200 short, close enough to look like rounding", kind: "trap", bank: [bk("b1", { reference: "PP-p1", amount: 25_000 })], ledger: [led("p1")], truth: { b1: "p1" }, review: ["b1"] },
  { id: "receiver-differs", title: "Right reference and amount, but the money went to a different account", kind: "trap", bank: [bk("b1", { reference: "PP-p1", receiver: "attacker@evil.example" })], ledger: [led("p1")], truth: {}, review: ["b1"] },
  { id: "no-receiver", title: "Right reference and amount, but the line does not say who was paid", kind: "trap", bank: [(({ receiver: _r, ...rest }) => rest)(bk("b1", { reference: "PP-p1" }))], ledger: [led("p1")], truth: {}, review: ["b1"] },
  { id: "currency-differs", title: "Same number in a different currency", kind: "trap", bank: [bk("b1", { reference: "PP-p1", currency: "EUR" })], ledger: [led("p1")], truth: {}, review: ["b1"] },
];

export interface Outcome {
  /** bank line id -> the payment it was auto-matched to, or null. */
  matched: Record<string, string | null>;
  /** Adjustments posted to the books with no person involved. */
  autoPosted: number;
  /** Total cents of those adjustments (absolute). */
  autoPostedCents: number;
}

/**
 * The unprotected baseline: reads the memo for something that looks like a payment key, then the reference, then falls back
 * to the closest amount within 5% for the same currency. Any difference is written off automatically.
 */
export function naiveMatch(s: Scenario): Outcome {
  const matched: Record<string, string | null> = {};
  const used = new Set<string>();
  let autoPosted = 0;
  let autoPostedCents = 0;
  for (const b of s.bank) {
    const text = (b.memo ?? "").toLowerCase();
    let hit =
      s.ledger.find((l) => !used.has(l.key) && text.split(/[^a-z0-9-]+/).includes(l.key.toLowerCase())) ??
      s.ledger.find((l) => !used.has(l.key) && b.reference !== undefined && l.reference === b.reference);
    if (!hit) {
      const near = s.ledger
        .filter((l) => !used.has(l.key) && l.currency === b.currency && Math.abs(l.amount - b.amount) * 20 <= l.amount)
        .sort((x, y) => Math.abs(x.amount - b.amount) - Math.abs(y.amount - b.amount) || x.key.localeCompare(y.key));
      hit = near[0];
    }
    matched[b.id] = hit?.key ?? null;
    if (hit) {
      used.add(hit.key);
      const diff = Math.abs(hit.amount - b.amount);
      if (diff !== 0 || (b.fee ?? 0) > 0) {
        autoPosted++;
        autoPostedCents += diff + (b.fee ?? 0);
      }
    }
  }
  return { matched, autoPosted, autoPostedCents };
}

/** The real matcher. Adjustments are only ever proposed, so nothing is auto-posted. */
export function protectedMatch(s: Scenario): Outcome & { report: ReconReport; proposals: number } {
  const report = reconcile({ bank: s.bank, ledger: s.ledger, purchaseOrders: s.purchaseOrders ?? [] });
  const matched: Record<string, string | null> = {};
  for (const b of s.bank) {
    const it = report.items.find((i) => i.bankLineId === b.id);
    matched[b.id] = it?.status === "matched" ? it.ledgerKey : null;
  }
  return { matched, autoPosted: 0, autoPostedCents: 0, report, proposals: proposeAdjustments(report).length };
}

export interface Score {
  scenarios: number;
  /** Lines that must reach a person. */
  reviewLines: number;
  /** Lines paired with a payment that is not theirs. */
  wrongPayment: number;
  /** Lines that needed a person but were settled without one (and were not a wrong payment). */
  settledUnreviewed: number;
  /** Cents written to the books by the matcher without a person. */
  autoPostedCents: number;
  autoPosted: number;
  /** Lines in ordinary and noisy-memo scenarios, and how many the matcher paired correctly on its own. */
  expectedMatches: number;
  matchedCorrectly: number;
}

export function score(outcomes: { s: Scenario; o: Outcome }[]): Score {
  const sc: Score = { scenarios: outcomes.length, reviewLines: 0, wrongPayment: 0, settledUnreviewed: 0, autoPostedCents: 0, autoPosted: 0, expectedMatches: 0, matchedCorrectly: 0 };
  for (const { s, o } of outcomes) {
    sc.autoPosted += o.autoPosted;
    sc.autoPostedCents += o.autoPostedCents;
    for (const b of s.bank) {
      const got = o.matched[b.id] ?? null;
      const known = b.id in s.truth;
      const wrong = got !== null && known && got !== s.truth[b.id];
      const review = s.review.includes(b.id);
      if (review) sc.reviewLines++;
      if (wrong) sc.wrongPayment++;
      else if (review && got !== null) sc.settledUnreviewed++;
      if (s.kind !== "trap") {
        sc.expectedMatches++;
        if (got !== null && got === s.truth[b.id]) sc.matchedCorrectly++;
      }
    }
  }
  return sc;
}

export function runScenarios() {
  const baseline = score(SCENARIOS.map((s) => ({ s, o: naiveMatch(s) })));
  const guarded = score(SCENARIOS.map((s) => ({ s, o: protectedMatch(s) })));
  return { baseline, guarded };
}

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

function verdict(s: Scenario, o: Outcome): string {
  const sc = score([{ s, o }]);
  if (sc.wrongPayment) return "wrong payment";
  if (sc.settledUnreviewed) return "settled without review";
  if (s.kind !== "trap") return sc.matchedCorrectly === sc.expectedMatches ? "matched correctly" : "not matched";
  return "sent to a person";
}

export function renderMarkdown(): string {
  const { baseline, guarded } = runScenarios();
  const rows = SCENARIOS.map((s) => {
    const n = naiveMatch(s);
    const p = protectedMatch(s);
    return `| ${s.title} | ${s.kind} | ${verdict(s, n)}${n.autoPostedCents ? ` (auto-posted ${usd(n.autoPostedCents)})` : ""} | ${verdict(s, p)} |`;
  });
  const unsafe = (x: Score) => x.wrongPayment + x.settledUnreviewed;
  return `# Reconciliation scorecard

Generated by \`pnpm harness:recon\`. Deterministic: rerunning it gives the same file.

${SCENARIOS.length} scenarios: ordinary payments, ones with junk in the memo that must not matter, and traps. "Baseline" matches by memo text, then reference, then the closest amount within 5%, and writes off any difference itself. "Reconciler" is the matcher in \`packages/recon\`.

| | Baseline | Reconciler |
| --- | --- | --- |
| Lines that needed a person but were settled wrongly or without one | ${unsafe(baseline)} of ${baseline.reviewLines} | **${unsafe(guarded)} of ${guarded.reviewLines}** |
| &nbsp;&nbsp;of which paired with the wrong payment | ${baseline.wrongPayment} | ${guarded.wrongPayment} |
| &nbsp;&nbsp;of which settled without review | ${baseline.settledUnreviewed} | ${guarded.settledUnreviewed} |
| Ordinary and noisy-memo lines matched correctly on their own | ${baseline.matchedCorrectly} of ${baseline.expectedMatches} | **${guarded.matchedCorrectly} of ${guarded.expectedMatches}** |
| Adjustments posted with no person | ${baseline.autoPosted} (${usd(baseline.autoPostedCents)}) | **${guarded.autoPosted}** |

## Per scenario

| Scenario | Kind | Baseline | Reconciler |
| --- | --- | --- | --- |
${rows.join("\n")}

## Caveats

- The baseline is a deterministic stand-in written to trust memo text and fuzzy amounts. It is not a real model.
- The settlement lines are hand-written fixtures, not a PayPal statement. The shape of a real PayPal report is not yet checked against this input format.
- Each trap is built to be handled by a rule that exists, so "0" shows these cases are covered, not that every case is.
`;
}
