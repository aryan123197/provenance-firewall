import { useState } from "react";
import { api, operatorToken } from "./api";
import { Activity } from "./screens/Activity";
import { Approvals } from "./screens/Approvals";
import { PolicyScreen } from "./screens/Policy";
import { Replay } from "./screens/Replay";
import { usePoll, useHashRoute } from "./hooks";
import { shortHash } from "./labels";

const TABS = [
  { to: "/activity", label: "Live activity" },
  { to: "/approvals", label: "Approvals" },
  { to: "/policy", label: "Policy & scorecard" },
] as const;

export function App() {
  const [route, go] = useHashRoute();
  const { data: status, error, refresh } = usePoll(api.status, 3000);

  const decisionMatch = /^\/decision\/(.+)$/.exec(route);
  const active = decisionMatch ? "/activity" : route;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <path d="M16 3l11 4v8c0 7-4.6 12.2-11 14C9.6 27.2 5 22 5 15V7z" fill="var(--accent)" />
            <path d="M11 16l3.5 3.5L21 12.5" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Provenance Firewall</span>
        </div>
        <nav aria-label="Main">
          {TABS.map((t) => (
            <a key={t.to} href={`#${t.to}`} aria-current={active === t.to ? "page" : undefined}>
              {t.label}
              {t.to === "/approvals" && status && status.pendingApprovals > 0 && <span className="badge">{status.pendingApprovals}</span>}
            </a>
          ))}
        </nav>
        <div className="statusbar">
          {status && !status.openOperator && <OperatorSignIn />}
          {status && (
            <>
              <span className={`status-chip ${status.mode === "sandbox" ? "ok" : "warn"}`} title={status.mode === "sandbox" ? "Payments go to the PayPal sandbox" : "No PayPal credentials: payments are simulated inside the server"}>
                {status.mode === "sandbox" ? "PayPal sandbox" : "Simulated PayPal"}
              </span>
              <span className={`status-chip ${status.audit.ok ? "ok" : "bad"}`} title={status.audit.ok ? "Hash chain and signatures verify" : status.audit.reason}>
                {status.audit.ok ? `Audit verified · ${status.audit.count}` : `Audit broken #${status.audit.seq}`}
              </span>
              <span className="status-chip" title={status.policy.hash}>Policy v{status.policy.version} · {shortHash(status.policy.hash).slice(0, 7)}</span>
            </>
          )}
        </div>
      </header>

      {status && status.driftOpen > 0 && (
        <div className="banner deny wide" role="alert">
          ⚑ Reconciliation drift: PayPal reports {status.driftOpen} payment{status.driftOpen > 1 ? "s" : ""} that {status.driftOpen > 1 ? "do" : "does"} not match an authorized decision.{" "}
          <a href="#/policy">Review</a>
        </div>
      )}

      <main id="main">
        {error && !status && <div className="error-note">Cannot reach the firewall API: {error}</div>}
        {decisionMatch ? (
          <Replay id={decodeURIComponent(decisionMatch[1]!)} back={() => go("/activity")} open={go} />
        ) : route === "/approvals" ? (
          <Approvals open={go} onChange={refresh} />
        ) : route === "/policy" ? (
          <PolicyScreen />
        ) : (
          <Activity open={go} demo={Boolean(status?.demo)} llm={Boolean(status?.llmAgentAvailable)} onChange={refresh} />
        )}
      </main>

      <footer>
        Open source (MIT). The LLM plans and explains; it never decides whether money moves.
      </footer>
    </>
  );
}

/** Approving and activating policies need the operator token when the server is not in open demo mode. */
function OperatorSignIn() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [signedIn, setSignedIn] = useState(Boolean(operatorToken.get()));

  if (signedIn && !open) {
    return (
      <button className="status-chip ok chip-button" onClick={() => { operatorToken.set(""); setSignedIn(false); setValue(""); }} title="Forget the operator token in this tab">
        Operator signed in · sign out
      </button>
    );
  }
  if (!open) {
    return <button className="status-chip warn chip-button" onClick={() => setOpen(true)}>Operator sign-in</button>;
  }
  return (
    <form
      className="signin"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        operatorToken.set(value.trim());
        setSignedIn(true);
        setOpen(false);
      }}
    >
      <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Operator token" aria-label="Operator token" autoComplete="off" />
      <button className="btn primary" type="submit">Use token</button>
      <button className="btn" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
