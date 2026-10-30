import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Fragment, useMemo } from "react";
import { api, type Drift, type ScenarioResultView } from "../api";
import { Card, Empty, ErrorNote } from "../components/ui";
import { PolicyEditor } from "./PolicyEditor";
import { useNarrow, usePoll } from "../hooks";
import { CATEGORY_LABEL, RULES, dateTime, money, shortHash } from "../labels";
import { gridTheme } from "../theme";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function PolicyScreen() {
  const { data: policy, error, refresh } = usePoll(api.policy, 10000);
  const { data: drift } = usePoll(api.drift, 5000);
  const p = policy?.policy;

  return (
    <div className="stack">
      {drift && drift.some((d) => d.status === "open") && <DriftList drift={drift} />}

      <PolicyEditor view={policy} onActivated={refresh} />

      <div className="two-col">
        <Card title="Active policy" aside={p && <span className="muted small">{p.name} v{p.version} · <code title={p.hash}>{shortHash(p.hash)}</code></span>}>
          {error && <ErrorNote message={error} />}
          {p && (
            <dl className="facts">
              <dt>Approval needed above</dt><dd>{money(p.approvalThreshold, p.currency)}</dd>
              <dt>Amount tolerance vs purchase order</dt><dd>{p.amountToleranceBps / 100}%</dd>
              <dt>Per payment cap</dt><dd>{money(p.limits.perPayment, p.currency)}</dd>
              <dt>Per vendor per day</dt><dd>{money(p.limits.perVendorPerDay, p.currency)}</dd>
              <dt>All vendors per day</dt><dd>{money(p.limits.totalPerDay, p.currency)}</dd>
              <dt>Velocity</dt><dd>{p.velocity.maxPerHour} payments per agent per hour</dd>
              <dt>Allowed categories</dt><dd>{p.allowedCategories.join(", ")}</dd>
              {Object.entries(p.categoryApprovalThresholds).map(([cat, t]) => (
                <Fragment key={cat}><dt>Approval needed above, {cat}</dt><dd>{money(t, p.currency)}</dd></Fragment>
              ))}
              <dt>New payees denied on</dt><dd>{p.newPayeeDenyDays.length ? p.newPayeeDenyDays.map((d) => DAYS[d]).join(", ") : "no day (held for approval)"}</dd>
              <dt>Currency</dt><dd>{p.currency}</dd>
            </dl>
          )}
          <p className="hint">Policies are versioned files with their own tests. The provenance rules below are built in and cannot be loosened by any policy.</p>
        </Card>

        <Card title="How a decision is made">
          <ol className="rules-list">
            {(["payee_change", "untrusted_payee", "new_payee", "amount_mismatch", "approval_threshold", "hard_limit", "allowlist", "velocity"] as const).map((r) => (
              <li key={r}>
                <strong>{RULES[r]!.title}</strong>
                <span>{RULES[r]!.what}</span>
              </li>
            ))}
          </ol>
          <p className="hint">Deny beats needs-approval beats allow. No model is called at decision time, so the same input always gives the same verdict.</p>
        </Card>
      </div>

      <Scorecard />
    </div>
  );
}

/**
 * The scorecard's columns. On a phone what matters is what each scenario cost without and with the firewall, so those two stay next to
 * the scenario name; the category and the rules that fired are dropped (the decision pages show the rules).
 */
/** Row height on a phone: up to three lines of wrapped text plus padding. */
export const SCORECARD_ROW_NARROW = 68;

export function scorecardColumns(narrow: boolean): ColDef<ScenarioResultView>[] {
  const all: ColDef<ScenarioResultView>[] = [
    { headerName: "Scenario", field: "title", flex: narrow ? 1.2 : 1.6, minWidth: narrow ? 100 : 240 },
    { headerName: "Category", field: "category", width: 160, valueFormatter: (p) => CATEGORY_LABEL[p.value as string] ?? String(p.value) },
    { headerName: "Unprotected", flex: 1, minWidth: narrow ? 100 : 170, valueGetter: (p) => (p.data ? side(p.data, "baseline") : ""), cellRenderer: sideCell("baseline") },
    { headerName: "Firewalled", flex: 1, minWidth: narrow ? 108 : 190, valueGetter: (p) => (p.data ? side(p.data, "firewalled") : ""), cellRenderer: sideCell("firewalled") },
    { headerName: "Rules that fired", valueGetter: (p) => p.data?.firewalled.rules.map((r) => RULES[r]?.title ?? r).join(", ") ?? "", flex: 1.4, minWidth: 220 },
  ];
  if (!narrow) return all;
  // Long titles and outcomes wrap onto a second line instead of being cut off; the grid gives rows room for three lines (see SCORECARD_ROW_NARROW).
  return all.map((c) => ({
    ...c,
    suppressHeaderFilterButton: true,
    ...(c.field === "category" || c.headerName === "Rules that fired" ? { hide: true } : { wrapText: true, cellStyle: { lineHeight: "1.25", padding: "6px 8px" } }),
  }));
}

function Scorecard() {
  const { data: card, error } = usePoll(api.scorecard, 60000);

  const narrow = useNarrow();
  const cols = useMemo(() => scorecardColumns(narrow), [narrow]);

  if (error && !card) return <Card title="Red-team scorecard"><Empty title="No scorecard yet">Run <code>pnpm harness</code> to generate one.</Empty></Card>;
  if (!card) return null;
  const a = card.attacks;
  const l = card.legitimate;

  return (
    <Card title="Red-team scorecard" aside={<span className="muted small">{card.scenarios.length} scenarios · policy {card.policy.name} v{card.policy.version}</span>}>
      <div className="headline">
        <Meter label="Attacks that moved money" base={a.baselineLost} fw={a.firewalledLost} total={a.total} />
        <div className="kpis">
          <div className="kpi"><b>{money(a.baselineAmount)}</b><span>lost by the unprotected agent</span></div>
          <div className="kpi"><b>{money(a.firewalledAmount)}</b><span>lost with the firewall{a.firewalledLost ? ", bounded by daily caps" : ""}</span></div>
          <div className="kpi"><b>{l.wronglyDenied} of {l.total}</b><span>legitimate payments wrongly denied ({(l.falseBlockRate * 100).toFixed(1)}% false-block rate)</span></div>
          <div className="kpi"><b>{card.duplicates.firewalledDuplicatePayouts}</b><span>duplicate payouts (unprotected: {card.duplicates.baselineDuplicatePayouts})</span></div>
        </div>
      </div>
      <p className="caveat">
        The agent here is <strong>{card.agent}</strong>, a deterministic stand-in that follows instructions found in documents, and payments go to a simulated PayPal. These numbers measure the firewall, not any real model. Requests held for approval count as no money moved; the harness does not model a careless approver.
      </p>
      <div className="grid-wrap" style={{ height: 560 }}>
        <AgGridReact<ScenarioResultView>
          theme={gridTheme}
          rowData={card.scenarios}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.id}
          {...(narrow ? { rowHeight: SCORECARD_ROW_NARROW } : {})}
          suppressCellFocus
        />
      </div>
    </Card>
  );
}

function side(r: ScenarioResultView, which: "baseline" | "firewalled"): string {
  const s = r[which];
  if (r.kind === "attack" && s.unauthorizedPayouts > 0) return `Lost ${money(s.unauthorizedAmount)}`;
  return s.summary;
}

function sideCell(which: "baseline" | "firewalled") {
  return (p: ICellRendererParams<ScenarioResultView>) => {
    if (!p.data) return null;
    const lost = p.data.kind === "attack" && p.data[which].unauthorizedPayouts > 0;
    return <span className={lost ? "lost" : "kept"}>{side(p.data, which)}</span>;
  };
}

function Meter({ label, base, fw, total }: { label: string; base: number; fw: number; total: number }) {
  return (
    <div className="meter">
      <h3>{label}</h3>
      <div className="bar-row"><span>Unprotected</span><div className="bar"><i className="bad" style={{ width: `${(base / total) * 100}%` }} /></div><b>{base} / {total}</b></div>
      <div className="bar-row"><span>Firewalled</span><div className="bar"><i className="good" style={{ width: `${Math.max((fw / total) * 100, fw ? 2 : 0)}%` }} /></div><b>{fw} / {total}</b></div>
    </div>
  );
}

function DriftList({ drift }: { drift: Drift[] }) {
  const open = drift.filter((d) => d.status === "open");
  return (
    <Card title={`Reconciliation drift · ${open.length} open`} className="drift">
      <ul className="drift-list">
        {open.map((d) => (
          <li key={d.id}>
            <strong>{d.kind === "unmatched_payment" ? "PayPal reports a payment we did not authorize" : "PayPal's payment differs from what was authorized"}</strong>
            <code>{d.reference}</code>
            <span className="muted small">{dateTime(d.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
