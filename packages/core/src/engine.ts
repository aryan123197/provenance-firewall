import type { ResolvedIntent } from "./intent";
import type { Policy } from "./policy";
import { isTrusted } from "./trust";
import type { Tagged } from "./provenance";

export type Verdict = "allow" | "require_approval" | "deny";
export type RuleId =
  | "currency"
  | "payee_change"
  | "untrusted_payee"
  | "new_payee"
  | "amount_mismatch"
  | "approval_threshold"
  | "hard_limit"
  | "allowlist"
  | "velocity";

export interface VendorRecord {
  id: string;
  name: string;
  account: string;
  category: string;
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  amount: number;
  currency: string;
}

/** Everything the decision depends on besides the intent and the policy. Supplied by the caller (the store). */
export interface PolicyState {
  now: string;
  vendors: readonly VendorRecord[];
  purchaseOrder: PurchaseOrder | null;
  /** Minor units already paid today, keyed by vendor id. */
  vendorSpentToday: Readonly<Record<string, number>>;
  totalSpentToday: number;
  paymentsLastHour: number;
}

export interface Finding {
  rule: RuleId;
  verdict: Exclude<Verdict, "allow">;
  reason: string;
  alert: boolean;
}

export type FieldName = "payee" | "account" | "amount" | "currency" | "category";

export interface Decision {
  verdict: Verdict;
  /** The rule that decided the verdict, or "default_allow" when none fired. */
  rule: RuleId | "default_allow";
  reason: string;
  alert: boolean;
  findings: Finding[];
  policy: { name: string; version: number; hash: string };
  fields: Record<FieldName, Tagged<string | number>>;
  evaluatedAt: string;
}

const money = (minor: number, currency: string) => {
  const n = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${n}` : `${n} ${currency}`;
};
const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/** Pure: the same intent, policy and state always give the same decision. No LLM, clock or I/O. */
export function evaluate(intent: ResolvedIntent, policy: Policy, state: PolicyState): Decision {
  const findings: Finding[] = [];
  const add = (rule: RuleId, verdict: Finding["verdict"], reason: string, alert = false) =>
    findings.push({ rule, verdict, reason, alert });

  const { payee, account, amount, currency, category } = intent;
  const cur = policy.currency;

  if (currency.value !== cur) {
    add("currency", "deny", `Payment is in ${currency.value} but this policy only covers ${cur}.`);
  }

  // Provenance rules: who is being paid, and did that come from somewhere trustworthy?
  const exact = state.vendors.find((v) => v.name === payee.value && v.account === account.value);
  const sameName = state.vendors.some((v) => norm(v.name) === norm(payee.value));
  if (!exact && sameName) {
    add(
      "payee_change",
      "deny",
      `"${payee.value}" is a registered vendor, but the account to pay is not the one on file. Possible payee swap.`,
      true,
    );
  } else if (!exact && (!isTrusted(payee.trust) || !isTrusted(account.trust))) {
    const from = !isTrusted(payee.trust) ? "payee" : "account";
    add("untrusted_payee", "deny", `The ${from} came from untrusted content, not a trusted record, and does not match any registered vendor.`);
  } else if (!exact) {
    if (policy.newPayeeDenyDays.includes(new Date(state.now).getUTCDay())) {
      add("new_payee", "deny", `"${payee.value}" is not a registered vendor, and new payees are not paid on this day of the week.`);
    } else {
      add("new_payee", "require_approval", `"${payee.value}" is not a registered vendor. A person must confirm a new payee.`);
    }
  }

  const vendor = exact ?? null;

  // Amount: an untrusted amount needs a trusted record to match, otherwise a person confirms it.
  if (!isTrusted(amount.trust)) {
    const po = state.purchaseOrder && vendor && state.purchaseOrder.vendorId === vendor.id ? state.purchaseOrder : null;
    if (!po) {
      add("amount_mismatch", "require_approval", "The amount came from untrusted content and there is no approved purchase order to check it against.");
    } else if (po.currency !== currency.value) {
      add("amount_mismatch", "require_approval", `The amount is in ${currency.value} but the purchase order is in ${po.currency}.`);
    } else if (BigInt(Math.abs(amount.value - po.amount)) * 10_000n > BigInt(po.amount) * BigInt(policy.amountToleranceBps)) {
      add(
        "amount_mismatch",
        "require_approval",
        `The amount ${money(amount.value, cur)} differs from the purchase order (${money(po.amount, cur)}) by more than ${policy.amountToleranceBps / 100}%.`,
      );
    }
  }

  // The vendor's category on file decides, not the category the agent or an invoice claims.
  const effectiveCategory = vendor ? vendor.category : category.value;
  const threshold = policy.categoryApprovalThresholds[effectiveCategory] ?? policy.approvalThreshold;
  if (amount.value > threshold) {
    add(
      "approval_threshold",
      "require_approval",
      policy.categoryApprovalThresholds[effectiveCategory] !== undefined
        ? `${money(amount.value, cur)} is above the ${money(threshold, cur)} approval threshold for ${effectiveCategory}.`
        : `${money(amount.value, cur)} is above the ${money(threshold, cur)} approval threshold.`,
    );
  }

  if (amount.value > policy.limits.perPayment) {
    add("hard_limit", "deny", `${money(amount.value, cur)} exceeds the ${money(policy.limits.perPayment, cur)} per-payment limit.`);
  }
  if (vendor) {
    const spent = state.vendorSpentToday[vendor.id] ?? 0;
    if (spent + amount.value > policy.limits.perVendorPerDay) {
      add("hard_limit", "deny", `This would take ${vendor.name} past the ${money(policy.limits.perVendorPerDay, cur)} daily limit per vendor.`);
    }
  }
  if (state.totalSpentToday + amount.value > policy.limits.totalPerDay) {
    add("hard_limit", "deny", `This would take today's total past the ${money(policy.limits.totalPerDay, cur)} daily limit.`);
  }

  if (!policy.allowedCategories.includes(effectiveCategory)) {
    add("allowlist", "deny", `Category "${effectiveCategory}" is not on the allowlist.`);
  }

  if (state.paymentsLastHour + 1 > policy.velocity.maxPerHour) {
    add("velocity", "deny", `This agent already made ${state.paymentsLastHour} payments in the last hour (limit ${policy.velocity.maxPerHour}).`);
  }

  const verdict: Verdict = findings.some((f) => f.verdict === "deny")
    ? "deny"
    : findings.length > 0
      ? "require_approval"
      : "allow";
  const deciding = findings.find((f) => f.verdict === verdict);

  return {
    verdict,
    rule: deciding?.rule ?? "default_allow",
    reason: deciding?.reason ?? "Payee and amount come from trusted records and are within policy.",
    alert: findings.some((f) => f.alert),
    findings,
    policy: { name: policy.name, version: policy.version, hash: policy.hash },
    fields: { payee, account, amount, currency, category },
    evaluatedAt: state.now,
  };
}
