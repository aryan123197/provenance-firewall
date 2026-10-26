import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  canonicalJson,
  evaluate,
  isTrusted,
  type Decision,
  type Policy,
  type PolicyState,
  type PurchaseOrder,
  type ResolvedIntent,
  type VendorRecord,
} from "@pfw/core";
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

export interface StoreOptions {
  path?: string;
  clock?: () => Date;
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

interface VendorRow { id: string; name: string; account: string; category: string }
interface PoRow { id: string; vendor_id: string; amount: number; currency: string }

export class Store {
  /** Exposed for tests and operator tooling; the firewall only uses the methods below. */
  readonly db: Database.Database;
  private readonly clock: () => Date;

  constructor(opts: StoreOptions = {}) {
    this.db = new Database(opts.path ?? ":memory:");
    this.clock = opts.clock ?? (() => new Date());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
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

      if (decision.verdict === "allow") {
        const vendor = this.matchVendor(intent);
        this.db
          .prepare("INSERT INTO payments (idempotency_key, agent_id, vendor_id, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(intent.idempotencyKey, intent.agentId, vendor?.id ?? null, intent.amount.value, intent.currency.value, at);
      }
      return { decision, replayed: false };
    }).immediate();
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
