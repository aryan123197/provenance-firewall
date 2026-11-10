import { useRef, useState } from "react";
import { api, type DemoRun, type ScannedInvoice } from "../api";
import { Card, Empty, ErrorNote, TrustChip } from "../components/ui";
import { usePoll } from "../hooks";
import { money, ruleTitle } from "../labels";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf";
const MAX_BYTES = 5 * 1024 * 1024;

/** Reads a file as base64 text, without the data: prefix. */
const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("The file could not be read."));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.readAsDataURL(file);
  });

/**
 * Upload an invoice photo or PDF. Claude transcribes it, and everything it read is third-party text: shown here as untrusted, and entering
 * the agent as untrusted too. Running it sends the same scan to an unprotected agent and to the live firewall, so the difference is visible.
 */
export function InvoicesScreen({ llm, onChange }: { llm: boolean; onChange: () => void }) {
  const { data, error, refresh } = usePoll(api.scans, 5000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [runs, setRuns] = useState<Record<string, DemoRun>>({});
  const input = useRef<HTMLInputElement>(null);

  const scans = data?.scans ?? [];
  const current = scans.find((s) => s.id === selected) ?? scans[0];

  const upload = async (file: File) => {
    setMsg(undefined);
    if (file.size > MAX_BYTES) return setMsg(`That file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
    setBusy(true);
    try {
      const scanned = await api.scanInvoice(file.type, await toBase64(file));
      setSelected(scanned.id);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const run = async (s: ScannedInvoice, agent: "scripted" | "llm") => {
    setMsg(undefined);
    setBusy(true);
    try {
      const out = await api.runScan(s.id, agent);
      setRuns((r) => ({ ...r, [s.id]: out }));
      onChange();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="muted">
        Upload an invoice photo or PDF. Claude reads it, and everything it read is treated as untrusted: a scan can name a payee and an amount, but the firewall will not pay either unless a vendor record and a purchase order agree.
      </p>
      {error && <ErrorNote message={error} />}

      <Card title="Scan an invoice">
        {data && !data.scanner ? (
          <Empty title="Scanning is not set up">The server needs a Claude API key (ANTHROPIC_API_KEY) to read invoices.</Empty>
        ) : (
          <div className="row">
            <label className="field">
              <span>Invoice file (PNG, JPEG, WebP, GIF or PDF, up to 5 MB)</span>
              <input ref={input} type="file" accept={ACCEPT} disabled={busy} aria-label="Invoice file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
            </label>
            {busy && <span className="muted" role="status">Working…</span>}
          </div>
        )}
        {msg && <ErrorNote message={msg} />}
      </Card>

      {current && <ScanCard scan={current} run={runs[current.id]} busy={busy} llm={llm} onRun={(a) => run(current, a)} />}

      {scans.length > 1 && (
        <Card title="Earlier scans">
          <ul className="plain">
            {scans.map((s) => (
              <li key={s.id}>
                <button type="button" className="link" onClick={() => setSelected(s.id)}>{s.vendor || "Unreadable"} · {s.total === null ? s.totalText || "no total" : money(s.total, s.currency || "USD")}</button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ScanCard({ scan, run, busy, llm, onRun }: { scan: ScannedInvoice; run: DemoRun | undefined; busy: boolean; llm: boolean; onRun: (agent: "scripted" | "llm") => void }) {
  const rows: [string, string | undefined][] = [
    ["Vendor", scan.vendor || undefined],
    ["Pay to (as printed)", scan.remitTo],
    ["Total", scan.total === null ? undefined : `${money(scan.total, scan.currency || "USD")}${scan.totalText ? ` (printed: ${scan.totalText})` : ""}`],
    ["Currency", scan.currency || undefined],
    ["Invoice number", scan.invoiceNumber],
    ["Line items", scan.lineItems.length ? scan.lineItems.join("; ") : undefined],
    ["Other text on the page", scan.note],
  ];
  return (
    <Card title="What the scan read" aside={<span className="muted small"><code>{scan.id}</code></span>}>
      {scan.warnings.length > 0 && (
        <ul className="warnings" role="alert">
          {scan.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <table className="fields">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {/* Rendered as text, never as markup: the page can say anything. */}
              <td>{value ?? <span className="muted">not found</span>}</td>
              <td>{value !== undefined && <TrustChip trust={3} compact />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !scan.usable} onClick={() => onRun("scripted")}>Run: unprotected agent vs firewall</button>
        {llm && <button type="button" className="btn" disabled={busy || !scan.usable} onClick={() => onRun("llm")}>Run with Claude as the agent</button>}
        {!scan.usable && <span className="muted">This scan cannot be run until it can be read reliably. Try a clearer file.</span>}
      </div>
      {run && <RunResult run={run} />}
    </Card>
  );
}

function RunResult({ run }: { run: DemoRun }) {
  const side = (label: string, s: DemoRun["baseline"] | DemoRun["firewalled"]) => (
    <div className="card run-side">
      <h3>{label}</h3>
      <p>{s.payouts.length === 0 ? "Nothing was paid." : s.payouts.map((p) => `Paid ${money(p.amount, p.currency)} to ${p.receiver}`).join("; ")}</p>
      {s.calls.map((c) => (
        <p key={c.key} className="muted small">
          {c.status === "executed" ? "Allowed" : c.status === "needs_approval" ? "Held for approval" : c.status === "denied" ? "Denied" : c.status}
          {c.rule ? ` · ${ruleTitle(c.rule)}` : ""}: {c.message}
        </p>
      ))}
    </div>
  );
  const key = run.firewalled.calls[0]?.key;
  return (
    <div className="stack" aria-live="polite">
      <div className="two-col">
        {side("Unprotected agent", run.baseline)}
        {side("Same agent behind the firewall", run.firewalled)}
      </div>
      {run.firewalled.pendingApprovals > 0 && <p><a href="#/approvals">A person needs to approve this in Approvals.</a></p>}
      {key && <p><a href={`#/decision/${encodeURIComponent(key)}`}>See where each field came from</a></p>}
    </div>
  );
}
