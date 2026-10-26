import { useState } from "react";
import { api, type CompileResult, type PolicyTestResult, type PolicyView } from "../api";
import { Card, ErrorNote } from "../components/ui";
import { dateTime, shortHash } from "../labels";

const NAME_KEY = "pfw.approver";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};
const EXAMPLE = "Contractors under $500 are fine, never pay new vendors on weekends, and anything over $2k needs my approval.";

export function PolicyEditor({ view, onActivated }: { view: PolicyView | undefined; onActivated: () => void }) {
  const [english, setEnglish] = useState("");
  const [busy, setBusy] = useState<"compile" | "activate" | undefined>();
  const [result, setResult] = useState<CompileResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const [ack, setAck] = useState(false);
  const [name, setName] = useState(readName);

  const compile = async () => {
    setBusy("compile");
    setError(undefined);
    setDone(undefined);
    setResult(undefined);
    setAck(false);
    try {
      setResult(await api.compilePolicy(english));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const activate = async () => {
    if (!result) return;
    if (!name.trim()) {
      setError("Enter your name so this change is attributed to you.");
      return;
    }
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* private mode */
    }
    setBusy("activate");
    setError(undefined);
    try {
      const r = await api.activatePolicy(result, name.trim(), ack);
      setDone(`Policy version ${r.version} is now active. It applies to the next decision.`);
      setResult(undefined);
      setEnglish("");
      onActivated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const available = view?.compilerAvailable ?? false;
  const failed = result?.tests.filter((t) => !t.passed) ?? [];
  const needsAck = (result?.unsupported.length ?? 0) > 0;
  const noChange = result && result.diff.length === 0;

  return (
    <Card title="Write a policy in plain English" aside={<span className="muted small">Compiled to rules, tested, and only activated when you confirm</span>}>
      <label className="field">
        <span>What should the firewall do?</span>
        <textarea
          rows={3}
          value={english}
          onChange={(e) => setEnglish(e.target.value)}
          placeholder={EXAMPLE}
          maxLength={4000}
          disabled={!available}
        />
      </label>
      <div className="row">
        <button className="btn primary" onClick={compile} disabled={!available || busy !== undefined || !english.trim()}>
          {busy === "compile" ? "Compiling…" : "Compile to rules"}
        </button>
        {!available && <span className="muted small">Needs a Claude API key (<code>ANTHROPIC_API_KEY</code>) on the server.</span>}
        {available && !english && <button className="link" onClick={() => setEnglish(EXAMPLE)}>Use an example</button>}
      </div>
      <p className="hint">The model only drafts the rules. It never decides whether a payment moves, and the built-in checks on where a payee or amount came from cannot be changed by any policy.</p>

      {error && <ErrorNote message={error} />}
      {done && <p className="result ok" role="status">{done}</p>}

      {result && (
        <div className="review">
          <h3>Review</h3>
          <p>{result.summary}</p>

          {needsAck && (
            <div className="banner warn" role="alert">
              <strong>These clauses could not be turned into rules and will not be enforced:</strong>
              <ul>
                {result.unsupported.map((u, i) => (
                  <li key={i}>“{u.clause}” — {u.reason}</li>
                ))}
              </ul>
            </div>
          )}

          {noChange ? (
            <p className="muted">Nothing in this policy would change.</p>
          ) : (
            <table className="diff">
              <thead><tr><th>Setting</th><th>Now</th><th>After</th><th /></tr></thead>
              <tbody>
                {result.diff.map((c) => (
                  <tr key={c.path}>
                    <th scope="row">{c.label}</th>
                    <td>{c.before}</td>
                    <td><strong>{c.after}</strong></td>
                    <td><span className={`dir ${c.direction}`}>{c.direction === "looser" ? "allows more" : c.direction === "tighter" ? "stricter" : "changed"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {result.lint.length > 0 && (
            <ul className="lint">
              {result.lint.map((l, i) => <li key={i}>⚠ {l}</li>)}
            </ul>
          )}

          <Tests tests={result.tests} />

          <div className="actions">
            {needsAck && (
              <label className="check">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I understand the clauses above will not be enforced
              </label>
            )}
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="you@company.example" autoComplete="name" />
            </label>
            <div className="buttons">
              <button className="btn" onClick={() => setResult(undefined)} disabled={busy !== undefined}>Discard</button>
              <button className="btn primary" onClick={activate} disabled={busy !== undefined || !result.canActivate || (needsAck && !ack) || noChange}>
                {busy === "activate" ? "Activating…" : `Confirm and activate v${result.baseVersion + 1}`}
              </button>
            </div>
          </div>
          {!result.canActivate && <p className="result bad">{failed.length} test{failed.length > 1 ? "s" : ""} failed, so this policy cannot be activated.</p>}
        </div>
      )}

      {view && view.versions.length > 0 && (
        <details className="versions">
          <summary>Version history ({view.versions.length} activated)</summary>
          <ol>
            {view.versions.map((v) => (
              <li key={v.version}>
                <strong>v{v.version}</strong>{v.active && <span className="tag">active</span>} · {dateTime(v.createdAt)} · confirmed by {v.confirmedBy} · <code title={v.hash}>{shortHash(v.hash)}</code>
                {v.sourceText && <blockquote>{v.sourceText}</blockquote>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </Card>
  );
}

function Tests({ tests }: { tests: PolicyTestResult[] }) {
  const failed = tests.filter((t) => !t.passed);
  const groups = [...new Set(tests.map((t) => t.group))];
  return (
    <details className="tests" open={failed.length > 0}>
      <summary>
        <span className={`status-chip ${failed.length ? "bad" : "ok"}`}>{failed.length ? `${failed.length} of ${tests.length} tests failed` : `${tests.length} tests passed`}</span>
        <span className="muted small"> generated from this policy, including the boundary cases</span>
      </summary>
      {groups.map((g) => (
        <div key={g}>
          <h4>{g}</h4>
          <ul>
            {tests.filter((t) => t.group === g).map((t) => (
              <li key={t.id} className={t.passed ? "pass" : "fail"}>
                <span aria-hidden="true">{t.passed ? "✓" : "✕"}</span>
                <span>{t.description}{!t.passed && <em> — expected {t.expected}, got {t.actual}</em>}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}
