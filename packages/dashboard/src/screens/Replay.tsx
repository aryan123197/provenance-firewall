import { api } from "../api";
import { Card, Empty, ErrorNote, FieldTable, VerdictPill } from "../components/ui";
import { usePoll } from "../hooks";
import { FIELD_LABEL, ORIGIN_PHRASE, RULES, TRUST, dateTime, money, outcome, ruleTitle, shortHash } from "../labels";

export function Replay({ id, back, open }: { id: string; back: () => void; open: (to: string) => void }) {
  const { data: rec, error } = usePoll(() => api.decision(id), 3000, [id]);
  const { data: audit } = usePoll(api.auditVerify, 10000);

  if (error && !rec) {
    return (
      <div className="stack">
        <button className="link back" onClick={back}>← Back to activity</button>
        <ErrorNote message={error} />
      </div>
    );
  }
  if (!rec) return <p className="muted">Loading…</p>;

  const { decision: d, summary: s, execution, approval } = rec;
  const f = d.fields;
  const untrusted = (["payee", "account", "amount"] as const).filter((k) => !TRUST[f[k].trust]?.trusted);
  const deciding = d.findings.find((x) => x.rule === d.rule && x.verdict === d.verdict);

  return (
    <div className="stack">
      <button className="link back" onClick={back}>← Back to activity</button>

      <Card className={`hero ${d.verdict === "allow" ? "allow" : d.verdict === "deny" ? "deny" : "approve"}`}>
        <div className="hero-top">
          <div>
            <p className="eyebrow">Decision · {dateTime(s.createdAt)}</p>
            <h1>
              {money(s.amount, s.currency)} to {s.payee || "(no payee)"}
            </h1>
          </div>
          <VerdictPill verdict={d.verdict} />
        </div>
        <p className="reason">{d.reason}</p>
        <p className="muted small">
          Decided by <strong>{ruleTitle(d.rule)}</strong>. {RULES[d.rule]?.what}
        </p>
        {d.alert && <div className="banner deny" role="alert">⚑ Alert raised: a registered vendor's name came with an account that is not on file.</div>}
        <p className="outcome-line">Outcome: <strong>{outcome(s)}</strong></p>
      </Card>

      <Card title="Where each field came from" aside={<span className="muted small">The model never decides this; the harness labels every source.</span>}>
        <FieldTable fields={f} />
        {untrusted.length > 0 && (
          <ul className="why">
            {untrusted.map((k) => (
              <li key={k}>
                <strong>{FIELD_LABEL[k]}</strong> came from {f[k].origins.map((o) => ORIGIN_PHRASE[o.kind] ?? o.kind).join(" and ")}, which is untrusted content. It cannot authorize a payment unless it exactly matches a trusted record.
              </li>
            ))}
          </ul>
        )}
        {untrusted.length === 0 && <p className="hint">Payee, account and amount all trace back to you or to a trusted record.</p>}
      </Card>

      <Card title="Rules checked" aside={<span className="muted small">Policy {d.policy.name} v{d.policy.version} · <code title={d.policy.hash}>{shortHash(d.policy.hash)}</code></span>}>
        {d.findings.length === 0 ? (
          <p className="hint">No rule objected. {RULES.default_allow!.what}</p>
        ) : (
          <ol className="findings">
            {d.findings.map((x, i) => (
              <li key={i} className={x === deciding ? "decisive" : ""}>
                <VerdictPill verdict={x.verdict} />
                <div>
                  <strong>{ruleTitle(x.rule)}</strong>
                  {x === deciding && <span className="tag">decided</span>}
                  <p>{x.reason}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {d.verdict === "deny" && <p className="hint">A denial cannot be overridden by an approval.</p>}
      </Card>

      {(execution || approval) && (
        <Card title="What happened next">
          <dl className="facts">
            {approval && (
              <>
                <dt>Approval</dt>
                <dd>
                  {approval.status === "pending" ? (
                    <>Waiting for a person. <button className="link" onClick={() => open("/approvals")}>Open the inbox</button></>
                  ) : (
                    <>
                      {approval.status === "approved" ? "Approved" : "Rejected"} by <strong>{approval.resolvedBy}</strong>
                      {approval.resolvedAt && <> at {dateTime(approval.resolvedAt)}</>}
                      {approval.note && <> — “{approval.note}”</>}
                    </>
                  )}
                </dd>
              </>
            )}
            {execution && (
              <>
                <dt>PayPal</dt>
                <dd>
                  {execution.state === "executed" ? (
                    <>
                      Payout <code>{execution.reference ?? "created"}</code>
                      {execution.providerStatus ? <> · status <strong>{execution.providerStatus}</strong></> : <> · awaiting webhook</>}
                    </>
                  ) : (
                    <>Send failed{execution.retryable ? " (will retry with the same request id)" : ""}</>
                  )}
                </dd>
              </>
            )}
          </dl>
        </Card>
      )}

      <Card
        title="Audit trail"
        aside={
          audit && (
            <span className={`status-chip ${audit.ok ? "ok" : "bad"}`}>{audit.ok ? `Chain verified · ${audit.count} entries` : `Chain broken at #${audit.seq}`}</span>
          )
        }
      >
        {rec.audit.length === 0 ? (
          <Empty title="No audit entries for this payment" />
        ) : (
          <table className="audit">
            <thead>
              <tr><th>#</th><th>Event</th><th>When</th><th>Entry hash</th><th>Signed by</th></tr>
            </thead>
            <tbody>
              {rec.audit.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.type.replace(/_/g, " ")}</td>
                  <td>{dateTime(e.ts)}</td>
                  <td><code title={e.hash}>{shortHash(e.hash)}</code></td>
                  <td><code>{e.keyId}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Each entry includes the hash of the one before it and an Ed25519 signature, so any edit or removal shows up. <a href="/api/audit/export" download>Download the full log</a> and check it yourself with <code>pnpm verify:audit</code>, without trusting this server.</p>
      </Card>
    </div>
  );
}
