import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { useMemo, useState } from "react";
import { api, type AdjustmentRecord, type BankLine, type LedgerEntry, type ReconItem, type ReconView } from "../api";
import { Card, Empty, ErrorNote } from "../components/ui";
import { usePoll } from "../hooks";
import { dateTime, money, reconReason } from "../labels";
import { gridTheme } from "../theme";

const NAME_KEY = "pfw.approver";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

/** A person can settle these by naming the payment. The others (amount, receiver, currency, purchase order) cannot be cleared that way. Must equal CONFIRMABLE_REASONS in @pfw/recon (a test checks it). */
export const CONFIRMABLE = new Set(["reference_unknown", "no_candidate", "several_candidates", "competing_bank_lines"]);

interface Notice {
  id: number;
  ok: boolean;
  text: string;
}
let noticeSeq = 0;

export function Recon({ onChange }: { onChange: () => void }) {
  const { data, error, refresh } = usePoll(api.recon, 3000);
  const [name, setName] = useState(readName);
  const [busy, setBusy] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState("");

  const notify = (ok: boolean, text: string) => setNotices((n) => [{ id: ++noticeSeq, ok, text }, ...n].slice(0, 5));
  const done = () => {
    void refresh();
    onChange();
  };

  /** Runs one operator action: needs a name, shows the server's reason on failure, and reports success once. */
  const act = async <T,>(okText: string | ((result: T) => string), fn: (who: string) => Promise<T>) => {
    const who = name.trim();
    if (!who) {
      notify(false, "Enter your name so this is attributed to you.");
      return false;
    }
    try {
      localStorage.setItem(NAME_KEY, who);
    } catch {
      /* private mode: skip remembering */
    }
    setBusy(true);
    try {
      const result = await fn(who);
      notify(true, typeof okText === "function" ? okText(result) : okText);
      done();
      return true;
    } catch (e) {
      notify(false, e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const view = data;
  const ledger = useMemo(() => new Map((view?.ledger ?? []).map((l) => [l.key, l])), [view?.ledger]);
  const bank = useMemo(() => new Map((view?.bank ?? []).map((b) => [b.id, b])), [view?.bank]);
  const items = view?.report.items ?? [];
  const queue = items.filter((i) => i.bankLineId !== null && i.status !== "matched");
  const unsettled = items.filter((i) => i.bankLineId === null);
  const matched = items.filter((i) => i.status === "matched");
  const waiting = (view?.adjustments ?? []).filter((a) => a.status === "proposed");
  const resolved = (view?.adjustments ?? []).filter((a) => a.status !== "proposed");

  const submitImport = () =>
    act(
      (r: { added: number; unchanged: number }) => `Imported ${r.added} new line${r.added === 1 ? "" : "s"}${r.unchanged ? `, ${r.unchanged} already known` : ""}. Run reconciliation to match them.`,
      async (who) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          throw new Error("That is not valid JSON. Paste an array of settlement lines.");
        }
        const lines = Array.isArray(parsed) ? parsed : (parsed as { lines?: unknown })?.lines;
        const r = await api.reconImport(lines, who);
        setJson("");
        setImporting(false);
        return r;
      },
    );

  return (
    <div className="stack">
      <Card title="Close and reconciliation" aside={<span className="muted small">PayPal's settlement lines against what the firewall paid. Matching is code; a memo is never used.</span>}>
        {error && <ErrorNote message={error} />}
        {notices.length > 0 && (
          <ul className="notices" aria-live="polite">
            {notices.map((n) => (
              <li key={n.id} className={n.ok ? "ok" : "bad"}>
                <span>{n.text}</span>
                <button className="link" onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))} aria-label="Dismiss">Dismiss</button>
              </li>
            ))}
          </ul>
        )}
        <Totals view={view} />
        <div className="recon-actions">
          <label className="field grow">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="you@company.example" autoComplete="name" />
          </label>
          <div className="buttons">
            <button className="btn" onClick={() => setImporting((v) => !v)} aria-expanded={importing}>Import settlement lines</button>
            <button className="btn primary" disabled={busy} onClick={() => act("Reconciliation run recorded in the audit log.", (who) => api.reconRun(who))}>Run reconciliation</button>
          </div>
        </div>
        {importing && (
          <div className="recon-import">
            <label className="field">
              <span>Settlement lines (JSON array; amounts in cents)</span>
              <textarea value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} placeholder={'[{"id":"bl_1","reference":"PAYOUT-ITEM-ID","amount":45000,"currency":"USD","date":"2026-11-03T10:00:00Z","receiver":"ap@vendor.example","fee":25}]'} />
            </label>
            <div className="buttons">
              <button className="btn primary" disabled={busy || !json.trim()} onClick={() => void submitImport()}>Import</button>
            </div>
          </div>
        )}
      </Card>

      <Card title={`Needs a person${queue.length ? ` · ${queue.length}` : ""}`} aside={<span className="muted small">Anything ambiguous or unmatched waits here. Nothing is settled by guessing.</span>}>
        {queue.length === 0 ? (
          <Empty title="Nothing to review">{bank.size === 0 ? "Import PayPal's settlement lines, then run reconciliation." : "Every settlement line is matched."}</Empty>
        ) : (
          <div className="inbox">
            {queue.map((i) => (
              <QueueItem key={i.id} item={i} bank={bank.get(i.bankLineId!)} ledger={ledger} unsettled={unsettled} busy={busy} onConfirm={(key, note) => act("Match confirmed and recorded.", (who) => api.reconConfirm(i.bankLineId!, key, who, note))} />
            ))}
          </div>
        )}
      </Card>

      <Card title={`Adjustments${waiting.length ? ` · ${waiting.length} waiting` : ""}`} aside={<span className="muted small">Proposed by the matcher, applied only when you approve. Up to {money(view?.config.maxAdjustment ?? 0)} each.</span>}>
        {waiting.length === 0 ? (
          <Empty title="No adjustments waiting">PayPal fees and small differences appear here after a run.</Empty>
        ) : (
          <div className="inbox">
            {waiting.map((a) => (
              <AdjustmentCard key={a.id} a={a} busy={busy} onResolve={(approve, note) => act(approve ? "Adjustment approved." : "Adjustment rejected.", (who) => api.reconAdjustment(a.id, approve, who, note))} />
            ))}
          </div>
        )}
        {resolved.length > 0 && (
          <ul className="origins" aria-label="Resolved adjustments" style={{ marginTop: 14 }}>
            {resolved.map((a) => (
              <li key={a.id}>
                <span className={`status-chip ${a.status === "approved" ? "ok" : "bad"}`}>{a.status === "approved" ? "Approved" : "Rejected"}</span>{" "}
                {adjustmentTitle(a)} {money(Math.abs(a.amount), a.currency)} · {a.resolvedBy} · {a.resolvedAt ? dateTime(a.resolvedAt) : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {unsettled.length > 0 && (
        <Card title={`Paid, no settlement line yet · ${unsettled.length}`}>
          <ul className="origins">
            {unsettled.map((i) => {
              const l = ledger.get(i.ledgerKey!);
              return <li key={i.id}>{l ? paymentLabel(l) : i.ledgerKey}</li>;
            })}
          </ul>
        </Card>
      )}

      {matched.length > 0 && <MatchedGrid items={matched} bank={bank} ledger={ledger} />}
    </div>
  );
}

function Totals({ view }: { view: ReconView | undefined }) {
  const totals = view?.report.totals ?? [];
  if (totals.length === 0) return <p className="muted">No settlement lines yet.</p>;
  return (
    <>
      {totals.map((t) => (
        <div className="kpi-group" key={t.currency}>
          <h3>{t.currency}</h3>
          <div className="kpis">
            <div className="kpi"><b>{money(t.bank, t.currency)}</b><span>PayPal settled</span></div>
            <div className="kpi"><b>{money(t.matched, t.currency)}</b><span>Matched</span></div>
            <div className="kpi"><b>{money(t.ambiguous, t.currency)}</b><span>Ambiguous</span></div>
            <div className="kpi"><b>{money(t.unmatched, t.currency)}</b><span>Unmatched</span></div>
            <div className="kpi"><b>{money(t.ledgerOnly, t.currency)}</b><span>Paid, not yet settled</span></div>
          </div>
        </div>
      ))}
    </>
  );
}

/** A note belongs to the one card it is written on, so it can never ride along with a different action. */
function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field" style={{ marginTop: 12 }}>
      <span>Note for this action (optional)</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. checked against the PayPal statement" />
    </label>
  );
}

const paymentLabel = (l: LedgerEntry) => `${l.payee} · ${money(l.amount, l.currency)} · ${l.receiver} · ${dateTime(l.date)}`;

function QueueItem({ item, bank, ledger, unsettled, busy, onConfirm }: { item: ReconItem; bank: BankLine | undefined; ledger: Map<string, LedgerEntry>; unsettled: ReconItem[]; busy: boolean; onConfirm: (ledgerKey: string, note: string) => void }) {
  const confirmable = CONFIRMABLE.has(item.reason);
  const offered = [...new Set([...item.candidates, ...unsettled.map((u) => u.ledgerKey!)])].filter((k) => ledger.has(k));
  const paired = item.ledgerKey ? ledger.get(item.ledgerKey) : undefined;
  const [note, setNote] = useState("");
  return (
    <article className="qitem">
      <header>
        <div>
          <p className="eyebrow">{reconReason(item.reason)}</p>
          <h3>{money(item.amount, item.currency)} settled{bank?.receiver ? ` to ${bank.receiver}` : ""}</h3>
        </div>
        <span className={`status-chip ${item.status === "ambiguous" ? "warn" : "bad"}`}>{item.status === "ambiguous" ? "Ambiguous" : "Unmatched"}</span>
      </header>
      <p className="held-reason">{item.explanation}</p>
      <dl className="qmeta">
        <dt>Line</dt><dd><code>{item.bankLineId}</code></dd>
        {bank?.reference && (<><dt>PayPal reference</dt><dd><code>{bank.reference}</code></dd></>)}
        {bank?.senderRef && (<><dt>Our request id</dt><dd><code>{bank.senderRef}</code></dd></>)}
        {bank && (<><dt>Date</dt><dd>{dateTime(bank.date)}</dd></>)}
        {item.fee > 0 && (<><dt>PayPal fee</dt><dd>{money(item.fee, item.currency)}</dd></>)}
        {paired && (<><dt>Authorized payment</dt><dd>{paymentLabel(paired)}</dd></>)}
        {item.difference !== 0 && (<><dt>Difference</dt><dd>{money(item.difference, item.currency)}</dd></>)}
      </dl>
      {bank?.memo && (
        <blockquote className="qmemo">
          <small>Memo from PayPal: untrusted text, shown for you to read, never used to match</small>
          {bank.memo}
        </blockquote>
      )}
      {confirmable ? (
        offered.length === 0 ? (
          <p className="muted" style={{ marginTop: 12 }}>No unsettled payment is available to match this line to. It may be money we did not authorize: check it in PayPal.</p>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 12 }}>
              {item.reason === "reference_unknown" ? "This line has a reference we do not recognise. Only confirm a match if you have checked it elsewhere." : "If you are sure, confirm which payment this line is:"}
            </p>
            <NoteField value={note} onChange={setNote} />
            <ul className="cands">
              {offered.map((k) => (
                <li key={k}>
                  <span>{paymentLabel(ledger.get(k)!)}</span>
                  <button className="btn" disabled={busy} onClick={() => onConfirm(k, note)} aria-label={`This line is the payment to ${ledger.get(k)!.payee} for ${money(ledger.get(k)!.amount, ledger.get(k)!.currency)}`}>This is it</button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : (
        <p className="muted" style={{ marginTop: 12 }}>
          {item.reason === "amount_difference" ? "Confirming cannot clear a difference. Approve the adjustment below if it is small and explained, or investigate it in PayPal." : "Confirming cannot clear this. Investigate it in PayPal."}
        </p>
      )}
    </article>
  );
}

const adjustmentTitle = (a: AdjustmentRecord) => (a.kind === "fee" ? "PayPal fee" : a.amount < 0 ? "Settled short by" : "Settled over by");

function AdjustmentCard({ a, busy, onResolve }: { a: AdjustmentRecord; busy: boolean; onResolve: (approve: boolean, note: string) => void }) {
  const e = a.evidence;
  const [note, setNote] = useState("");
  return (
    <article className="qitem adj">
      <header>
        <div>
          <p className="eyebrow">{a.kind === "fee" ? "Book the fee" : "Explain a difference"}</p>
          <h3>{adjustmentTitle(a)} {money(Math.abs(a.amount), a.currency)}</h3>
        </div>
        <div className="buttons">
          <button className="btn danger" disabled={busy} onClick={() => onResolve(false, note)}>Reject</button>
          <button className="btn primary" disabled={busy} onClick={() => onResolve(true, note)}>Approve {money(Math.abs(a.amount), a.currency)}</button>
        </div>
      </header>
      <dl className="qmeta">
        <dt>Evidence</dt>
        <dd>Line <code>{e.bankLineId}</code> settled {money(e.bankAmount, a.currency)}; payment <code>{e.ledgerKey}</code> authorized {money(e.ledgerAmount, a.currency)}{e.fee > 0 ? `; fee ${money(e.fee, a.currency)}` : ""}.</dd>
        <dt>Proposed</dt><dd>{dateTime(a.proposedAt)}</dd>
      </dl>
      <NoteField value={note} onChange={setNote} />
    </article>
  );
}

function MatchedGrid({ items, bank, ledger }: { items: ReconItem[]; bank: Map<string, BankLine>; ledger: Map<string, LedgerEntry> }) {
  const cols = useMemo<ColDef<ReconItem>[]>(
    () => [
      { headerName: "Payee", valueGetter: (p) => ledger.get(p.data?.ledgerKey ?? "")?.payee ?? "", flex: 1, minWidth: 150 },
      { headerName: "Amount", field: "amount", type: "rightAligned", width: 130, valueFormatter: (p) => money(p.value as number, p.data?.currency) },
      { headerName: "How", field: "reason", width: 220, valueFormatter: (p) => reconReason(p.value as string) },
      {
        headerName: "Purchase order",
        width: 270,
        valueGetter: (p) => {
          const inv = p.data?.invoice;
          if (!inv || inv.status === "none") return "none";
          // A payment allowed within the policy's tolerance differs from its purchase order: show both numbers.
          return inv.poAmount !== undefined && inv.poAmount !== p.data?.amount ? `${inv.poId} (PO ${money(inv.poAmount, p.data?.currency)})` : (inv.poId ?? "");
        },
      },
      { headerName: "Settled", valueGetter: (p) => bank.get(p.data?.bankLineId ?? "")?.date ?? "", width: 190, valueFormatter: (p) => (p.value ? dateTime(p.value as string) : "") },
    ],
    [bank, ledger],
  );
  return (
    <Card title={`Matched · ${items.length}`}>
      <div className="grid-wrap" style={items.length > 8 ? { height: 420 } : undefined}>
        <AgGridReact<ReconItem> theme={gridTheme} rowData={items} columnDefs={cols} defaultColDef={{ sortable: true, resizable: true, filter: true }} getRowId={(p) => p.data.id} domLayout={items.length > 8 ? "normal" : "autoHeight"} suppressCellFocus />
      </div>
    </Card>
  );
}
