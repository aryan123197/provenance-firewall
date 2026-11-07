/** Everything here is integer minor units (cents) and ISO dates. No floats touch money. */

/** One line of PayPal's own record of money that moved. `memo` is free text from outside, so it is shown and never matched on. */
export interface BankLine {
  id: string;
  /** PayPal's payout item / batch id. */
  reference?: string;
  /** Our `PayPal-Request-Id` / sender_item_id echoed back. */
  senderRef?: string;
  amount: number;
  currency: string;
  date: string;
  receiver?: string;
  /** Fee PayPal charged on top of `amount`. */
  fee?: number;
  memo?: string;
}

/** A payment the firewall allowed and the adapter executed. */
export interface LedgerEntry {
  key: string;
  reference?: string;
  requestId?: string;
  amount: number;
  currency: string;
  date: string;
  receiver: string;
  payee: string;
  vendorId: string | null;
  /** The purchase order this payment closed, when the audit log says which. */
  poId?: string;
}

export interface PurchaseOrderLine {
  id: string;
  vendorId: string;
  amount: number;
  currency: string;
  status: "open" | "closed";
}

/** An operator's decision that this bank line is this ledger entry. */
export interface Resolution {
  bankLineId: string;
  ledgerKey: string;
}

/** An adjustment a person approved: it explains a difference or books a fee. */
export interface ApprovedAdjustment {
  itemId: string;
  kind: AdjustmentKind;
  amount: number;
}

export type AdjustmentKind = "fee" | "difference";

export interface ReconConfig {
  /** How many days apart a bank line and a ledger entry may be when there is no shared reference. */
  windowDays: number;
  /** The most any single adjustment may move. Above it nothing is proposed: a person investigates instead. */
  maxAdjustment: number;
}

export const DEFAULT_CONFIG: ReconConfig = { windowDays: 5, maxAdjustment: 500 };

export type ItemStatus = "matched" | "ambiguous" | "unmatched";

export type MatchMethod = "reference" | "amount_payee_date" | "operator";

export type ReasonCode =
  | "single_reference_match"
  | "single_candidate"
  | "operator_confirmed"
  | "reference_unknown"
  | "no_candidate"
  | "several_candidates"
  | "competing_bank_lines"
  | "amount_difference"
  | "currency_mismatch"
  | "receiver_mismatch"
  | "not_settled"
  | "invoice_ambiguous"
  | "invoice_mismatch";

export interface InvoiceLink {
  status: "linked" | "none" | "ambiguous" | "mismatch";
  poId?: string;
  candidates?: string[];
}

export interface ReconItem {
  /** Stable for the same pair, so approvals and notes can point at it. */
  id: string;
  status: ItemStatus;
  method: MatchMethod | null;
  reason: ReasonCode;
  /** Human-readable, built only from the fields the rules used (never from memo text). */
  explanation: string;
  bankLineId: string | null;
  ledgerKey: string | null;
  /** Bank amount minus ledger amount when the pair is known; 0 when they agree. */
  difference: number;
  fee: number;
  currency: string;
  amount: number;
  candidates: string[];
  invoice: InvoiceLink;
}

export interface Totals {
  currency: string;
  bank: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  /** Ledger payments with no bank line yet. */
  ledgerOnly: number;
}

export interface ReconReport {
  items: ReconItem[];
  totals: Totals[];
}

export interface ProposedAdjustment {
  id: string;
  itemId: string;
  kind: AdjustmentKind;
  /** Signed: positive means the bank moved more than the ledger recorded (or a fee was charged). */
  amount: number;
  currency: string;
  evidence: { bankLineId: string; ledgerKey: string; bankAmount: number; ledgerAmount: number; fee: number };
}

export class ReconInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconInputError";
  }
}
