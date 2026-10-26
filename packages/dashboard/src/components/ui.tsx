import type { ReactNode } from "react";
import type { Decision } from "../api";
import { FIELD_LABEL, ORIGIN, TRUST, VERDICT, money } from "../labels";

export function VerdictPill({ verdict }: { verdict: keyof typeof VERDICT }) {
  const v = VERDICT[verdict];
  return (
    <span className={`pill ${v.cls}`}>
      <span aria-hidden="true" className="glyph">{v.glyph}</span>
      {v.label}
    </span>
  );
}

export function TrustChip({ trust, compact }: { trust: number; compact?: boolean }) {
  const t = TRUST[trust] ?? TRUST[3]!;
  return (
    <span className={`chip ${t.trusted ? "trusted" : "untrusted"}`} title={t.label}>
      <b>{t.code}</b>
      {!compact && <span>{t.label}</span>}
    </span>
  );
}

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || aside) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="error-note" role="alert">{message}</div>;
}

/** Each field of a payment with where its value came from. The core of the "why" story. */
export function FieldTable({ fields }: { fields: Decision["fields"] }) {
  const order = ["payee", "account", "amount", "currency", "category"] as const;
  return (
    <table className="fields">
      <thead>
        <tr>
          <th>Field</th>
          <th>Value</th>
          <th>Trust</th>
          <th>Came from</th>
        </tr>
      </thead>
      <tbody>
        {order.map((name) => {
          const f = fields[name];
          const shown = name === "amount" ? money(Number(f.value), String(fields.currency.value)) : String(f.value);
          return (
            <tr key={name} className={TRUST[f.trust]?.trusted ? "" : "row-untrusted"}>
              <th scope="row">{FIELD_LABEL[name]}</th>
              <td className="mono">{shown || <em>(empty)</em>}</td>
              <td><TrustChip trust={f.trust} compact /></td>
              <td>
                <ul className="origins">
                  {f.origins.map((o) => (
                    <li key={`${o.kind}|${o.ref}`}>
                      <span className="origin-kind">{ORIGIN[o.kind] ?? o.kind}</span>
                      <code>{o.ref}</code>
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
