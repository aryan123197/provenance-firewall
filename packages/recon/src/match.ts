import { createHash } from "node:crypto";
import {
  DEFAULT_CONFIG,
  ReconInputError,
  type ApprovedAdjustment,
  type BankLine,
  type InvoiceLink,
  type LedgerEntry,
  type ProposedAdjustment,
  type PurchaseOrderLine,
  type ReasonCode,
  type ReconConfig,
  type ReconItem,
  type ReconReport,
  type Resolution,
  type Totals,
} from "./types";

export interface ReconInput {
  bank: readonly BankLine[];
  ledger: readonly LedgerEntry[];
  purchaseOrders: readonly PurchaseOrderLine[];
  resolutions?: readonly Resolution[];
  approved?: readonly ApprovedAdjustment[];
  config?: Partial<ReconConfig>;
}

type Method = "reference" | "amount_payee_date" | "operator";

const DAY_MS = 86_400_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const itemId = (bankLineId: string | null, ledgerKey: string | null) => `rc_${sha(`${bankLineId ?? "-"}|${ledgerKey ?? "-"}`).slice(0, 16)}`;
export const adjustmentId = (item: string, kind: string, amount: number) => `adj_${sha(`${item}|${kind}|${amount}`).slice(0, 16)}`;

const isMoney = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

function validate(input: ReconInput): void {
  const unique = (what: string, ids: string[]) => {
    if (new Set(ids).size !== ids.length) throw new ReconInputError(`duplicate ${what} id`);
  };
  unique("bank line", input.bank.map((b) => b.id));
  unique("ledger", input.ledger.map((l) => l.key));
  for (const x of [...input.bank, ...input.ledger]) {
    const name = "id" in x ? x.id : x.key;
    if (!isMoney(x.amount) || x.amount <= 0) throw new ReconInputError(`${name}: amount must be a positive whole number of cents`);
    if (!/^[A-Z]{3}$/.test(x.currency)) throw new ReconInputError(`${name}: currency must be a 3-letter code`);
    if (!Number.isFinite(Date.parse(x.date))) throw new ReconInputError(`${name}: date is not a valid ISO date`);
  }
  for (const b of input.bank) if (b.fee !== undefined && (!isMoney(b.fee) || b.fee < 0)) throw new ReconInputError(`${b.id}: fee must be a non-negative whole number of cents`);
}

function linkInvoice(l: LedgerEntry, pos: readonly PurchaseOrderLine[]): InvoiceLink {
  if (l.poId) {
    const po = pos.find((p) => p.id === l.poId);
    if (!po || po.amount !== l.amount || po.currency !== l.currency) return { status: "mismatch", poId: l.poId };
    return { status: "linked", poId: po.id };
  }
  if (!l.vendorId) return { status: "none" };
  const c = pos.filter((p) => p.vendorId === l.vendorId && p.amount === l.amount && p.currency === l.currency && p.status === "closed").map((p) => p.id);
  if (c.length === 1) return { status: "linked", poId: c[0]! };
  if (c.length > 1) return { status: "ambiguous", candidates: c.sort() };
  return { status: "none" };
}

const money = (n: number, cur: string) => `${n < 0 ? "-" : ""}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")} ${cur}`;

/**
 * Pairs PayPal's settlement lines with the payments the firewall executed, then ties each payment to its purchase order.
 *
 * A pure function of its inputs: no clock, no randomness, no model. Rules, strictest first:
 *   1. an operator's recorded confirmation;
 *   2. a shared PayPal reference or sender reference (a line that carries a reference we do not know is never matched on anything else);
 *   3. for lines with no reference: the same amount, currency and receiver within the date window, and only if exactly one
 *      ledger payment fits and no other bank line wants it.
 * Anything else is `ambiguous` (a person decides) or `unmatched`. The memo is never read.
 */
export function reconcile(input: ReconInput): ReconReport {
  validate(input);
  const cfg = { ...DEFAULT_CONFIG, ...input.config };
  const { bank, ledger } = input;
  const byKey = new Map(ledger.map((l) => [l.key, l]));
  const approved = new Set((input.approved ?? []).filter((a) => a.kind === "difference").map((a) => `${a.itemId}|${a.amount}`));

  const done = new Map<string, ReconItem>();
  const claimed = new Set<string>();
  const contested = new Set<string>();

  const make = (b: BankLine, l: LedgerEntry | null, status: ReconItem["status"], method: ReconItem["method"], reason: ReasonCode, explanation: string, candidates: string[] = []): ReconItem => ({
    id: itemId(b.id, l?.key ?? null),
    status,
    method,
    reason,
    explanation,
    bankLineId: b.id,
    ledgerKey: l?.key ?? null,
    currency: b.currency,
    amount: b.amount,
    fee: b.fee ?? 0,
    difference: l ? b.amount - l.amount : 0,
    candidates: [...candidates].sort(),
    invoice: { status: "none" },
  });

  const pair = (b: BankLine, l: LedgerEntry, method: Method): ReconItem => {
    const diff = b.amount - l.amount;
    if (b.currency !== l.currency) return make(b, l, "ambiguous", method, "currency_mismatch", `Bank line is in ${b.currency} but the payment was authorized in ${l.currency}.`);
    if (b.receiver !== undefined && b.receiver !== l.receiver) return make(b, l, "ambiguous", method, "receiver_mismatch", "The money went to a different account than the one authorized.");
    if (diff !== 0) {
      if (approved.has(`${itemId(b.id, l.key)}|${diff}`)) {
        return make(b, l, "matched", method, method === "operator" ? "operator_confirmed" : "single_reference_match", `Matched; the ${money(diff, b.currency)} difference is covered by an approved adjustment.`);
      }
      return make(b, l, "ambiguous", method, "amount_difference", `Bank moved ${money(b.amount, b.currency)} but ${money(l.amount, l.currency)} was authorized (difference ${money(diff, b.currency)}).`);
    }
    if (method === "operator") return make(b, l, "matched", method, "operator_confirmed", "Confirmed by an operator.");
    if (method === "reference") return make(b, l, "matched", method, "single_reference_match", "Shared PayPal reference, same amount, currency and receiver.");
    return make(b, l, "matched", method, "single_candidate", "No reference; the only payment with this amount, receiver and date window.");
  };

  const claim = (b: BankLine, l: LedgerEntry, method: Method) => {
    done.set(b.id, pair(b, l, method));
    claimed.add(l.key);
  };

  // 1. Operator confirmations.
  for (const r of [...(input.resolutions ?? [])].sort((a, b) => a.bankLineId.localeCompare(b.bankLineId))) {
    const b = bank.find((x) => x.id === r.bankLineId);
    const l = byKey.get(r.ledgerKey);
    if (!b || !l || done.has(b.id) || claimed.has(l.key)) continue;
    claim(b, l, "operator");
  }

  // 2. Shared references.
  const refCands = new Map<string, string[]>();
  for (const b of bank) {
    if (done.has(b.id) || (b.reference === undefined && b.senderRef === undefined)) continue;
    const c = ledger.filter((l) => (b.reference !== undefined && l.reference === b.reference) || (b.senderRef !== undefined && l.requestId === b.senderRef)).map((l) => l.key);
    refCands.set(b.id, c);
    for (const k of c) contested.add(k);
  }
  const wantedBy = new Map<string, number>();
  for (const c of refCands.values()) for (const k of c) wantedBy.set(k, (wantedBy.get(k) ?? 0) + 1);
  for (const b of bank) {
    const c = refCands.get(b.id);
    if (!c) continue;
    if (c.length === 0) {
      done.set(b.id, make(b, null, "unmatched", null, "reference_unknown", "The bank line carries a PayPal reference we have no payment for."));
    } else if (c.length > 1) {
      done.set(b.id, make(b, null, "ambiguous", null, "several_candidates", "The references point at more than one payment.", c));
    } else {
      const l = byKey.get(c[0]!)!;
      if (claimed.has(l.key) || (wantedBy.get(l.key) ?? 0) > 1) {
        done.set(b.id, make(b, l, "ambiguous", null, "competing_bank_lines", "More than one bank line claims this payment.", [l.key]));
      } else claim(b, l, "reference");
    }
  }

  // 3. No reference: amount + receiver + date window, only when unique on both sides.
  const open = bank.filter((b) => !done.has(b.id));
  const heur = new Map<string, string[]>();
  for (const b of open) {
    const c =
      b.receiver === undefined
        ? []
        : ledger
            .filter((l) => !claimed.has(l.key) && !contested.has(l.key) && l.currency === b.currency && l.amount === b.amount && l.receiver === b.receiver && Math.abs(Date.parse(l.date) - Date.parse(b.date)) <= cfg.windowDays * DAY_MS)
            .map((l) => l.key);
    heur.set(b.id, c);
  }
  const heurWanted = new Map<string, number>();
  for (const c of heur.values()) for (const k of c) heurWanted.set(k, (heurWanted.get(k) ?? 0) + 1);
  for (const b of open) {
    const c = heur.get(b.id)!;
    if (c.length === 0) {
      const why = b.receiver === undefined ? "no reference and no receiver, so there is nothing safe to match on" : "no payment fits this amount, receiver and date window";
      done.set(b.id, make(b, null, "unmatched", null, "no_candidate", `This line has ${why}.`));
    } else if (c.length > 1) {
      done.set(b.id, make(b, null, "ambiguous", null, "several_candidates", `${c.length} payments fit this amount, receiver and date window.`, c));
    } else if ((heurWanted.get(c[0]!) ?? 0) > 1) {
      done.set(b.id, make(b, null, "ambiguous", null, "competing_bank_lines", "More than one bank line fits the only payment that matches.", c));
    } else claim(b, byKey.get(c[0]!)!, "amount_payee_date");
  }

  // Payments that an ambiguous line points at are spoken for: they are not "unsettled".
  const spokenFor = new Set(claimed);
  for (const it of done.values()) {
    for (const k of it.candidates) spokenFor.add(k);
    if (it.ledgerKey) spokenFor.add(it.ledgerKey);
  }

  // Tie matched payments to purchase orders; a matched payment whose invoice side is unclear goes to a person.
  const items: ReconItem[] = bank.map((b) => {
    let it = done.get(b.id)!;
    if (it.ledgerKey) {
      const invoice = linkInvoice(byKey.get(it.ledgerKey)!, input.purchaseOrders);
      it = { ...it, invoice };
      if (it.status === "matched" && invoice.status === "ambiguous") {
        it = { ...it, status: "ambiguous", reason: "invoice_ambiguous", explanation: "The payment matches the bank, but several closed purchase orders fit it.", candidates: invoice.candidates ?? [] };
      } else if (it.status === "matched" && invoice.status === "mismatch") {
        it = { ...it, status: "ambiguous", reason: "invoice_mismatch", explanation: "The payment matches the bank, but its purchase order does not match the payment." };
      }
    }
    return it;
  });

  for (const l of ledger) {
    if (spokenFor.has(l.key)) continue;
    items.push({
      id: itemId(null, l.key),
      status: "unmatched",
      method: null,
      reason: "not_settled",
      explanation: "The payment was executed but no bank line for it has arrived.",
      bankLineId: null,
      ledgerKey: l.key,
      currency: l.currency,
      amount: l.amount,
      fee: 0,
      difference: 0,
      candidates: [],
      invoice: linkInvoice(l, input.purchaseOrders),
    });
  }

  return { items, totals: totalsOf(items) };
}

function totalsOf(items: readonly ReconItem[]): Totals[] {
  const t = new Map<string, Totals>();
  for (const it of items) {
    const row = t.get(it.currency) ?? { currency: it.currency, bank: 0, matched: 0, ambiguous: 0, unmatched: 0, ledgerOnly: 0 };
    if (it.bankLineId === null) row.ledgerOnly += it.amount;
    else {
      row.bank += it.amount;
      row[it.status] += it.amount;
    }
    t.set(it.currency, row);
  }
  return [...t.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * The adjustments the books would need: PayPal's fee on a matched payment, and a small difference on a pair.
 * Nothing above `maxAdjustment` is proposed, and nothing here is ever applied without a person.
 */
export function proposeAdjustments(report: ReconReport, config: Partial<ReconConfig> = {}): ProposedAdjustment[] {
  const { maxAdjustment } = { ...DEFAULT_CONFIG, ...config };
  const out: ProposedAdjustment[] = [];
  for (const it of report.items) {
    if (!it.bankLineId || !it.ledgerKey) continue;
    const evidence = { bankLineId: it.bankLineId, ledgerKey: it.ledgerKey, bankAmount: it.amount, ledgerAmount: it.amount - it.difference, fee: it.fee };
    const add = (kind: "fee" | "difference", amount: number) => out.push({ id: adjustmentId(it.id, kind, amount), itemId: it.id, kind, amount, currency: it.currency, evidence });
    if (it.status === "matched" && it.fee > 0 && it.fee <= maxAdjustment) add("fee", it.fee);
    if (it.status === "ambiguous" && it.reason === "amount_difference" && it.difference !== 0 && Math.abs(it.difference) <= maxAdjustment) add("difference", it.difference);
  }
  return out;
}
