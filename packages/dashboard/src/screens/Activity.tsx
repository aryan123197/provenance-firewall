import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useMemo, useRef, useState } from "react";
import { api, type DecisionSummary, type DemoRun, type DemoScenario } from "../api";
import { Card, Empty, ErrorNote, TrustChip, VerdictPill } from "../components/ui";
import { useNarrow, usePoll } from "../hooks";
import { CATEGORY_LABEL, money, outcome, ruleTitle, time } from "../labels";
import { gridTheme } from "../theme";

/**
 * The activity grid's columns. On a narrow screen only what identifies a payment stays (verdict, payee, amount): the time, the rule,
 * the payee's source and the outcome are all on the decision page one tap away, and cramming them in leaves the payee off screen.
 */
export function activityColumns(narrow: boolean): ColDef<DecisionSummary>[] {
  const all: ColDef<DecisionSummary>[] = [
      {
        headerName: "Time",
        field: "createdAt",
        width: 118,
        sort: "desc",
        filter: "agDateColumnFilter",
        comparator: (a: string, b: string) => a.localeCompare(b),
        valueFormatter: (p) => time(p.value as string),
        // A real link, so the replay is reachable from the keyboard and by assistive technology, not only by clicking the row.
        cellRenderer: (p: ICellRendererParams<DecisionSummary>) =>
          p.data ? (
            <a href={`#/decision/${encodeURIComponent(p.data.idempotencyKey)}`} aria-label={`Open decision from ${time(p.data.createdAt)}: ${p.data.payee}, ${money(p.data.amount, p.data.currency)}`}>
              {time(p.data.createdAt)}
            </a>
          ) : null,
      },
      { headerName: "Verdict", field: "verdict", width: 164, cellRenderer: (p: ICellRendererParams<DecisionSummary>) => (p.data ? <VerdictPill verdict={p.data.verdict} /> : null) },
      { headerName: "Rule that decided", field: "rule", flex: 1.3, minWidth: 225, valueFormatter: (p) => ruleTitle(p.value as string), cellRenderer: (p: ICellRendererParams<DecisionSummary>) => (p.data ? <span>{ruleTitle(p.data.rule)}{p.data.alert && <span className="alert-dot" title="Raised an alert"> ⚑</span>}</span> : null) },
      {
        headerName: "Payee",
        field: "payee",
        flex: 1.2,
        minWidth: narrow ? 100 : 230,
        // The payee is the key evidence in an attack (the attacker's address), so a long value is readable on hover when it is clipped.
        // On a phone the Time column is gone, so the payee is the link into the decision.
        cellRenderer: (p: ICellRendererParams<DecisionSummary>) =>
          !p.data ? null : narrow ? (
            <a href={`#/decision/${encodeURIComponent(p.data.idempotencyKey)}`} title={p.data.payee} aria-label={`Open decision: ${p.data.payee}, ${money(p.data.amount, p.data.currency)}, ${p.data.verdict.replace("_", " ")}`}>
              {p.data.payee}
            </a>
          ) : (
            <span title={p.data.payee}>{p.data.payee}</span>
          ),
      },
      { headerName: "Amount", field: "amount", width: 130, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => money(p.value as number, p.data?.currency) },
      { headerName: "Source", headerTooltip: "Where the payee came from", field: "payeeTrust", width: 100, filter: "agNumberColumnFilter", cellRenderer: (p: ICellRendererParams<DecisionSummary>) => (p.data ? <TrustChip trust={p.data.payeeTrust} compact /> : null) },
      { headerName: "Outcome", flex: 1, minWidth: 165, valueGetter: (p) => (p.data ? outcome(p.data) : "") },
  ];
  return all.map((c) => {
    // Per-column filter buttons crowd the headers on a phone; the search box and the verdict buttons above the grid do the filtering.
    if (narrow) c = { ...c, suppressHeaderFilterButton: true };
    if (narrow && ["createdAt", "rule", "payeeTrust"].includes(String(c.field))) return { ...c, hide: true };
    if (narrow && c.headerName === "Outcome") return { ...c, hide: true };
    if (narrow && c.field === "verdict") return { ...c, width: 124 };
    if (narrow && c.field === "amount") return { ...c, width: 106 };
    return c;
  });
}

export function Activity({ open, demo, llm, onChange }: { open: (to: string) => void; demo: boolean; llm: boolean; onChange: () => void }) {
  const { data, error, refresh } = usePoll(api.decisions, 2500);
  const [filter, setFilter] = useState("");
  const [verdict, setVerdict] = useState<"all" | DecisionSummary["verdict"]>("all");
  const gridBox = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => (data ?? []).filter((d) => verdict === "all" || d.verdict === verdict), [data, verdict]);

  const narrow = useNarrow();
  const cols = useMemo(() => activityColumns(narrow), [narrow]);

  return (
    <div className="stack">
      {demo && <DemoRunner llm={llm} onRan={() => { void refresh(); onChange(); }} open={open} />}
      <Card
        title="Live activity"
        aside={
          <div className="toolbar">
            <div className="segmented" role="group" aria-label="Filter by verdict">
              {(["all", "allow", "require_approval", "deny"] as const).map((v) => (
                <button key={v} aria-pressed={verdict === v} onClick={() => setVerdict(v)}>
                  {v === "all" ? "All" : v === "allow" ? "Allowed" : v === "deny" ? "Denied" : "Needs approval"}
                </button>
              ))}
            </div>
            <input className="search" type="search" placeholder="Search payee, rule, outcome" aria-label="Search activity" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        }
      >
        {error && <ErrorNote message={error} />}
        {rows.length > 0 && (
          <a
            className="skip-inline"
            href="#decisions"
            onClick={(e) => {
              // The grid puts every column header and filter in the tab order; this jumps straight to the first decision.
              e.preventDefault();
              gridBox.current?.querySelector<HTMLAnchorElement>(".ag-row a")?.focus();
            }}
          >
            Skip to the decisions
          </a>
        )}
        {data && data.length === 0 ? (
          <Empty title="No payment intents yet">
            {demo ? "Run an attack scenario above to see the firewall decide." : "Decisions appear here the moment an agent proposes a payment."}
          </Empty>
        ) : (
          <div className="grid-wrap" ref={gridBox} style={rows.length > 12 ? { height: 560 } : undefined}>
            <AgGridReact<DecisionSummary>
              theme={gridTheme}
              rowData={rows}
              columnDefs={cols}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
              quickFilterText={filter}
              getRowId={(p) => p.data.idempotencyKey}
              onRowClicked={(e) => e.data && open(`/decision/${encodeURIComponent(e.data.idempotencyKey)}`)}
              rowClass="clickable"
              animateRows={false}
              domLayout={rows.length > 12 ? "normal" : "autoHeight"}
              overlayNoRowsTemplate="No rows match these filters"
              suppressCellFocus
            />
          </div>
        )}
        <p className="hint">Click a row to see why. Every decision, including denials, is written to the signed audit log.</p>
      </Card>
    </div>
  );
}

function DemoRunner({ open, onRan, llm }: { open: (to: string) => void; onRan: () => void; llm: boolean }) {
  const { data: scenarios } = usePoll(api.scenarios, 60000);
  const [id, setId] = useState("inj-note-redirect");
  const [busy, setBusy] = useState(false);
  const [agent, setAgent] = useState<"scripted" | "llm">("scripted");
  const [request, setRequest] = useState("");
  const [run, setRun] = useState<DemoRun | undefined>();
  const [err, setErr] = useState<string | undefined>();

  const grouped = useMemo(() => {
    const g = new Map<string, DemoScenario[]>();
    for (const s of scenarios ?? []) g.set(s.category, [...(g.get(s.category) ?? []), s]);
    return [...g.entries()];
  }, [scenarios]);
  const current = scenarios?.find((s) => s.id === id);

  const go = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      setRun(await api.runScenario(id, agent, agent === "llm" ? request.trim() : undefined));
      onRan();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Try an attack"
      aside={
        <button
          className="btn subtle"
          onClick={async () => {
            await api.resetDemo();
            setRun(undefined);
            onRan();
          }}
        >
          Reset demo data
        </button>
      }
    >
      <div className="runner">
        <label className="field">
          <span>Scenario</span>
          <select value={id} onChange={(e) => { setId(e.target.value); setRun(undefined); }}>
            {grouped.map(([cat, list]) => (
              <optgroup key={cat} label={CATEGORY_LABEL[cat] ?? cat}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {llm && (
          <div className="segmented" role="group" aria-label="Which agent">
            <button aria-pressed={agent === "scripted"} onClick={() => setAgent("scripted")} title="A deterministic stand-in that does whatever a document says. The worst case.">Scripted (worst case)</button>
            <button aria-pressed={agent === "llm"} onClick={() => setAgent("llm")} title="A live Claude model reading the same documents">Claude (live)</button>
          </div>
        )}
        <button className="btn primary" onClick={go} disabled={busy || !scenarios}>
          {busy ? (agent === "llm" ? "Claude is working…" : "Running…") : "Run it"}
        </button>
      </div>
      {llm && agent === "llm" && (
        <label className="field" style={{ marginTop: 10 }}>
          <span>What the user asks (optional)</span>
          <input value={request} onChange={(e) => setRequest(e.target.value)} placeholder={current?.request ?? "Order toner from Acme, budget $200"} maxLength={500} />
        </label>
      )}
      {current && <p className="muted">{current.description} <em>User asked: “{current.request}”</em></p>}
      {err && <ErrorNote message={err} />}
      {run && <RunResult run={run} open={open} />}
      <DriftDemo onDone={onRan} />
    </Card>
  );
}

function RunResult({ run, open }: { run: DemoRun; open: (to: string) => void }) {
  const lost = run.baseline.score.unauthorizedAmount;
  const fw = run.firewalled;
  return (
    <div className="versus">
      <div className="side baseline">
        <h3>Unprotected agent</h3>
        <small>{run.agentKind === "llm" ? `${run.agent} · ` : ""}holds PayPal credentials · simulated PayPal</small>
        {run.baseline.payouts.length === 0 ? (
          <p className="big neutral">Paid nothing</p>
        ) : (
          <>
            <p className={`big ${lost > 0 ? "bad" : "good"}`}>{lost > 0 ? `Lost ${money(lost)}` : `Paid ${money(run.baseline.payouts.reduce((a, p) => a + p.amount, 0))}`}</p>
            <ul className="payouts">
              {run.baseline.payouts.map((p, i) => (
                <li key={i}>
                  {money(p.amount, p.currency)} → <code>{p.receiver}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="side firewalled">
        <h3>Same agent, with the firewall</h3>
        <small>no credentials · every payment decided by policy</small>
        <ul className="calls">
          {fw.calls.map((c) => (
            <li key={c.key}>
              <button className="link" onClick={() => open(`/decision/${encodeURIComponent(c.key)}`)}>
                <span className={`dot ${c.status === "executed" ? "allow" : c.status === "needs_approval" ? "approve" : "deny"}`} />
                {c.status === "executed" ? "Paid" : c.status === "needs_approval" ? "Held for approval" : c.status === "denied" ? "Denied" : c.status}
                {c.rule ? ` · ${ruleTitle(c.rule)}` : ""}
              </button>
            </li>
          ))}
        </ul>
        {fw.payouts.length > 0 && (
          <p className={fw.score.unauthorizedPayouts > 0 ? "big bad" : "big good"}>
            {fw.score.unauthorizedPayouts > 0 ? `Lost ${money(fw.score.unauthorizedAmount)} (capped)` : `Paid ${money(fw.payouts.reduce((a, p) => a + p.amount, 0))} as intended`}
          </p>
        )}
        {fw.payouts.length === 0 && <p className="big good">No money moved{fw.pendingApprovals ? ` · ${fw.pendingApprovals} waiting for you` : ""}</p>}
        {fw.pendingApprovals > 0 && (
          <button className="btn" onClick={() => open("/approvals")}>
            Open approval inbox
          </button>
        )}
      </div>
    </div>
  );
}

/** Reconciliation without a live PayPal: have the (simulated) provider report something that does not match our records. */
function DriftDemo({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | undefined>();
  const go = async (kind: "unauthorized" | "mismatch") => {
    setMsg(undefined);
    try {
      await api.simulateDrift(kind);
      setMsg({ ok: true, text: "Reported. A drift banner now shows at the top of every screen." });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="drift-demo">
      <span className="muted small">Reconciliation demo:</span>
      <button className="btn subtle" onClick={() => go("unauthorized")}>PayPal reports a payment we never authorized</button>
      <button className="btn subtle" onClick={() => go("mismatch")}>PayPal reports a different amount for a payment we made</button>
      {msg && <span className={`small ${msg.ok ? "ok-text" : "bad-text"}`} role="status">{msg.text}</span>}
    </div>
  );
}
