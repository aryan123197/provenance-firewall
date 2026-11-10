import { useState, type ReactNode } from "react";
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
export function Spend({ demo = false }: { demo?: boolean }) {
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
      <Budgets data={data} />
      {demo && <BudgetDemo />}
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

const NAME_KEY = "pfw.approver";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

/** Monthly budgets: progress for the ones set, and a form to set or remove one. Changing one is a tested, attributed policy change. */
function Budgets({ data }: { data: SpendOverview }) {
  const { data: registry } = usePoll(api.registry, 10_000);
  const [vendor, setVendor] = useState("");
  const [dollars, setDollars] = useState("");
  const [name, setName] = useState(readName);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const cur = data.totals[0]?.currency ?? "USD";

  const apply = async (vendorId: string, amountMinor: number | null) => {
    if (!name.trim()) return setNote({ ok: false, text: "Enter your name so the change is attributed to you." });
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* private mode: skip remembering */
    }
    setBusy(true);
    try {
      const r = await api.setBudget(vendorId, amountMinor, name.trim());
      setNote({ ok: true, text: amountMinor === null ? `Removed the budget for ${vendorId} (policy v${r.version}).` : `Budget set for ${vendorId} (policy v${r.version}). It applies from the next payment.` });
      if (amountMinor !== null) setDollars("");
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Could not change the budget." });
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const n = Number(dollars);
    if (!vendor) return setNote({ ok: false, text: "Choose a vendor." });
    if (dollars.trim() === "" || !Number.isFinite(n) || n < 0) return setNote({ ok: false, text: "Enter the monthly budget in dollars, for example 2000." });
    void apply(vendor, Math.round(n * 100));
  };

  return (
    <Card title="Monthly budgets" aside="This UTC month. Past a budget, a payment is held for a person.">
      {data.budgets.length === 0 ? (
        <p className="muted">No budgets set. Without one, only the daily caps limit a vendor.</p>
      ) : (
        data.budgets.map((b) => {
          const over = b.spent > b.budget;
          return (
            <div className="bar-row budget-row" key={b.vendorId}>
              <span>{b.name}</span>
              <div className="bar" aria-hidden="true">
                <i className={over ? "bad" : "good"} style={{ width: `${b.budget > 0 ? Math.min(100, Math.round((b.spent / b.budget) * 100)) : 100}%` }} />
              </div>
              <span>
                {money(b.spent, cur)} of {money(b.budget, cur)}{over ? " · over" : ""}{" "}
                <button type="button" className="link" disabled={busy} onClick={() => void apply(b.vendorId, null)} aria-label={`Remove the budget for ${b.name}`}>Remove</button>
              </span>
            </div>
          );
        })
      )}
      <div className="row budget-form">
        <label className="field">
          <span>Vendor</span>
          <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">Choose…</option>
            {(registry?.vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Budget per month ({cur})</span>
          <input inputMode="decimal" value={dollars} onChange={(e) => setDollars(e.target.value)} placeholder="2000" />
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="you@company.example" autoComplete="name" />
        </label>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Set budget"}</button>
      </div>
      {note && <p className={`result ${note.ok ? "ok" : "bad"}`} role="status">{note.text}</p>}
    </Card>
  );
}

/**
 * Demo only: shows a budget holding a payment, live. Sets Acme's monthly budget below the invoice, then runs the ordinary
 * "invoice matches the purchase order" scenario, which would normally be paid. The scenario list and scorecard are untouched.
 */
function BudgetDemo() {
  const { data: registry } = usePoll(api.registry, 10_000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; held?: boolean } | null>(null);
  const acme = registry?.vendors.find((v) => v.name === "Acme Supplies");

  const run = async () => {
    if (!acme) return;
    setBusy(true);
    setResult(null);
    try {
      await api.setBudget(acme.id, 40_000, "demo");
      const r = await api.runScenario("legit-po-match", "scripted");
      const call = r.firewalled.calls[0];
      const held = r.firewalled.pendingApprovals > 0;
      setResult({ ok: true, held, text: held ? `Held for approval${call?.rule ? ` (${call.rule})` : ""}: ${call?.message ?? ""}` : `Not held: ${call?.message ?? "no call was made"}` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "The demo could not run." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Try a budget" aside="Demo mode">
      <p className="muted">
        Sets Acme Supplies' monthly budget to $400.00, then asks the agent to pay Acme's $450.00 invoice, a payment that is otherwise paid automatically.
      </p>
      {!acme && registry && <p className="muted">Acme Supplies is not in the registry, so this demo cannot run.</p>}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !acme} onClick={() => void run()}>{busy ? "Running…" : "Set the budget and pay the invoice"}</button>
      </div>
      {result && (
        <p className={`result ${result.ok ? "ok" : "bad"}`} role="status">
          {result.text}{" "}
          {result.held && <a href="#/approvals">Review it in Approvals</a>}
        </p>
      )}
    </Card>
  );
}
