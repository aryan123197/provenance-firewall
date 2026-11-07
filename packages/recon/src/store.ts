import { z } from "zod";
import type { Store } from "@pfw/store";
import { proposeAdjustments, reconcile } from "./match";
import {
  CONFIRMABLE_REASONS,
  DEFAULT_CONFIG,
  ReconInputError,
  type AdjustmentKind,
  type BankLine,
  type LedgerEntry,
  type ProposedAdjustment,
  type ReconConfig,
  type ReconReport,
} from "./types";

const SCHEMA = `
-- PayPal's record of money that moved. A line never changes once imported.
CREATE TABLE IF NOT EXISTS recon_bank_lines (
  id          TEXT PRIMARY KEY,
  line_json   TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
-- A person's decision that this bank line is this payment. One per line.
CREATE TABLE IF NOT EXISTS recon_resolutions (
  bank_line_id TEXT PRIMARY KEY REFERENCES recon_bank_lines(id),
  ledger_key   TEXT NOT NULL,
  resolved_by  TEXT NOT NULL,
  note         TEXT,
  resolved_at  TEXT NOT NULL
);
-- Proposed by the matcher, applied only after a person approves. Single use: the status only moves out of 'proposed' once.
CREATE TABLE IF NOT EXISTS recon_adjustments (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('fee', 'difference')),
  amount        INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'rejected')),
  proposed_at   TEXT NOT NULL,
  resolved_by   TEXT,
  resolved_at   TEXT,
  note          TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_type ON audit_log(type);
CREATE TRIGGER IF NOT EXISTS recon_bank_lines_no_update BEFORE UPDATE ON recon_bank_lines
BEGIN SELECT RAISE(ABORT, 'bank lines are append-only'); END;
CREATE TRIGGER IF NOT EXISTS recon_bank_lines_no_delete BEFORE DELETE ON recon_bank_lines
BEGIN SELECT RAISE(ABORT, 'bank lines are append-only'); END;
CREATE TRIGGER IF NOT EXISTS recon_adjustments_once BEFORE UPDATE OF status ON recon_adjustments WHEN OLD.status != 'proposed'
BEGIN SELECT RAISE(ABORT, 'an adjustment is resolved once'); END;
CREATE TRIGGER IF NOT EXISTS recon_adjustments_no_delete BEFORE DELETE ON recon_adjustments
BEGIN SELECT RAISE(ABORT, 'adjustments are append-only'); END;
`;

export class ReconStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconStateError";
  }
}

export interface AdjustmentRecord extends ProposedAdjustment {
  status: "proposed" | "approved" | "rejected";
  proposedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
}

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const text = (max: number) => z.string().trim().min(1).max(max).regex(NO_CONTROL, "must not contain control characters");

const BankLineSchema = z
  .object({
    id: text(200),
    reference: text(200).optional(),
    senderRef: text(200).optional(),
    amount: z.number().int().positive().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    date: z.string().refine((d) => Number.isFinite(Date.parse(d)), "not a valid ISO date"),
    receiver: text(254).optional(),
    fee: z.number().int().nonnegative().safe().optional(),
    // Free text from outside: stored for the person reading it, bounded, and never matched on.
    memo: z.string().max(1000).optional(),
  })
  .strict();

const NOTE_MAX = 1000;

interface AdjRow {
  id: string;
  item_id: string;
  kind: AdjustmentKind;
  amount: number;
  currency: string;
  evidence_json: string;
  status: AdjustmentRecord["status"];
  proposed_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  note: string | null;
}

const toRecord = (r: AdjRow): AdjustmentRecord => ({
  id: r.id,
  itemId: r.item_id,
  kind: r.kind,
  amount: r.amount,
  currency: r.currency,
  evidence: JSON.parse(r.evidence_json) as ProposedAdjustment["evidence"],
  status: r.status,
  proposedAt: r.proposed_at,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  note: r.note,
});

/**
 * Close and reconciliation on top of the firewall's database. It reads what the firewall executed, takes PayPal's
 * settlement lines, and keeps three things of its own: the lines, the operator's confirmations and the adjustments.
 * Every write also lands in the signed audit log, in the same transaction.
 */
export class ReconStore {
  readonly config: ReconConfig;

  constructor(
    private readonly store: Store,
    config: Partial<ReconConfig> = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    store.db.exec(SCHEMA);
  }

  /** Imports PayPal's lines. Re-sending the same line is harmless; a line with a known id but different content is refused. */
  importBankLines(lines: unknown, importedBy: string): { added: number; unchanged: number } {
    const by = this.person(importedBy, "importedBy");
    const parsed = z.array(BankLineSchema).max(1000).safeParse(lines);
    if (!parsed.success) throw new ReconInputError(parsed.error.issues.map((i) => `${i.path.join(".") || "lines"}: ${i.message}`).join("; "));
    return this.store.db
      .transaction(() => {
        const get = this.store.db.prepare("SELECT line_json FROM recon_bank_lines WHERE id = ?");
        const ins = this.store.db.prepare("INSERT INTO recon_bank_lines (id, line_json, imported_at) VALUES (?, ?, ?)");
        const seen = new Set<string>();
        const added: string[] = [];
        let unchanged = 0;
        for (const l of parsed.data) {
          if (seen.has(l.id)) throw new ReconInputError(`the same bank line id appears twice in this import: ${l.id}`);
          seen.add(l.id);
          const json = JSON.stringify(canonical(l));
          const prior = get.get(l.id) as { line_json: string } | undefined;
          if (prior) {
            if (prior.line_json !== json) throw new ReconStateError(`bank line ${l.id} was imported before with different contents`);
            unchanged++;
          } else {
            ins.run(l.id, json, this.clock().toISOString());
            added.push(l.id);
          }
        }
        if (added.length) this.store.audit.append("recon_bank_import", { importedBy: by, ids: added });
        return { added: added.length, unchanged };
      })
      .immediate();
  }

  bankLines(): BankLine[] {
    return (this.store.db.prepare("SELECT line_json FROM recon_bank_lines ORDER BY id").all() as { line_json: string }[]).map((r) => JSON.parse(r.line_json) as BankLine);
  }

  /** Payments the firewall allowed and the adapter executed. A failed execution is not in the ledger: no money moved. */
  ledger(): LedgerEntry[] {
    // One pass over the purchase-order closes (indexed by type), not a scan of the audit log per payment.
    const poFor = new Map(
      (this.store.db.prepare("SELECT json_extract(payload_json, '$.idempotencyKey') AS key, json_extract(payload_json, '$.purchaseOrderId') AS po FROM audit_log WHERE type = 'purchase_order_closed'").all() as { key: string; po: string }[]).map((r) => [r.key, r.po]),
    );
    const rows = (
      this.store.db
        .prepare(
          `SELECT p.idempotency_key AS key, p.vendor_id, p.created_at, e.reference, e.request_id, d.decision_json
             FROM payments p
             JOIN executions e ON e.idempotency_key = p.idempotency_key AND e.state = 'executed'
             JOIN decisions d ON d.idempotency_key = p.idempotency_key
            ORDER BY p.idempotency_key`,
        )
        .all() as { key: string; vendor_id: string | null; created_at: string; reference: string | null; request_id: string | null; decision_json: string }[]
    ).map((r) => ({ ...r, po_id: poFor.get(r.key) ?? null }));
    return rows.map((r) => {
      const f = (JSON.parse(r.decision_json) as { fields: Record<"payee" | "account" | "amount" | "currency", { value: string | number }> }).fields;
      return {
        key: r.key,
        amount: f.amount.value as number,
        currency: f.currency.value as string,
        date: r.created_at,
        receiver: f.account.value as string,
        payee: f.payee.value as string,
        vendorId: r.vendor_id,
        ...(r.reference ? { reference: r.reference } : {}),
        ...(r.request_id ? { requestId: r.request_id } : {}),
        ...(r.po_id ? { poId: r.po_id } : {}),
      };
    });
  }

  /** The current picture. Read-only: it records nothing. */
  report(): ReconReport {
    const approved = this.adjustments("approved").map((a) => ({ itemId: a.itemId, kind: a.kind, amount: a.amount }));
    const resolutions = (this.store.db.prepare("SELECT bank_line_id, ledger_key FROM recon_resolutions ORDER BY bank_line_id").all() as { bank_line_id: string; ledger_key: string }[]).map((r) => ({ bankLineId: r.bank_line_id, ledgerKey: r.ledger_key }));
    return reconcile({ bank: this.bankLines(), ledger: this.ledger(), purchaseOrders: this.store.listPurchaseOrders(), resolutions, approved, config: this.config });
  }

  /** Reconciles, records any adjustments the books now need, and writes the run (counts and a hash of the result) to the audit log. */
  run(runBy: string): { report: ReconReport; proposed: AdjustmentRecord[] } {
    const by = this.person(runBy, "runBy");
    return this.store.db
      .transaction(() => {
        const report = this.report();
        const at = this.clock().toISOString();
        const ins = this.store.db.prepare(
          "INSERT OR IGNORE INTO recon_adjustments (id, item_id, kind, amount, currency, evidence_json, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        const fresh: string[] = [];
        for (const a of proposeAdjustments(report, this.config)) {
          if (ins.run(a.id, a.itemId, a.kind, a.amount, a.currency, JSON.stringify(a.evidence), at).changes > 0) {
            fresh.push(a.id);
            this.store.audit.append("recon_adjustment_proposed", { adjustmentId: a.id, itemId: a.itemId, kind: a.kind, amount: a.amount, currency: a.currency, evidence: a.evidence });
          }
        }
        const count = (s: string) => report.items.filter((i) => i.status === s).length;
        this.store.audit.append("recon_run", { runBy: by, matched: count("matched"), ambiguous: count("ambiguous"), unmatched: count("unmatched"), totals: report.totals, newAdjustments: fresh });
        return { report, proposed: this.adjustments("proposed") };
      })
      .immediate();
  }

  /** A person says which payment an unsettled or ambiguous bank line is. Only payments the matcher already considers open are offered. */
  resolveMatch(input: { bankLineId: string; ledgerKey: string; resolvedBy: string; note?: string }): void {
    const by = this.person(input.resolvedBy, "resolvedBy");
    const note = this.note(input.note);
    this.store.db
      .transaction(() => {
        if (this.store.db.prepare("SELECT 1 FROM recon_resolutions WHERE bank_line_id = ?").get(input.bankLineId)) throw new ReconStateError("this bank line was already resolved");
        const report = this.report();
        const item = report.items.find((i) => i.bankLineId === input.bankLineId);
        if (!item) throw new ReconStateError("unknown bank line");
        if (item.status === "matched") throw new ReconStateError("this bank line is already matched");
        if (!CONFIRMABLE_REASONS.includes(item.reason)) throw new ReconStateError("this line cannot be cleared by confirming a match; investigate it in PayPal or approve its adjustment");
        const open = new Set([...item.candidates, ...report.items.filter((i) => i.reason === "not_settled").map((i) => i.ledgerKey)]);
        if (!open.has(input.ledgerKey)) throw new ReconStateError("that payment is not an open candidate for this bank line");
        this.store.db.prepare("INSERT INTO recon_resolutions (bank_line_id, ledger_key, resolved_by, note, resolved_at) VALUES (?, ?, ?, ?, ?)").run(input.bankLineId, input.ledgerKey, by, note, this.clock().toISOString());
        this.store.audit.append("recon_match_confirmed", { bankLineId: input.bankLineId, ledgerKey: input.ledgerKey, resolvedBy: by, note });
      })
      .immediate();
  }

  adjustments(status?: AdjustmentRecord["status"]): AdjustmentRecord[] {
    const rows = this.store.db.prepare(`SELECT * FROM recon_adjustments ${status ? "WHERE status = ?" : ""} ORDER BY proposed_at, id`).all(...(status ? [status] : [])) as AdjRow[];
    return rows.map(toRecord);
  }

  /**
   * Approve or reject one proposed adjustment. Approval is attributed, single use, and re-checked against the books as they
   * are now: if the item changed, or the amount is above the ceiling, it is refused.
   */
  resolveAdjustment(id: string, input: { approver: string; approve: boolean; note?: string }): AdjustmentRecord {
    const by = this.person(input.approver, "approver");
    const note = this.note(input.note);
    return this.store.db
      .transaction(() => {
        const row = this.store.db.prepare("SELECT * FROM recon_adjustments WHERE id = ?").get(id) as AdjRow | undefined;
        if (!row) throw new ReconStateError("unknown adjustment");
        if (row.status !== "proposed") throw new ReconStateError(`this adjustment was already ${row.status}`);
        const at = this.clock().toISOString();
        if (input.approve) {
          if (Math.abs(row.amount) > this.config.maxAdjustment) throw new ReconStateError("this adjustment is above the ceiling; investigate it instead");
          const still = proposeAdjustments(this.report(), this.config).some((a) => a.id === id);
          if (!still) throw new ReconStateError("this adjustment no longer applies to the current books");
        }
        this.store.db.prepare("UPDATE recon_adjustments SET status = ?, resolved_by = ?, resolved_at = ?, note = ? WHERE id = ?").run(input.approve ? "approved" : "rejected", by, at, note, id);
        this.store.audit.append(input.approve ? "recon_adjustment_approved" : "recon_adjustment_rejected", {
          adjustmentId: id,
          itemId: row.item_id,
          kind: row.kind,
          amount: row.amount,
          currency: row.currency,
          evidence: JSON.parse(row.evidence_json) as unknown,
          approver: by,
          note,
        });
        return toRecord(this.store.db.prepare("SELECT * FROM recon_adjustments WHERE id = ?").get(id) as AdjRow);
      })
      .immediate();
  }

  private person(v: string, field: string): string {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) throw new ReconInputError(`${field} is required`);
    if (s.length > 100 || !NO_CONTROL.test(s)) throw new ReconInputError(`${field} is too long or has control characters`);
    return s;
  }

  private note(v: string | undefined): string | null {
    if (v === undefined) return null;
    if (v.length > NOTE_MAX || !NO_CONTROL.test(v)) throw new ReconInputError("note is too long or has control characters");
    return v;
  }
}

/** Stable key order so an identical re-import compares equal. */
function canonical(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}
