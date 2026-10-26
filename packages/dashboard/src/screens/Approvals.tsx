import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { useMemo, useState } from "react";
import { api, type Approval } from "../api";
import { Card, Empty, ErrorNote, FieldTable } from "../components/ui";
import { usePoll } from "../hooks";
import { dateTime, money, ruleTitle } from "../labels";
import { gridTheme } from "../theme";

const NAME_KEY = "pfw.approver";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

interface Notice {
  id: number;
  ok: boolean;
  text: string;
}
let noticeSeq = 0;

export function Approvals({ open, onChange }: { open: (to: string) => void; onChange: () => void }) {
  const { data, error, refresh } = usePoll(api.approvals, 2500);
  // A resolved request leaves the inbox, so its outcome is shown here until dismissed rather than inside the card.
  const [notices, setNotices] = useState<Notice[]>([]);
  const notify = (ok: boolean, text: string) => setNotices((n) => [{ id: ++noticeSeq, ok, text }, ...n].slice(0, 5));
  const pending = (data ?? []).filter((a) => a.status === "pending");
  const history = (data ?? []).filter((a) => a.status !== "pending");

  const cols = useMemo<ColDef<Approval>[]>(
    () => [
      { headerName: "Decided", field: "resolvedAt", width: 170, valueFormatter: (p) => (p.value ? dateTime(p.value as string) : ""), sort: "desc" },
      { headerName: "Result", field: "status", width: 120, cellRenderer: (p: { value: string }) => <span className={`status-chip ${p.value === "approved" ? "ok" : "bad"}`}>{p.value === "approved" ? "Approved" : "Rejected"}</span> },
      { headerName: "Payee", valueGetter: (p) => String(p.data?.intent.payee.value ?? ""), flex: 1, minWidth: 150 },
      { headerName: "Amount", valueGetter: (p) => p.data?.intent.amount.value ?? 0, type: "rightAligned", width: 130, valueFormatter: (p) => money(p.value as number) },
      { headerName: "Why it was held", valueGetter: (p) => (p.data ? ruleTitle(p.data.decision.rule) : ""), flex: 1, minWidth: 170 },
      { headerName: "By", field: "resolvedBy", width: 190 },
      { headerName: "Note", field: "note", flex: 1, minWidth: 140 },
    ],
    [],
  );

  return (
    <div className="stack">
      <Card title={`Approval inbox${pending.length ? ` · ${pending.length} waiting` : ""}`} aside={<span className="muted small">Approving binds to this exact payment and works once.</span>}>
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
        {pending.length === 0 ? (
          <Empty title="Nothing waiting for you">Payments that need a person land here with the evidence to decide.</Empty>
        ) : (
          <div className="inbox">
            {pending.map((a) => (
              <PendingCard key={a.id} a={a} open={open} notify={notify} onDone={() => { void refresh(); onChange(); }} />
            ))}
          </div>
        )}
      </Card>

      {history.length > 0 && (
        <Card title="History">
          <div className="grid-wrap" style={history.length > 8 ? { height: 420 } : undefined}>
            <AgGridReact<Approval>
              theme={gridTheme}
              rowData={history}
              columnDefs={cols}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
              getRowId={(p) => p.data.id}
              onRowClicked={(e) => e.data && open(`/decision/${encodeURIComponent(e.data.idempotencyKey)}`)}
              rowClass="clickable"
              domLayout={history.length > 8 ? "normal" : "autoHeight"}
              suppressCellFocus
            />
          </div>
        </Card>
      )}
    </div>
  );
}

function PendingCard({ a, open, onDone, notify }: { a: Approval; open: (to: string) => void; onDone: () => void; notify: (ok: boolean, text: string) => void }) {
  const [name, setName] = useState(readName);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | undefined>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();
  const d = a.decision;
  const amount = money(Number(a.intent.amount.value), String(a.intent.currency.value));

  const act = async (approve: boolean) => {
    if (!name.trim()) {
      setMsg({ ok: false, text: "Enter your name so the approval is attributed to you." });
      return;
    }
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* private mode: skip remembering */
    }
    setBusy(approve ? "approve" : "reject");
    setMsg(undefined);
    try {
      const r = await api.resolve(a.id, approve, name.trim(), note);
      const who = String(a.intent.payee.value);
      if (r.status === "blocked") setMsg({ ok: false, text: `Cannot approve: ${r.reason} An approval cannot override a hard limit.` });
      else {
        if (r.status === "executed") notify(true, `Approved and paid ${money(r.receipt.amount, r.receipt.currency)} to ${who} (${r.receipt.receiver}).`);
        else if (r.status === "execution_failed") notify(false, `Approved ${who}, but PayPal did not accept it yet. It will retry safely with the same request id.`);
        else notify(true, approve ? `Approved ${who}.` : `Rejected ${who}. Nothing was sent.`);
        onDone();
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <article className="pending">
      <header>
        <div>
          <p className="eyebrow">Requested by <code>{a.intent.agentId}</code> · {dateTime(a.requestedAt)}</p>
          <h3>Pay {amount} to {String(a.intent.payee.value)}</h3>
        </div>
        <button className="link" onClick={() => open(`/decision/${encodeURIComponent(a.idempotencyKey)}`)}>Full replay →</button>
      </header>
      <p className="held-reason"><strong>{ruleTitle(d.rule)}.</strong> {d.reason}</p>
      <FieldTable fields={d.fields} />
      <div className="actions">
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="you@company.example" autoComplete="name" />
        </label>
        <label className="field grow">
          <span>Note (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. confirmed with the vendor by phone" />
        </label>
        <div className="buttons">
          <button className="btn danger" disabled={busy !== undefined} onClick={() => act(false)}>{busy === "reject" ? "Rejecting…" : "Reject"}</button>
          <button className="btn primary" disabled={busy !== undefined} onClick={() => act(true)}>{busy === "approve" ? "Paying…" : `Approve and pay ${amount}`}</button>
        </div>
      </div>
      {msg && <p className={`result ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</p>}
    </article>
  );
}
