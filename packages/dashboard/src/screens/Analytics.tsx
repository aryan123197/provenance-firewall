import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type AnalyticsView } from "../api";
import { Card, Empty, ErrorNote } from "../components/ui";
import { usePoll } from "../hooks";
import { money, ruleTitle } from "../labels";

const RANGES = [7, 30, 90] as const;
const SERIES = [
  { key: "paid", label: "Paid", color: "var(--series-1)" },
  { key: "waiting", label: "Waiting for approval", color: "var(--series-3)" },
  { key: "blocked", label: "Blocked", color: "var(--series-2)" },
] as const;
type Day = AnalyticsView["daily"][number];

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Round a maximum up to a clean axis top (4, 5, 8, 10, 20, 50...) so ticks are whole numbers. */
function niceMax(max: number): number {
  if (max <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 4, 5, 10]) if (m * mag >= max) return m * mag;
  return 10 * mag;
}

/**
 * What the firewall decided, over a chosen window: how many requests were paid, held and blocked, why, and who got the money, with this
 * month's spend against each category budget. Read-only: it summarizes the append-only decisions and changes nothing.
 */
export function Analytics() {
  const [days, setDays] = useState<number>(30);
  const { data, error } = usePoll(() => api.analytics(days), 5000, [days]);

  return (
    <div className="stack">
      <p className="muted">
        A summary of what the firewall decided. It only reads the record: no number here can change what is allowed. Requests are counted by the day they were made (UTC).
      </p>
      {error && <ErrorNote message={error} />}
      {data && <Budgets data={data} />}

      <div className="row" role="group" aria-label="Time range">
        <div className="segmented">
          {RANGES.map((n) => (
            <button key={n} type="button" aria-pressed={days === n} onClick={() => setDays(n)}>
              Last {n} days
            </button>
          ))}
        </div>
      </div>

      {/* Keep the previous render while a new range loads: no skeleton, no layout jump. */}
      <div className={`stack ${data && data.days !== days ? "viz-dim" : ""}`}>
        {data ? (
          <>
            <Totals data={data} />
            <Card title="Requests per day">
              <DailyChart days={data.daily} />
            </Card>
            <div className="two-col">
              <Card title="Why payments were stopped or held">
                <RuleBars data={data} />
              </Card>
              <Card title="Where the money went">
                <VendorBars data={data} />
              </Card>
            </div>
          </>
        ) : (
          !error && <p className="muted" role="status">Loading…</p>
        )}
      </div>
    </div>
  );
}

function Totals({ data }: { data: AnalyticsView }) {
  const t = data.totals;
  const cur = data.currency;
  const tiles: [string, string, string][] = [
    ["Requests", t.requests.toLocaleString(), `in the last ${data.days} days`],
    ["Paid", money(t.paid.amount, cur), plural(t.paid.count, "payment")],
    ["Waiting for approval", money(t.waiting.amount, cur), plural(t.waiting.count, "request")],
    ["Blocked", money(t.blocked.amount, cur), `${plural(t.blocked.count, "request")} denied or rejected`],
    ["Alerts", t.alerts.toLocaleString(), t.alerts === 1 ? "request raised a security alert" : "requests raised a security alert"],
  ];
  return (
    <div className="kpis">
      {tiles.map(([label, value, sub]) => (
        <div className="kpi" key={label}>
          <span>{label}</span>
          <b>{value}</b>
          <span className="small">{sub}</span>
        </div>
      ))}
    </div>
  );
}

function Budgets({ data }: { data: AnalyticsView }) {
  const cur = data.currency;
  const budgeted = Object.entries(data.budgets);
  const unbudgeted = Object.entries(data.categorySpendThisMonth).filter(([c, v]) => !(c in data.budgets) && v > 0);
  return (
    <Card title="Budgets this month" aside={<span className="muted small">Paid to registered vendors so far this UTC month</span>}>
      {budgeted.length === 0 && unbudgeted.length === 0 ? (
        <Empty title="No budgets set">Add <code>categoryBudgets</code> to the policy to cap what each vendor category can be paid per month.</Empty>
      ) : (
        <ul className="viz-meters">
          {budgeted.map(([cat, cap]) => {
            const spent = data.categorySpendThisMonth[cat] ?? 0;
            const pct = cap === 0 ? (spent > 0 ? 100 : 0) : Math.min(100, (spent / cap) * 100);
            const level = spent >= cap && (cap > 0 || spent > 0) ? "over" : cap > 0 && spent / cap >= 0.8 ? "near" : "ok";
            return (
              <li key={cat}>
                <span>{cat}</span>
                <div className={`viz-meter-track ${level}`} role="meter" aria-label={`${cat} budget used`} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(spent, cap)}>
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span className="val">
                  {level === "over" && <span className="state over">■ At budget · </span>}
                  {level === "near" && <span className="state near">▲ Near limit · </span>}
                  <b>{money(spent, cur)}</b> of {money(cap, cur)}
                </span>
              </li>
            );
          })}
          {unbudgeted.map(([cat, spent]) => (
            <li key={cat}>
              <span>{cat}</span>
              <span className="muted">no budget set</span>
              <span className="val"><b>{money(spent, cur)}</b></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Rounds only the top two corners, so a bar is square on its baseline and rounded at its data end. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

const H = 220;
const PAD = { l: 34, r: 8, t: 10, b: 24 };
const GAP = 2;
const MAX_BAR = 24;

/** The width of an element in CSS pixels, so the chart is drawn at real size and its text never scales with the window. */
function useWidth(fallback = 640): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const read = () => setW(Math.max(280, Math.round(el.getBoundingClientRect().width)) || fallback);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, fallback]);
  return [setEl, w];
}

function DailyChart({ days }: { days: Day[] }) {
  const [wrap, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const total = days.reduce((s, d) => s + d.paid + d.waiting + d.blocked, 0);
  if (total === 0) return <Empty title="No requests in this period">Run a scenario on Live activity, or wait for the agent to propose a payment.</Empty>;

  const top = niceMax(Math.max(...days.map((d) => d.paid + d.waiting + d.blocked)));
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const slot = innerW / days.length;
  const bw = Math.min(MAX_BAR, Math.max(2, slot - GAP));
  const y = (v: number) => PAD.t + innerH - (v / top) * innerH;
  const ticks = [0, top / 2, top];
  const xLabels = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  const move = (to: number) => setHover(Math.min(days.length - 1, Math.max(0, to)));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") move((hover ?? -1) + 1);
    else if (e.key === "ArrowLeft") move((hover ?? days.length) - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(days.length - 1);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };
  const h = hover === null ? null : days[hover]!;

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <ul className="viz-legend" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key}><span className="viz-key" style={{ background: s.color }} />{s.label}</li>
          ))}
        </ul>
        <button type="button" className="btn subtle" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? "View as chart" : "View as table"}
        </button>
      </div>

      {asTable ? (
        <div className="viz-table-wrap">
          <table className="viz-table">
            <caption className="muted small" style={{ textAlign: "left" }}>Requests per day (UTC)</caption>
            <thead>
              <tr><th scope="col">Day</th>{SERIES.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}><th scope="row">{dayLabel(d.date)}</th><td>{d.paid}</td><td>{d.waiting}</td><td>{d.blocked}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz-chart" ref={wrap} {...(hover !== null ? { "data-active": "" } : {})} onPointerLeave={() => setHover(null)}>
          <div
            className="viz-slider"
            role="slider"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={days.length - 1}
            aria-valuenow={hover ?? 0}
            aria-valuetext={h ? `${dayLabel(h.date)}: ${h.paid} paid, ${h.waiting} waiting for approval, ${h.blocked} blocked` : `${total} requests over ${days.length} days. Use the arrow keys to read one day at a time.`}
            aria-label={`Requests per day, last ${days.length} days`}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
          >
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <g className="viz-grid">
              {ticks.slice(1).map((t) => <line key={t} x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />)}
            </g>
            <g className="viz-axis"><line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} /></g>
            {ticks.map((t) => <text key={t} className="viz-tick" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{t}</text>)}
            {xLabels.map((i) => (
              <text key={i} className="viz-tick" x={PAD.l + slot * i + slot / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}>{dayLabel(days[i]!.date)}</text>
            ))}
            {days.map((d, i) => {
              const cx = PAD.l + slot * i + slot / 2;
              const x = cx - bw / 2;
              let acc = 0;
              const parts = SERIES.map((s) => ({ s, v: d[s.key] })).filter((p) => p.v > 0);
              return (
                <g key={d.date} className="viz-col" {...(hover === i ? { "data-on": "" } : {})}>
                  {parts.map((p, idx) => {
                    const y0 = y(acc);
                    acc += p.v;
                    const y1 = y(acc);
                    // A 2px surface gap separates touching segments; the last (top) one gets the rounded data end.
                    const height = Math.max(1, y0 - y1 - (idx < parts.length - 1 ? GAP : 0));
                    const yTop = y0 - height;
                    return idx === parts.length - 1 ? (
                      <path key={p.s.key} d={topRounded(x, yTop, bw, height, 4)} fill={p.s.color} />
                    ) : (
                      <rect key={p.s.key} x={x} y={yTop} width={bw} height={height} fill={p.s.color} />
                    );
                  })}
                  {/* The hit target is the whole slot, far bigger than the mark. */}
                  <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={innerH} fill="transparent" onPointerMove={() => setHover(i)} onPointerEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          </div>
          {h && hover !== null && (
            <div className="viz-tip" role="status" style={{ left: `clamp(0px, calc(${((PAD.l + slot * hover + slot / 2) / W) * 100}% - 75px), calc(100% - 160px))` }}>
              <b>{dayLabel(h.date)}</b>
              {SERIES.map((s) => (
                <div key={s.key}>
                  <span className="viz-line-key" style={{ background: s.color }} />
                  <span className="muted">{s.label}</span>
                  <strong>{h[s.key]}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function RuleBars({ data }: { data: AnalyticsView }) {
  const rows = data.rules;
  if (rows.length === 0) return <Empty title="Nothing was stopped or held">Every request in this period was paid.</Empty>;
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul className="viz-rank">
      {rows.map((r) => (
        <li key={`${r.verdict}|${r.rule}`} title={`${plural(r.count, "request")}, ${money(r.amount, data.currency)} in total`}>
          <span className="name">{ruleTitle(r.rule)}<small>{r.verdict === "deny" ? "Denied" : "Held for approval"}</small></span>
          <span className="bar" aria-hidden="true"><i style={{ width: `${(r.count / max) * 100}%` }} /></span>
          <span className="val"><b>{r.count}</b> · {money(r.amount, data.currency)}</span>
        </li>
      ))}
    </ul>
  );
}

function VendorBars({ data }: { data: AnalyticsView }) {
  const rows = data.vendors;
  if (rows.length === 0) return <Empty title="Nothing was paid in this period" />;
  const max = Math.max(...rows.map((r) => r.paid), 1);
  return (
    <ul className="viz-rank">
      {rows.map((v) => (
        <li key={v.id ?? "unregistered"}>
          {/* Names come from the registry or an operator-approved payee; rendered as text, never markup. */}
          <span className="name">{v.name}<small>{plural(v.count, "payment")}</small></span>
          <span className="bar" aria-hidden="true"><i style={{ width: `${(v.paid / max) * 100}%` }} /></span>
          <span className="val"><b>{money(v.paid, data.currency)}</b></span>
        </li>
      ))}
    </ul>
  );
}
