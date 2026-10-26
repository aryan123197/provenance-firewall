import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  canonicalJson,
  evaluate,
  isTrusted,
  parseHandle,
  policyFromDoc,
  type Policy,
  type PolicyDoc,
  type Decision,
  type PolicyState,
  type PurchaseOrder,
  type ResolvedIntent,
  type VendorRecord,
} from "@pfw/core";
import { AuditLog, auditRowToEntry, createSigner, type AuditEntry, type Signer } from "./audit";
import { SCHEMA } from "./schema";

export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`idempotency key "${key}" was already used for a different request`);
    this.name = "IdempotencyConflictError";
  }
}

export interface DecideResult {
  decision: Decision;
  /** True when the key was seen before and the stored decision was returned unchanged. */
  replayed: boolean;
}

export interface ExecutionRecord {
  state: "executed" | "failed";
  retryable: boolean;
  payload: unknown;
  /** Provider's id for the payment and our request id sent to it, used to match webhooks. */
  reference?: string;
  requestId?: string;
}

/** A provider notification reduced to what reconciliation needs (the adapter's ProviderEvent fits this shape). */
export interface ProviderEventInput {
  id: string;
  type: string;
  reference?: string;
  senderRef?: string;
  status: string;
  amount?: number;
  currency?: string;
  receiver?: string;
}

export type ReconcileResult =
  | { result: "duplicate" }
  | { result: "matched"; idempotencyKey: string; providerStatus: string }
  | { result: "drift"; kind: DriftKind; reference: string };

export type DriftKind = "unmatched_payment" | "detail_mismatch";

export interface Drift {
  id: number;
  kind: DriftKind;
  reference: string;
  detail: unknown;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}

const STATUS_RANK: Record<string, number> = { unknown: 0, pending: 0, unclaimed: 1, success: 2, failed: 2, returned: 3 };

export class ApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalStateError";
  }
}

export interface Approval {
  id: string;
  idempotencyKey: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
  intent: ResolvedIntent;
  decision: Decision;
}

export interface ApprovalGrant {
  approvalId: string;
  idempotencyKey: string;
  approver: string;
}

export type ResolveApprovalResult =
  | { ok: true; status: "approved"; grant: ApprovalGrant }
  | { ok: true; status: "rejected" }
  /** Re-evaluation now denies the payment (a cap was used up, say). An approval cannot override a deny. */
  | { ok: false; reason: string; decision: Decision };

/** One row of the activity feed. */
export interface DecisionSummary {
  idempotencyKey: string;
  agentId: string;
  createdAt: string;
  verdict: Decision["verdict"];
  rule: Decision["rule"];
  reason: string;
  alert: boolean;
  payee: string;
  account: string;
  amount: number;
  currency: string;
  payeeTrust: number;
  execution: "executed" | "failed" | null;
  providerStatus: string | null;
  approval: { id: string; status: Approval["status"] } | null;
}

/** Everything the decision-replay screen shows for one payment. */
export interface DecisionRecord {
  summary: DecisionSummary;
  decision: Decision;
  execution: (ExecutionRecord & { providerStatus: string | null }) | null;
  approval: Approval | null;
  audit: AuditEntry[];
}

export class PolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConflictError";
  }
}

export interface PolicyVersionRecord {
  version: number;
  hash: string;
  doc: PolicyDoc;
  sourceText: string | null;
  patch: unknown;
  confirmedBy: string;
  createdAt: string;
  active: boolean;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface PurchaseOrderRecord extends PurchaseOrder {
  status: "open" | "closed";
}

export interface VendorChange {
  before: VendorRecord | null;
  after: VendorRecord;
  /** True when an existing vendor now pays into a different account. This is the payee-swap moment. */
  accountChanged: boolean;
}

const VENDOR_ID = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const CATEGORY = /^[a-z][a-z0-9_]{1,40}$/;
const ACCOUNT = /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|[A-Z0-9]{13})$/;

export interface StoreOptions {
  path?: string;
  clock?: () => Date;
  /** Signs audit entries. Defaults to an ephemeral key. */
  signer?: Signer;
}

/** Hash of what the key authorizes. Reusing a key for different values is an error, not a replay. */
function requestHash(i: ResolvedIntent): string {
  const body = {
    agentId: i.agentId,
    payee: i.payee.value,
    account: i.account.value,
    amount: i.amount.value,
    currency: i.currency.value,
    category: i.category.value,
  };
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

interface SummaryRow {
  idempotency_key: string;
  agent_id: string;
  created_at: string;
  decision_json: string;
  exec_state: "executed" | "failed" | null;
  provider_status: string | null;
  approval_id: string | null;
  approval_status: Approval["status"] | null;
}
const toSummary = (r: SummaryRow): DecisionSummary => {
  const d = JSON.parse(r.decision_json) as Decision;
  return {
    idempotencyKey: r.idempotency_key,
    agentId: r.agent_id,
    createdAt: r.created_at,
    verdict: d.verdict,
    rule: d.rule,
    reason: d.reason,
    alert: d.alert,
    payee: String(d.fields.payee.value),
    account: String(d.fields.account.value),
    amount: Number(d.fields.amount.value),
    currency: String(d.fields.currency.value),
    payeeTrust: d.fields.payee.trust,
    execution: r.exec_state,
    providerStatus: r.provider_status,
    approval: r.approval_id && r.approval_status ? { id: r.approval_id, status: r.approval_status } : null,
  };
};

interface ApprovalRow {
  id: string;
  idempotency_key: string;
  status: Approval["status"];
  requested_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  note: string | null;
  intent_json: string;
  decision_json: string;
}
const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  requestedAt: r.requested_at,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  note: r.note,
  intent: JSON.parse(r.intent_json) as ResolvedIntent,
  decision: JSON.parse(r.decision_json) as Decision,
});

interface VendorRow { id: string; name: string; account: string; category: string }
interface PoRow { id: string; vendor_id: string; amount: number; currency: string }

export class Store {
  /** Exposed for tests and operator tooling; the firewall only uses the methods below. */
  readonly db: Database.Database;
  readonly audit: AuditLog;
  private readonly clock: () => Date;

  constructor(opts: StoreOptions = {}) {
    this.db = new Database(opts.path ?? ":memory:");
    this.clock = opts.clock ?? (() => new Date());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.audit = new AuditLog(this.db, opts.signer ?? createSigner(), this.clock);
  }

  close(): void {
    this.db.close();
  }

  upsertVendor(v: VendorRecord): void {
    this.db
      .prepare(
        `INSERT INTO vendors (id, name, account, category) VALUES (@id, @name, @account, @category)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, account = excluded.account, category = excluded.category`,
      )
      .run(v);
  }

  /**
   * The operator's way to add or edit a vendor. Unlike `upsertVendor` (used for seeding), this validates, names who did it,
   * and writes the before and after to the audit log. Changing where an existing vendor is paid is flagged, because that is
   * exactly what a payee swap tries to achieve.
   */
  changeVendor(v: VendorRecord, changedBy: string): VendorChange {
    return this.db.transaction((): VendorChange => {
      if (!changedBy.trim()) throw new RegistryError("say who is making this change");
      if (!VENDOR_ID.test(v.id)) throw new RegistryError("the vendor id must be 2-41 characters: lowercase letters, digits, - or _");
      if (!v.name.trim() || v.name.length > 120 || v.name !== v.name.trim()) throw new RegistryError("the vendor name must be 1-120 characters with no leading or trailing spaces");
      if (!ACCOUNT.test(v.account) || v.account.length > 254) throw new RegistryError("the account must be a PayPal email address or a 13-character PayPal ID");
      if (!CATEGORY.test(v.category)) throw new RegistryError("the category must be lowercase letters, digits or _");
      const clash = this.db.prepare("SELECT id FROM vendors WHERE lower(name) = lower(?) AND id <> ?").get(v.name, v.id) as { id: string } | undefined;
      if (clash) throw new RegistryError(`another vendor (${clash.id}) already has that name`);
      const before = (this.db.prepare("SELECT id, name, account, category FROM vendors WHERE id = ?").get(v.id) as VendorRow | undefined) ?? null;
      this.upsertVendor(v);
      const accountChanged = before !== null && before.account !== v.account;
      this.audit.append("vendor_changed", { vendorId: v.id, changedBy: changedBy.trim(), before, after: v, accountChanged });
      return { before, after: v, accountChanged };
    }).immediate();
  }

  /** Records a purchase order the operator approved, with who added it. */
  changePurchaseOrder(po: PurchaseOrder, changedBy: string): void {
    this.db.transaction(() => {
      if (!changedBy.trim()) throw new RegistryError("say who is making this change");
      if (!VENDOR_ID.test(po.id)) throw new RegistryError("the purchase order id must be 2-41 characters: lowercase letters, digits, - or _");
      if (!this.db.prepare("SELECT 1 FROM vendors WHERE id = ?").get(po.vendorId)) throw new RegistryError(`unknown vendor ${po.vendorId}`);
      if (!Number.isSafeInteger(po.amount) || po.amount < 0) throw new RegistryError("the amount must be a non-negative whole number of cents");
      if (!/^[A-Z]{3}$/.test(po.currency)) throw new RegistryError("the currency must be a 3-letter code");
      if (this.db.prepare("SELECT 1 FROM purchase_orders WHERE id = ?").get(po.id)) throw new RegistryError(`purchase order ${po.id} already exists`);
      this.addPurchaseOrder(po);
      this.audit.append("purchase_order_added", { purchaseOrder: po, changedBy: changedBy.trim() });
    }).immediate();
  }

  listPurchaseOrders(): PurchaseOrderRecord[] {
    const rows = this.db.prepare("SELECT id, vendor_id, amount, currency, status FROM purchase_orders ORDER BY rowid DESC").all() as (PoRow & { status: "open" | "closed" })[];
    return rows.map((r) => ({ id: r.id, vendorId: r.vendor_id, amount: r.amount, currency: r.currency, status: r.status }));
  }

  listVendors(): VendorRecord[] {
    return this.db.prepare("SELECT id, name, account, category FROM vendors ORDER BY id").all() as VendorRow[];
  }

  addPurchaseOrder(po: PurchaseOrder): void {
    this.db
      .prepare("INSERT INTO purchase_orders (id, vendor_id, amount, currency) VALUES (@id, @vendorId, @amount, @currency)")
      .run(po);
  }

  /**
   * Decide one intent. The lookup, the counters, the decision and the payment row all happen in a single
   * write transaction, so a retry returns the stored decision and two racing payments cannot both fit under a cap.
   */
  decide(intent: ResolvedIntent, policy: Policy): DecideResult {
    return this.db.transaction((): DecideResult => {
      const hash = requestHash(intent);
      const prior = this.db
        .prepare("SELECT request_hash, decision_json FROM decisions WHERE idempotency_key = ?")
        .get(intent.idempotencyKey) as { request_hash: string; decision_json: string } | undefined;
      if (prior) {
        if (prior.request_hash !== hash) throw new IdempotencyConflictError(intent.idempotencyKey);
        return { decision: JSON.parse(prior.decision_json) as Decision, replayed: true };
      }

      const now = this.clock();
      const decision = evaluate(intent, policy, this.stateFor(intent, now));
      const at = now.toISOString();

      this.db
        .prepare(
          `INSERT INTO decisions (idempotency_key, agent_id, request_hash, verdict, decision_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(intent.idempotencyKey, intent.agentId, hash, decision.verdict, JSON.stringify(decision), at);

      this.audit.append("decision", { idempotencyKey: intent.idempotencyKey, agentId: intent.agentId, decision });

      if (decision.verdict === "require_approval") {
        const id = `apr_${hash.slice(0, 16)}_${createHash("sha256").update(intent.idempotencyKey).digest("hex").slice(0, 8)}`;
        this.db
          .prepare("INSERT INTO approvals (id, idempotency_key, request_hash, intent_json, requested_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, intent.idempotencyKey, hash, JSON.stringify(intent), at);
        this.audit.append("approval_requested", { approvalId: id, idempotencyKey: intent.idempotencyKey, agentId: intent.agentId, rule: decision.rule, reason: decision.reason });
      }

      if (decision.verdict === "allow") {
        const vendor = this.matchVendor(intent);
        this.db
          .prepare("INSERT INTO payments (idempotency_key, agent_id, vendor_id, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(intent.idempotencyKey, intent.agentId, vendor?.id ?? null, intent.amount.value, intent.currency.value, at);
        this.consumePurchaseOrder(intent);
      }
      return { decision, replayed: false };
    }).immediate();
  }

  /** Newest first. */
  listDecisions(opts: { limit?: number; offset?: number } = {}): DecisionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.idempotency_key, d.agent_id, d.created_at, d.decision_json,
                e.state AS exec_state, e.provider_status, a.id AS approval_id, a.status AS approval_status
           FROM decisions d
           LEFT JOIN executions e ON e.idempotency_key = d.idempotency_key
           LEFT JOIN approvals a ON a.idempotency_key = d.idempotency_key
          ORDER BY d.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.limit ?? 200, opts.offset ?? 0) as SummaryRow[];
    return rows.map(toSummary);
  }

  getDecisionRecord(key: string): DecisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT d.idempotency_key, d.agent_id, d.created_at, d.decision_json,
                e.state AS exec_state, e.provider_status, a.id AS approval_id, a.status AS approval_status
           FROM decisions d
           LEFT JOIN executions e ON e.idempotency_key = d.idempotency_key
           LEFT JOIN approvals a ON a.idempotency_key = d.idempotency_key
          WHERE d.idempotency_key = ?`,
      )
      .get(key) as SummaryRow | undefined;
    if (!row) return null;
    const audit = (
      this.db.prepare("SELECT * FROM audit_log WHERE json_extract(payload_json, '$.idempotencyKey') = ? ORDER BY seq").all(key) as Parameters<
        typeof auditRowToEntry
      >[0][]
    ).map(auditRowToEntry);
    return {
      summary: toSummary(row),
      decision: JSON.parse(row.decision_json) as Decision,
      execution: this.getExecution(key),
      approval: this.getApprovalByKey(key),
      audit,
    };
  }

  /** The newest activated policy, if any. Otherwise the deployment's policy file applies. */
  activePolicy(): Policy | null {
    const r = this.db.prepare("SELECT doc_json FROM policy_versions WHERE active = 1").get() as { doc_json: string } | undefined;
    return r ? policyFromDoc(JSON.parse(r.doc_json)) : null;
  }

  listPolicyVersions(): PolicyVersionRecord[] {
    const rows = this.db.prepare("SELECT * FROM policy_versions ORDER BY version DESC").all() as {
      version: number; hash: string; doc_json: string; source_text: string | null; patch_json: string | null; confirmed_by: string; created_at: string; active: number;
    }[];
    return rows.map((r) => ({
      version: r.version,
      hash: r.hash,
      doc: JSON.parse(r.doc_json) as PolicyDoc,
      sourceText: r.source_text,
      patch: r.patch_json ? (JSON.parse(r.patch_json) as unknown) : null,
      confirmedBy: r.confirmed_by,
      createdAt: r.created_at,
      active: r.active === 1,
    }));
  }

  /**
   * Activate a new policy version. `baseVersion` is the version the author started from; if someone else activated
   * another one meanwhile this is a conflict, so two edits can never silently overwrite each other.
   */
  activatePolicy(input: { baseVersion: number; doc: PolicyDoc; confirmedBy: string; sourceText?: string; patch?: unknown; note?: unknown }): Policy {
    return this.db.transaction((): Policy => {
      const current = this.db.prepare("SELECT version FROM policy_versions WHERE active = 1").get() as { version: number } | undefined;
      const currentVersion = current?.version ?? input.baseVersion;
      if (input.baseVersion !== currentVersion) {
        throw new PolicyConflictError(`the active policy is now version ${currentVersion}; this change was based on version ${input.baseVersion}`);
      }
      if (input.doc.version !== currentVersion + 1) throw new PolicyConflictError(`the new policy must be version ${currentVersion + 1}`);
      if (!input.confirmedBy.trim()) throw new PolicyConflictError("who confirmed this change is required");
      const policy = policyFromDoc(input.doc);
      const at = this.clock().toISOString();
      this.db.prepare("UPDATE policy_versions SET active = 0 WHERE active = 1").run();
      this.db
        .prepare("INSERT INTO policy_versions (version, hash, doc_json, source_text, patch_json, confirmed_by, created_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
        .run(policy.version, policy.hash, JSON.stringify(input.doc), input.sourceText ?? null, input.patch === undefined ? null : JSON.stringify(input.patch), input.confirmedBy.trim(), at);
      this.audit.append("policy_activated", {
        version: policy.version,
        hash: policy.hash,
        confirmedBy: input.confirmedBy.trim(),
        sourceText: input.sourceText ?? null,
        patch: input.patch ?? null,
        details: input.note ?? null,
      });
      return policy;
    }).immediate();
  }

  getApproval(id: string): Approval | null {
    return this.approvalWhere("a.id = ?", id);
  }

  getApprovalByKey(key: string): Approval | null {
    return this.approvalWhere("a.idempotency_key = ?", key);
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, d.decision_json FROM approvals a JOIN decisions d ON d.idempotency_key = a.idempotency_key
         ${status ? "WHERE a.status = ?" : ""} ORDER BY a.requested_at, a.id`,
      )
      .all(...(status ? [status] : [])) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /**
   * Approve or reject. Approving re-evaluates against current state: it clears "needs approval" findings, never a deny.
   * Approved spend is recorded here, so it counts toward caps from this moment.
   */
  resolveApproval(id: string, input: { approver: string; approve: boolean; note?: string }, policy: Policy): ResolveApprovalResult {
    return this.db.transaction((): ResolveApprovalResult => {
      const a = this.getApproval(id);
      if (!a) throw new ApprovalStateError(`unknown approval ${id}`);
      if (a.status !== "pending") throw new ApprovalStateError(`approval ${id} is already ${a.status}`);
      if (!input.approver.trim()) throw new ApprovalStateError("an approver is required");
      if (input.approver === a.intent.agentId) throw new ApprovalStateError("an agent cannot approve its own payment");

      const now = this.clock();
      const at = now.toISOString();

      if (input.approve) {
        const fresh = evaluate(a.intent, policy, this.stateFor(a.intent, now));
        if (fresh.verdict === "deny") {
          this.audit.append("approval_blocked", { approvalId: id, approver: input.approver, rule: fresh.rule, reason: fresh.reason });
          return { ok: false, reason: fresh.reason, decision: fresh };
        }
      }

      this.db
        .prepare("UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = ?, note = ? WHERE id = ? AND status = 'pending'")
        .run(input.approve ? "approved" : "rejected", input.approver, at, input.note ?? null, id);

      if (!input.approve) {
        this.audit.append("approval_rejected", { approvalId: id, idempotencyKey: a.idempotencyKey, approver: input.approver, note: input.note ?? null });
        return { ok: true, status: "rejected" };
      }
      const vendor = this.matchVendor(a.intent);
      this.db
        .prepare("INSERT INTO payments (idempotency_key, agent_id, vendor_id, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(a.idempotencyKey, a.intent.agentId, vendor?.id ?? null, a.intent.amount.value, a.intent.currency.value, at);
      this.consumePurchaseOrder(a.intent);
      this.audit.append("approval_granted", {
        approvalId: id,
        idempotencyKey: a.idempotencyKey,
        approver: input.approver,
        note: input.note ?? null,
        amount: a.intent.amount.value,
        currency: a.intent.currency.value,
      });
      return { ok: true, status: "approved", grant: { approvalId: id, idempotencyKey: a.idempotencyKey, approver: input.approver } };
    }).immediate();
  }

  /** The grant for an approved payment, used to authorize (or resume) its execution. */
  getGrant(key: string): ApprovalGrant | null {
    const a = this.getApprovalByKey(key);
    return a?.status === "approved" && a.resolvedBy ? { approvalId: a.id, idempotencyKey: key, approver: a.resolvedBy } : null;
  }

  private approvalWhere(where: string, arg: string): Approval | null {
    const r = this.db
      .prepare(`SELECT a.*, d.decision_json FROM approvals a JOIN decisions d ON d.idempotency_key = a.idempotency_key WHERE ${where}`)
      .get(arg) as ApprovalRow | undefined;
    return r ? toApproval(r) : null;
  }

  getExecution(key: string): (ExecutionRecord & { providerStatus: string | null }) | null {
    const r = this.db
      .prepare("SELECT state, retryable, payload_json, reference, request_id, provider_status FROM executions WHERE idempotency_key = ?")
      .get(key) as
      | { state: "executed" | "failed"; retryable: number; payload_json: string; reference: string | null; request_id: string | null; provider_status: string | null }
      | undefined;
    if (!r) return null;
    return {
      state: r.state,
      retryable: r.retryable === 1,
      payload: JSON.parse(r.payload_json) as unknown,
      ...(r.reference ? { reference: r.reference } : {}),
      ...(r.request_id ? { requestId: r.request_id } : {}),
      providerStatus: r.provider_status,
    };
  }

  saveExecution(key: string, rec: ExecutionRecord): void {
    this.db
      .transaction(() => {
        const at = this.clock().toISOString();
        this.db
          .prepare(
            `INSERT INTO executions (idempotency_key, state, retryable, payload_json, reference, request_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(idempotency_key) DO UPDATE SET state = excluded.state, retryable = excluded.retryable,
               payload_json = excluded.payload_json, reference = COALESCE(excluded.reference, reference),
               request_id = COALESCE(excluded.request_id, request_id), updated_at = excluded.updated_at`,
          )
          .run(key, rec.state, rec.retryable ? 1 : 0, JSON.stringify(rec.payload), rec.reference ?? null, rec.requestId ?? null, at);
        this.audit.append("execution", { idempotencyKey: key, state: rec.state, retryable: rec.retryable, payload: rec.payload });

        // A webhook can arrive before we finish recording the payment. Once we have it, that "unmatched" event was a race.
        if (rec.reference) {
          const open = this.db
            .prepare("SELECT id, detail_json FROM drift WHERE kind = 'unmatched_payment' AND reference = ? AND status = 'open'")
            .all(rec.reference) as { id: number; detail_json: string }[];
          for (const d of open) {
            const ev = (JSON.parse(d.detail_json) as { event?: ProviderEventInput }).event;
            this.db.prepare("UPDATE drift SET status = 'resolved', resolved_at = ? WHERE id = ?").run(at, d.id);
            if (ev) this.applyProviderStatus(key, ev.status);
            this.audit.append("drift_resolved", { driftId: d.id, reference: rec.reference, idempotencyKey: key, reason: "event arrived before the payment was recorded" });
          }
        }
      })
      .immediate();
  }

  /**
   * Match a provider notification against what we executed. Anything the provider did that we have no decision for,
   * or that differs from what was approved (amount, currency, receiver), opens a drift record.
   */
  recordProviderEvent(ev: ProviderEventInput): ReconcileResult {
    return this.db.transaction((): ReconcileResult => {
      const at = this.clock().toISOString();
      if (this.db.prepare("SELECT 1 FROM webhook_events WHERE id = ?").get(ev.id)) return { result: "duplicate" };
      this.db.prepare("INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?)").run(ev.id, ev.type, at);

      const exec = this.db
        .prepare(
          `SELECT e.idempotency_key AS key, d.decision_json FROM executions e JOIN decisions d ON d.idempotency_key = e.idempotency_key
           WHERE (e.reference IS NOT NULL AND e.reference = ?) OR (e.request_id IS NOT NULL AND e.request_id = ?) LIMIT 1`,
        )
        .get(ev.reference ?? null, ev.senderRef ?? null) as { key: string; decision_json: string } | undefined;

      const ref = ev.reference ?? ev.senderRef ?? ev.id;
      const openDrift = (kind: DriftKind, detail: unknown): ReconcileResult => {
        const r = this.db
          .prepare("INSERT OR IGNORE INTO drift (kind, reference, detail_json, created_at) VALUES (?, ?, ?, ?)")
          .run(kind, ref, JSON.stringify(detail), at);
        if (r.changes > 0) this.audit.append("drift", { kind, reference: ref, eventId: ev.id, detail });
        return { result: "drift", kind, reference: ref };
      };

      if (!exec) return openDrift("unmatched_payment", { event: ev, note: "the provider reports a payment with no matching decision" });

      const f = (JSON.parse(exec.decision_json) as Decision).fields;
      const mismatches: string[] = [];
      if (ev.amount !== undefined && ev.amount !== f.amount.value) mismatches.push(`amount ${ev.amount} but ${f.amount.value} was authorized`);
      if (ev.currency !== undefined && ev.currency !== f.currency.value) mismatches.push(`currency ${ev.currency} but ${f.currency.value} was authorized`);
      if (ev.receiver !== undefined && ev.receiver !== f.account.value) mismatches.push(`receiver ${ev.receiver} but ${f.account.value} was authorized`);

      this.applyProviderStatus(exec.key, ev.status);
      this.audit.append("webhook", { eventId: ev.id, type: ev.type, idempotencyKey: exec.key, status: ev.status });
      if (mismatches.length) return openDrift("detail_mismatch", { idempotencyKey: exec.key, event: ev, mismatches });
      return { result: "matched", idempotencyKey: exec.key, providerStatus: ev.status };
    }).immediate();
  }

  listDrift(status?: Drift["status"]): Drift[] {
    const rows = this.db
      .prepare(`SELECT * FROM drift ${status ? "WHERE status = ?" : ""} ORDER BY id`)
      .all(...(status ? [status] : [])) as { id: number; kind: DriftKind; reference: string; detail_json: string; status: Drift["status"]; created_at: string; resolved_at: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      reference: r.reference,
      detail: JSON.parse(r.detail_json) as unknown,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));
  }

  /** Statuses only move forward: a late "pending" event never undoes a "success". */
  private applyProviderStatus(key: string, status: string): void {
    const cur = this.db.prepare("SELECT provider_status FROM executions WHERE idempotency_key = ?").get(key) as { provider_status: string | null } | undefined;
    if (!cur) return;
    if (cur.provider_status && (STATUS_RANK[status] ?? 0) < (STATUS_RANK[cur.provider_status] ?? 0)) return;
    this.db.prepare("UPDATE executions SET provider_status = ? WHERE idempotency_key = ?").run(status, key);
  }

  /** A purchase order covers one payment: once paid against, it closes, so a re-sent invoice cannot be paid again. */
  private consumePurchaseOrder(i: ResolvedIntent): void {
    const fromHandle = i.amount.origins.find((o) => o.kind === "po");
    let poId = fromHandle ? parseHandle(fromHandle.ref)?.id : undefined;
    if (!poId) poId = this.purchaseOrderFor(i)?.id;
    if (!poId) return;
    const r = this.db.prepare("UPDATE purchase_orders SET status = 'closed' WHERE id = ? AND status = 'open'").run(poId);
    if (r.changes > 0) this.audit.append("purchase_order_closed", { purchaseOrderId: poId, idempotencyKey: i.idempotencyKey });
  }

  private matchVendor(i: ResolvedIntent): VendorRecord | null {
    return (
      (this.db
        .prepare("SELECT id, name, account, category FROM vendors WHERE name = ? AND account = ?")
        .get(i.payee.value, i.account.value) as VendorRow | undefined) ?? null
    );
  }

  private stateFor(i: ResolvedIntent, now: Date): PolicyState {
    const iso = now.toISOString();
    const dayStart = `${iso.slice(0, 10)}T00:00:00.000Z`;
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();

    const perVendor = this.db
      .prepare("SELECT vendor_id, SUM(amount) AS total FROM payments WHERE created_at >= ? AND vendor_id IS NOT NULL GROUP BY vendor_id")
      .all(dayStart) as { vendor_id: string; total: number }[];
    const totalToday = this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE created_at >= ?").get(dayStart) as { t: number };
    const recent = this.db
      .prepare("SELECT COUNT(*) AS n FROM payments WHERE agent_id = ? AND created_at > ?")
      .get(i.agentId, hourAgo) as { n: number };

    return {
      now: iso,
      vendors: this.listVendors(),
      purchaseOrder: this.purchaseOrderFor(i),
      vendorSpentToday: Object.fromEntries(perVendor.map((r) => [r.vendor_id, r.total])),
      totalSpentToday: totalToday.t,
      paymentsLastHour: recent.n,
    };
  }

  /** The vendor's open purchase order closest to the intent amount. Only used to check untrusted amounts. */
  private purchaseOrderFor(i: ResolvedIntent): PurchaseOrder | null {
    if (isTrusted(i.amount.trust)) return null;
    const vendor = this.matchVendor(i);
    if (!vendor) return null;
    const row = this.db
      .prepare(
        `SELECT id, vendor_id, amount, currency FROM purchase_orders
         WHERE vendor_id = ? AND status = 'open' ORDER BY ABS(amount - ?), id LIMIT 1`,
      )
      .get(vendor.id, i.amount.value) as PoRow | undefined;
    return row ? { id: row.id, vendorId: row.vendor_id, amount: row.amount, currency: row.currency } : null;
  }
}
