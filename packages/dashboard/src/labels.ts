export const money = (minor: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(minor / 100);

export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const dateTime = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

export const VERDICT = {
  allow: { label: "Allowed", glyph: "✓", cls: "allow" },
  require_approval: { label: "Needs approval", glyph: "!", cls: "approve" },
  deny: { label: "Denied", glyph: "✕", cls: "deny" },
} as const;

export const RULES: Record<string, { title: string; what: string }> = {
  default_allow: { title: "All checks passed", what: "Payee and amount come from trusted records and are within policy." },
  payee_change: { title: "Payee changed", what: "A registered vendor's name arrived with an account that is not the one on file. This is the classic payee swap, so it is blocked and flagged." },
  untrusted_payee: { title: "Payee from untrusted content", what: "The payee or account came from an invoice, email or the agent's own text, and does not match any registered vendor." },
  new_payee: { title: "New payee", what: "The payee is not in the vendor registry. A person must confirm a new payee at any amount." },
  amount_mismatch: { title: "Amount not verified", what: "The amount came from untrusted content and does not match an approved purchase order." },
  approval_threshold: { title: "Above approval threshold", what: "The amount is above the limit that can be paid without a person's approval." },
  hard_limit: { title: "Hard limit exceeded", what: "The payment would exceed a per-payment, per-vendor or daily cap. Approval cannot override a cap." },
  allowlist: { title: "Category not allowed", what: "The vendor's category is not on the policy's allowlist." },
  velocity: { title: "Too many payments", what: "This agent has made too many payments in the last hour." },
  currency: { title: "Unsupported currency", what: "The policy only covers one currency." },
};
export const ruleTitle = (r: string) => RULES[r]?.title ?? r;

export const ORIGIN: Record<string, string> = {
  user: "Your instruction",
  vendor: "Vendor registry",
  po: "Purchase order",
  invoice: "Invoice text",
  email: "Email",
  web: "Web page",
  tool: "Tool output",
  literal: "Typed by the agent",
};

export const TRUST: Record<number, { code: string; label: string; trusted: boolean }> = {
  0: { code: "T0", label: "Stated by you", trusted: true },
  1: { code: "T1", label: "Trusted record", trusted: true },
  2: { code: "T2", label: "Derived from trusted", trusted: true },
  3: { code: "T3", label: "Untrusted content", trusted: false },
};

export const ORIGIN_PHRASE: Record<string, string> = {
  user: "your own instruction",
  vendor: "the vendor registry",
  po: "an approved purchase order",
  invoice: "the invoice text",
  email: "an email",
  web: "a web page",
  tool: "tool output",
  literal: "text the agent typed itself",
};

export const FIELD_LABEL: Record<string, string> = { payee: "Payee", account: "Account", amount: "Amount", currency: "Currency", category: "Category" };

export const CATEGORY_LABEL: Record<string, string> = {
  injected_invoice: "Injected invoice",
  payee_swap: "Payee swap",
  amount_inflation: "Amount inflation",
  over_limit: "Over-limit",
  duplicate_charge: "Duplicate charge",
  social_pressure: "Social pressure",
  policy: "Policy",
  legitimate: "Legitimate",
};

export function outcome(d: { verdict: string; execution: string | null; providerStatus: string | null; approval: { status: string } | null }): string {
  if (d.execution === "executed") return d.providerStatus ? `Paid · PayPal ${d.providerStatus}` : "Sent to PayPal";
  if (d.execution === "failed") return "Send failed";
  if (d.approval?.status === "rejected") return "Rejected by operator";
  if (d.approval?.status === "pending") return "Waiting for approval";
  if (d.approval?.status === "approved") return "Approved · sending";
  if (d.verdict === "deny") return "Blocked · nothing sent";
  return "Allowed";
}
