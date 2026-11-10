import type { AuditVerification, SpendDigest, SpendLine, SpendOverview } from "@pfw/store";

/** Everything the report says, as plain data. The renderer never reads a store or a clock, so the same data gives the same report. */
export interface ReportData {
  generatedAt: string;
  mode: "sandbox" | "simulated";
  policy: { name: string; version: number; hash: string; currency: string };
  audit: AuditVerification;
  overview: SpendOverview;
  digest: SpendDigest;
  /** Denied payments, grouped by the rule that stopped them. */
  blockedByRule: { rule: string; currency: string; count: number; amount: number }[];
}

type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

const ROW_LIMIT = 50;

const money = (minor: number, currency: string) => {
  const n = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${n}` : `${n} ${currency}`;
};

const STATUS_WORD: Record<SpendLine["status"], string> = {
  paid: "Paid",
  sent: "Sent, not confirmed paid",
  attention: "Needs attention (unclaimed, returned or failed)",
  failed: "Failed at PayPal",
  held: "Held for approval",
  queued: "Allowed, not sent",
  denied: "Denied or rejected",
};
const STATUS_ORDER = Object.keys(STATUS_WORD) as SpendLine["status"][];

/** Rows are capped so a long history cannot make an unreadable report; the CSV ledger has every row. */
const capped = <T>(rows: T[]): { rows: T[]; note: string | null } =>
  rows.length > ROW_LIMIT ? { rows: rows.slice(0, ROW_LIMIT), note: `Showing the first ${ROW_LIMIT} of ${rows.length}. The CSV ledger has every row.` } : { rows, note: null };

/** Builds the report once, as blocks, and renders those blocks twice, so the Markdown and HTML versions cannot disagree. */
export function reportBlocks(d: ReportData): Block[] {
  const o = d.overview;
  const out: Block[] = [];
  out.push({ kind: "h1", text: "Provenance Firewall: spend report" });
  out.push({
    kind: "ul",
    items: [
      `Generated ${d.generatedAt} (days are UTC, like the daily caps)`,
      `Payments: ${d.mode === "sandbox" ? "PayPal sandbox" : "simulated PayPal, no real money"}`,
      `Policy: ${d.policy.name} v${d.policy.version}, hash ${d.policy.hash}`,
    ],
  });

  out.push({ kind: "h2", text: "Integrity" });
  out.push({
    kind: "p",
    text: d.audit.ok
      ? `The signed, hash-chained audit log verifies: ${d.audit.count} entries${d.audit.head ? `, head ${d.audit.head.hash}` : ""}.`
      : `The audit log does NOT verify: it breaks at entry ${d.audit.seq} (${d.audit.reason}). Treat everything below as unverified.`,
  });

  out.push({ kind: "h2", text: "Spend by status" });
  const currencies = [...new Set(o.totals.map((t) => t.currency))].sort();
  if (currencies.length === 0) out.push({ kind: "p", text: "No payments have been decided yet." });
  for (const c of currencies) {
    const rows = STATUS_ORDER.map((s) => o.totals.find((t) => t.currency === c && t.status === s)).filter((t): t is NonNullable<typeof t> => t !== undefined);
    out.push({ kind: "p", text: `${c} (currencies are never added together)` });
    out.push({ kind: "table", head: ["Status", "Payments", "Amount"], rows: rows.map((t) => [STATUS_WORD[t.status], String(t.count), money(t.amount, c)]) });
  }

  out.push({ kind: "h2", text: "Money protected" });
  if (o.moneyProtected.length === 0) out.push({ kind: "p", text: "Nothing has been denied or rejected." });
  else {
    out.push({ kind: "p", text: "Payments the firewall denied, or that a person rejected, so the money never moved." });
    out.push({ kind: "table", head: ["Currency", "Blocked", "Amount"], rows: o.moneyProtected.map((p) => [p.currency, String(p.count), money(p.amount, p.currency)]) });
    if (d.blockedByRule.length > 0) {
      out.push({ kind: "table", head: ["Rule that stopped it", "Currency", "Blocked", "Amount"], rows: d.blockedByRule.map((r) => [r.rule, r.currency, String(r.count), money(r.amount, r.currency)]) });
    }
  }

  out.push({ kind: "h2", text: "By payee" });
  const vendors = capped(o.byVendor);
  if (vendors.rows.length === 0) out.push({ kind: "p", text: "No payees yet." });
  else {
    out.push({
      kind: "table",
      head: ["Payee", "Registry", "Currency", "Payments", "Sent", "Held", "Blocked"],
      rows: vendors.rows.map((v) => [v.name, v.vendorId ? "registered" : "not in registry", v.currency, String(v.payments), money(v.spent, v.currency), money(v.held, v.currency), money(v.blocked, v.currency)]),
    });
  }
  if (vendors.note) out.push({ kind: "p", text: vendors.note });

  out.push({ kind: "h2", text: "Monthly budgets" });
  if (d.digest.budgets.length === 0) out.push({ kind: "p", text: "No budgets are set." });
  else {
    out.push({
      kind: "table",
      head: ["Vendor", "Budget", "Spent this month", "Used", "State"],
      rows: d.digest.budgets.map((b) => [b.name, money(b.budget, d.policy.currency), money(b.spent, d.policy.currency), `${b.percent}%`, b.state === "over" ? "over (new payments are held)" : b.state === "near" ? "near (80% or more)" : "ok"]),
    });
  }

  out.push({ kind: "h2", text: "Open purchase orders" });
  const pos = capped(o.openCommitments);
  if (pos.rows.length === 0) out.push({ kind: "p", text: "Nothing outstanding." });
  else out.push({ kind: "table", head: ["Order", "Vendor", "Amount"], rows: pos.rows.map((p) => [p.id, p.vendorName, money(p.amount, p.currency)]) });
  if (pos.note) out.push({ kind: "p", text: pos.note });

  out.push({ kind: "h2", text: "Needs attention" });
  const attention = capped(o.needsAttention);
  if (attention.rows.length === 0 && d.digest.pendingApprovals.count === 0) out.push({ kind: "p", text: "Nothing needs a person." });
  if (d.digest.pendingApprovals.count > 0) out.push({ kind: "p", text: `${d.digest.pendingApprovals.count} payment${d.digest.pendingApprovals.count === 1 ? " is" : "s are"} waiting for approval${d.digest.pendingApprovals.oldestRequestedAt ? `, the oldest since ${d.digest.pendingApprovals.oldestRequestedAt}` : ""}.` });
  if (attention.rows.length > 0) {
    out.push({ kind: "table", head: ["Payee", "Amount", "State"], rows: attention.rows.map((l) => [l.payee, money(l.amount, l.currency), `${STATUS_WORD[l.status]}${l.providerStatus ? `, PayPal ${l.providerStatus}` : ""}`]) });
  }
  if (attention.note) out.push({ kind: "p", text: attention.note });

  out.push({ kind: "p", text: "The decision function is plain code: no model is called when a payment is decided. This report summarizes decisions already made and changes none." });
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Payee names and reasons come from untrusted invoices: every character that Markdown or an inline HTML reader could act on is neutralized. */
const md = (s: string) =>
  s
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/[\\`*_{}[\]<>()#+!|~]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : `\\${c}`));

export function renderMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "h1") out.push(`# ${md(b.text)}`);
    else if (b.kind === "h2") out.push(`## ${md(b.text)}`);
    else if (b.kind === "p") out.push(md(b.text));
    else if (b.kind === "ul") out.push(b.items.map((i) => `- ${md(i)}`).join("\n"));
    else out.push([`| ${b.head.map(md).join(" | ")} |`, `| ${b.head.map(() => "---").join(" | ")} |`, ...b.rows.map((r) => `| ${r.map(md).join(" | ")} |`)].join("\n"));
  }
  return `${out.join("\n\n")}\n`;
}

const CSS = `body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#141821}
h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #d5dae1;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e1e5ea;vertical-align:top;word-break:break-word}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#4a5361}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}`;

export function renderHtml(blocks: Block[]): string {
  const body = blocks
    .map((b) => {
      if (b.kind === "h1") return `<h1>${esc(b.text)}</h1>`;
      if (b.kind === "h2") return `<h2>${esc(b.text)}</h2>`;
      if (b.kind === "p") return `<p>${esc(b.text)}</p>`;
      if (b.kind === "ul") return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
      return `<table><thead><tr>${b.head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    })
    .join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Provenance Firewall: spend report</title><style>${CSS}</style></head><body>\n${body}\n</body></html>\n`;
}

export function renderReport(d: ReportData): { markdown: string; html: string } {
  const blocks = reportBlocks(d);
  return { markdown: renderMarkdown(blocks), html: renderHtml(blocks) };
}
