import type { ReactNode } from "react";
import { api, type SpendLine, type SpendOverview } from "../api";
import { Card, Empty, ErrorNote } from "../components/ui";
import { usePoll } from "../hooks";
import { money } from "../labels";

type Total = SpendOverview["totals"][number];

const sum = (totals: Total[], currency: string, statuses: string[]) =>
  totals.filter((t) => t.currency === currency && statuses.includes(t.status)).reduce((n, t) => n + t.amount, 0);
const count = (totals: Total[], currency: string, statuses: string[]) =>
  totals.filter((t) => t.currency === currency && statuses.includes(t.status)).reduce((n, t) => n + t.count, 0);

/** Tables scroll inside their card on a phone instead of widening the page; focusable so a keyboard can scroll them. */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable (axe: scrollable-region-focusable)
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** A bar whose width is a share of the largest value; the number beside it carries the meaning, so the bar is decoration. */
function Bar({ value, max, tone }: { value: number; max: number; tone: "good" | "bad" }) {
  return (
    <div className="bar" aria-hidden="true">
      <i className={tone} style={{ width: `${max > 0 ? Math.max(value > 0 ? 3 : 0, Math.round((value / max) * 100)) : 0}%` }} />
    </div>
  );
}

const STATUS_WORD: Record<SpendLine["status"], string> = {
  paid: "Paid",
  sent: "Sent, not confirmed",
  attention: "Needs attention",
  failed: "Failed at PayPal",
  held: "Held for approval",
  queued: "Allowed, not sent",
  denied: "Denied",
};

/**
 * Read-only view of where money went. Everything here is a roll-up of decisions the firewall already made;
 * nothing on this screen can change a decision. Each currency is shown on its own and never added to another.
 */
export function Spend() {
  const { data, error } = usePoll(api.spend, 5000);
  if (!data) return error ? <ErrorNote message={error} /> : <p className="muted">Loading…</p>;
  const currencies = [...new Set(data.totals.map((t) => t.currency))].sort();

  return (
    <div className="stack">
      <p className="muted">
        A roll-up of every payment decision. Days are UTC, the same as the daily caps. “Money protected” is what the firewall denied or a person rejected: it never moved.
      </p>
      {error && <ErrorNote message={error} />}
      {currencies.length === 0 && (
        <Empty title="No payments yet">Run a scenario on Live activity and the totals appear here.</Empty>
      )}
      {currencies.map((c) => (
        <CurrencySection key={c} currency={c} data={data} />
      ))}
      {data.budgets.length > 0 && (
        <Card title="Monthly budgets" aside="This UTC month. Past a budget, a payment is held for a person.">
          {data.budgets.map((b) => {
            const over = b.spent > b.budget;
            const cur = data.totals[0]?.currency ?? "USD";
            return (
              <div className="bar-row" key={b.vendorId}>
                <span>{b.name}</span>
                <div className="bar" aria-hidden="true">
                  <i className={over ? "bad" : "good"} style={{ width: `${b.budget > 0 ? Math.min(100, Math.round((b.spent / b.budget) * 100)) : 100}%` }} />
                </div>
                <span>{money(b.spent, cur)} of {money(b.budget, cur)}{over ? " · over" : ""}</span>
              </div>
            );
          })}
        </Card>
      )}
      <Card title={`Open purchase orders · ${data.openCommitments.length}`} aside="Approved to buy, not yet paid">
        {data.openCommitments.length === 0 ? (
          <p className="muted">Nothing outstanding.</p>
        ) : (
          <Scroll label="Open purchase orders">
          <table>
            <thead>
              <tr><th scope="col">Order</th><th scope="col">Vendor</th><th scope="col">Amount</th></tr>
            </thead>
            <tbody>
              {data.openCommitments.map((p) => (
                <tr key={p.id}><td><code>{p.id}</code></td><td>{p.vendorName}</td><td>{money(p.amount, p.currency)}</td></tr>
              ))}
            </tbody>
          </table>
          </Scroll>
        )}
      </Card>
      {data.needsAttention.length > 0 && (
        <Card title={`Needs attention · ${data.needsAttention.length}`} aside="Sent payouts PayPal did not confirm as paid, and failed sends">
          <Scroll label="Payouts needing attention">
          <table>
            <thead>
              <tr><th scope="col">Payee</th><th scope="col">Amount</th><th scope="col">State</th></tr>
            </thead>
            <tbody>
              {data.needsAttention.map((l) => (
                <tr key={l.idempotencyKey}>
                  <td><a href={`#/decision/${encodeURIComponent(l.idempotencyKey)}`}>{l.payee}</a></td>
                  <td>{money(l.amount, l.currency)}</td>
                  <td>{STATUS_WORD[l.status]}{l.providerStatus ? ` · PayPal ${l.providerStatus}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </Scroll>
        </Card>
      )}
      <p>
        <a href="/api/spend/export.csv" download>Download the ledger as CSV</a>
      </p>
    </div>
  );
}

function CurrencySection({ currency, data }: { currency: string; data: SpendOverview }) {
  const t = data.totals;
  const days = data.byDay.filter((d) => d.currency === currency).slice(-14);
  const vendors = data.byVendor.filter((v) => v.currency === currency);
  const protectedNow = data.moneyProtected.find((p) => p.currency === currency);
  const maxDay = Math.max(0, ...days.map((d) => d.spent));
  const maxVendor = Math.max(0, ...vendors.map((v) => v.spent));

  return (
    <Card title={`Spend in ${currency}`}>
      <div className="kpis">
        <div className="kpi"><b>{money(sum(t, currency, ["paid"]), currency)}</b><span>Paid · {count(t, currency, ["paid"])}</span></div>
        <div className="kpi"><b>{money(sum(t, currency, ["sent", "attention"]), currency)}</b><span>Sent, not confirmed paid · {count(t, currency, ["sent", "attention"])}</span></div>
        <div className="kpi"><b>{money(sum(t, currency, ["held", "queued"]), currency)}</b><span>Waiting for approval · {count(t, currency, ["held", "queued"])}</span></div>
        <div className="kpi"><b>{money(protectedNow?.amount ?? 0, currency)}</b><span>Money protected · {protectedNow?.count ?? 0} blocked</span></div>
      </div>

      <div className="kpi-group">
        <h3>By day (money sent)</h3>
        {days.length === 0 ? (
          <p className="muted">No days yet.</p>
        ) : (
          days.map((d) => (
            <div className="bar-row" key={d.day}>
              <span>{d.day.slice(5)}</span>
              <Bar value={d.spent} max={maxDay} tone="good" />
              <span>{money(d.spent, currency)}</span>
            </div>
          ))
        )}
      </div>

      <div className="kpi-group">
        <h3>By vendor</h3>
        <Scroll label={`Spend by vendor in ${currency}`}>
        <table>
          <thead>
            <tr><th scope="col">Payee</th><th scope="col">Payments</th><th scope="col">Sent</th><th scope="col">Held</th><th scope="col">Blocked</th></tr>
          </thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={`${v.vendorId ?? "?"}|${v.name}`}>
                <td>{v.name}{v.vendorId === null && <span className="muted"> · not in registry</span>}</td>
                <td>{v.payments}</td>
                <td>
                  {money(v.spent, currency)}
                  <Bar value={v.spent} max={maxVendor} tone="good" />
                </td>
                <td>{money(v.held, currency)}</td>
                <td>{money(v.blocked, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </Scroll>
      </div>
    </Card>
  );
}
