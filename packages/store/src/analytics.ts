import type Database from "better-sqlite3";

export interface DayBucket {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Requests that ended in a payment (allowed, or held and then approved). */
  paid: number;
  /** Held for approval and still waiting for a person. */
  waiting: number;
  /** Denied, or held and then rejected. */
  blocked: number;
}

export interface Analytics {
  from: string;
  to: string;
  days: number;
  totals: {
    requests: number;
    paid: { count: number; amount: number };
    waiting: { count: number; amount: number };
    blocked: { count: number; amount: number };
    /** Decisions that raised an alert (for example a payee swap). */
    alerts: number;
  };
  /** One entry per UTC day in the window, oldest first, including days with nothing. Counted by the day the request was made. */
  daily: DayBucket[];
  /** Why payments were stopped or held: the rule that decided each one, most frequent first. */
  rules: { rule: string; verdict: "deny" | "require_approval"; count: number; amount: number }[];
  /** Registered vendors by amount paid in the window, largest first. Payments to payees not in the registry are one row with a null id. */
  vendors: { id: string | null; name: string; paid: number; count: number }[];
  /** Paid this UTC month to registered vendors, by the vendor's category on file. Not scoped by `days`. */
  categorySpendThisMonth: Record<string, number>;
}

interface Row {
  created_at: string;
  verdict: string;
  decision_json: string;
  approval_status: string | null;
  paid_amount: number | null;
  vendor_id: string | null;
  vendor_name: string | null;
  paid: number | null;
}

const MAX_ROWS = 50_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Read-only summary of what the firewall decided over the last `days` UTC days (including today). Everything here is derived from
 * the append-only decisions and the payments table; it writes nothing. Amounts are integer minor units.
 */
export function analytics(db: Database.Database, now: Date, days: number): Analytics {
  const n = Math.min(Math.max(Math.trunc(days) || 30, 1), 366);
  const today = dayOf(now.toISOString());
  const first = addDays(today, -(n - 1));
  const since = `${first}T00:00:00.000Z`;
  const monthStart = `${today.slice(0, 7)}-01T00:00:00.000Z`;

  const rows = db
    .prepare(
      `SELECT d.created_at, d.verdict, d.decision_json, a.status AS approval_status,
              p.amount AS paid_amount, p.idempotency_key AS paid, p.vendor_id, v.name AS vendor_name
         FROM decisions d
         LEFT JOIN approvals a ON a.idempotency_key = d.idempotency_key
         LEFT JOIN payments p ON p.idempotency_key = d.idempotency_key
         LEFT JOIN vendors v ON v.id = p.vendor_id
        WHERE d.created_at >= ?
        ORDER BY d.rowid DESC LIMIT ?`,
    )
    .all(since, MAX_ROWS) as unknown as Row[];

  const daily = new Map<string, DayBucket>();
  for (let i = 0; i < n; i++) daily.set(addDays(first, i), { date: addDays(first, i), paid: 0, waiting: 0, blocked: 0 });
  const totals: Analytics["totals"] = { requests: 0, paid: { count: 0, amount: 0 }, waiting: { count: 0, amount: 0 }, blocked: { count: 0, amount: 0 }, alerts: 0 };
  const rules = new Map<string, { rule: string; verdict: "deny" | "require_approval"; count: number; amount: number }>();
  const vendors = new Map<string, { id: string | null; name: string; paid: number; count: number }>();

  for (const r of rows) {
    let decision: { rule?: string; alert?: boolean; fields?: { amount?: { value?: unknown } } };
    try {
      decision = JSON.parse(r.decision_json);
    } catch {
      continue;
    }
    const raw = decision.fields?.amount?.value;
    const requested = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    const bucket = daily.get(dayOf(r.created_at));
    totals.requests++;
    if (decision.alert) totals.alerts++;

    // A request ends in one of three ways. Paid means a payment row exists, whether it was allowed outright or approved by a person.
    const kind = r.paid !== null ? "paid" : r.verdict === "deny" || r.approval_status === "rejected" ? "blocked" : "waiting";
    const amount = kind === "paid" ? (r.paid_amount ?? requested) : requested;
    totals[kind].count++;
    totals[kind].amount += amount;
    if (bucket) bucket[kind]++;

    if (r.verdict === "deny" || r.verdict === "require_approval") {
      const rule = typeof decision.rule === "string" ? decision.rule : "unknown";
      const k = `${r.verdict}|${rule}`;
      const e = rules.get(k) ?? { rule, verdict: r.verdict, count: 0, amount: 0 };
      e.count++;
      e.amount += requested;
      rules.set(k, e);
    }
    if (kind === "paid") {
      const key = r.vendor_id ?? "";
      const e = vendors.get(key) ?? { id: r.vendor_id, name: r.vendor_name ?? "Not in the registry (approved by a person)", paid: 0, count: 0 };
      e.paid += amount;
      e.count++;
      vendors.set(key, e);
    }
  }

  const spend = db
    .prepare("SELECT v.category AS category, SUM(p.amount) AS total FROM payments p JOIN vendors v ON v.id = p.vendor_id WHERE p.created_at >= ? GROUP BY v.category")
    .all(monthStart) as unknown as { category: string; total: number }[];

  return {
    from: first,
    to: today,
    days: n,
    totals,
    daily: [...daily.values()],
    rules: [...rules.values()].sort((a, b) => b.count - a.count || b.amount - a.amount).slice(0, 8),
    vendors: [...vendors.values()].sort((a, b) => b.paid - a.paid).slice(0, 8),
    categorySpendThisMonth: Object.fromEntries(spend.map((s) => [s.category, s.total])),
  };
}
