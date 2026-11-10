import { z } from "zod";
import { PolicySchema, hashPolicy, type PolicyDoc } from "./policy";

const Minor = z.number().int().nonnegative().safe();

/**
 * What an author (a person, or an LLM compiling plain English) may change. It is a patch over the active policy and
 * can only touch the tunable thresholds: the provenance rules are not in the policy at all, so no patch can loosen them.
 */
export const PolicyPatchSchema = z
  .object({
    approvalThreshold: Minor.optional(),
    amountToleranceBps: z.number().int().min(0).max(10_000).optional(),
    limits: z.object({ perPayment: Minor.optional(), perVendorPerDay: Minor.optional(), totalPerDay: Minor.optional() }).strict().optional(),
    allowedCategories: z.array(z.string().min(1)).min(1).optional(),
    velocity: z.object({ maxPerHour: z.number().int().positive().optional() }).strict().optional(),
    /** Entries are merged into the existing map; `null` removes an override. */
    categoryApprovalThresholds: z.record(z.string().min(1), Minor.nullable()).optional(),
    newPayeeDenyDays: z.array(z.number().int().min(0).max(6)).optional(),
    /** Monthly budget per vendor id, merged into the existing map; `null` removes one. */
    vendorMonthlyBudgets: z.record(z.string().min(1), Minor.nullable()).optional(),
  })
  .strict();
export type PolicyPatch = z.infer<typeof PolicyPatchSchema>;

/** A clause the author wrote that no rule type can express. It is reported back, never guessed at. */
export interface UnsupportedClause {
  clause: string;
  reason: string;
}

export function applyPatch(active: PolicyDoc, patch: PolicyPatch): PolicyDoc {
  const p = PolicyPatchSchema.parse(patch);
  const thresholds: Record<string, number> = { ...active.categoryApprovalThresholds };
  for (const [cat, v] of Object.entries(p.categoryApprovalThresholds ?? {})) {
    if (v === null) delete thresholds[cat];
    else thresholds[cat] = v;
  }
  const budgets: Record<string, number> = { ...active.vendorMonthlyBudgets };
  for (const [vendor, v] of Object.entries(p.vendorMonthlyBudgets ?? {})) {
    if (v === null) delete budgets[vendor];
    else budgets[vendor] = v;
  }
  const next = {
    name: active.name,
    version: active.version + 1,
    currency: active.currency,
    approvalThreshold: p.approvalThreshold ?? active.approvalThreshold,
    amountToleranceBps: p.amountToleranceBps ?? active.amountToleranceBps,
    limits: { ...active.limits, ...stripUndefined(p.limits ?? {}) },
    allowedCategories: p.allowedCategories ?? active.allowedCategories,
    velocity: { ...active.velocity, ...stripUndefined(p.velocity ?? {}) },
    categoryApprovalThresholds: thresholds,
    newPayeeDenyDays: [...new Set(p.newPayeeDenyDays ?? active.newPayeeDenyDays)].sort((a, b) => a - b),
    // Left out when empty, so a policy without budgets keeps the hash it had before budgets existed.
    ...(Object.keys(budgets).length > 0 ? { vendorMonthlyBudgets: budgets } : {}),
  };
  return PolicySchema.parse(next);
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Record<string, number> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, number>;
}

export type Direction = "looser" | "tighter" | "changed";
export interface PolicyChange {
  path: string;
  label: string;
  before: string;
  after: string;
  direction: Direction;
}

const usd = (minor: number, cur: string) => `${cur === "USD" ? "$" : ""}${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur === "USD" ? "" : ` ${cur}`}`;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Field-by-field changes between two policies, each marked looser (allows more) or tighter, for the review screen. */
export function diffPolicy(a: PolicyDoc, b: PolicyDoc): PolicyChange[] {
  const out: PolicyChange[] = [];
  const num = (path: string, label: string, x: number, y: number, fmt: (n: number) => string) => {
    if (x !== y) out.push({ path, label, before: fmt(x), after: fmt(y), direction: y > x ? "looser" : "tighter" });
  };
  const money = (n: number) => usd(n, b.currency);
  num("approvalThreshold", "Approval needed above", a.approvalThreshold, b.approvalThreshold, money);
  num("amountToleranceBps", "Amount tolerance vs purchase order", a.amountToleranceBps, b.amountToleranceBps, (n) => `${n / 100}%`);
  num("limits.perPayment", "Per payment cap", a.limits.perPayment, b.limits.perPayment, money);
  num("limits.perVendorPerDay", "Per vendor per day", a.limits.perVendorPerDay, b.limits.perVendorPerDay, money);
  num("limits.totalPerDay", "All vendors per day", a.limits.totalPerDay, b.limits.totalPerDay, money);
  num("velocity.maxPerHour", "Payments per agent per hour", a.velocity.maxPerHour, b.velocity.maxPerHour, String);

  const added = b.allowedCategories.filter((c) => !a.allowedCategories.includes(c));
  const removed = a.allowedCategories.filter((c) => !b.allowedCategories.includes(c));
  if (added.length || removed.length) {
    out.push({
      path: "allowedCategories",
      label: "Allowed categories",
      before: a.allowedCategories.join(", "),
      after: b.allowedCategories.join(", "),
      direction: added.length && !removed.length ? "looser" : removed.length && !added.length ? "tighter" : "changed",
    });
  }

  for (const cat of new Set([...Object.keys(a.categoryApprovalThresholds), ...Object.keys(b.categoryApprovalThresholds)])) {
    const x = a.categoryApprovalThresholds[cat];
    const y = b.categoryApprovalThresholds[cat];
    if (x === y) continue;
    const fmt = (n: number | undefined, base: PolicyDoc) => (n === undefined ? `${usd(base.approvalThreshold, base.currency)} (default)` : usd(n, base.currency));
    const effX = x ?? a.approvalThreshold;
    const effY = y ?? b.approvalThreshold;
    out.push({
      path: `categoryApprovalThresholds.${cat}`,
      label: `Approval needed above, for ${cat}`,
      before: fmt(x, a),
      after: fmt(y, b),
      direction: effY === effX ? "changed" : effY > effX ? "looser" : "tighter",
    });
  }

  const ba = a.vendorMonthlyBudgets ?? {};
  const bb = b.vendorMonthlyBudgets ?? {};
  for (const vendor of new Set([...Object.keys(ba), ...Object.keys(bb)])) {
    const x = ba[vendor];
    const y = bb[vendor];
    if (x === y) continue;
    out.push({
      path: `vendorMonthlyBudgets.${vendor}`,
      label: `Monthly budget, ${vendor}`,
      before: x === undefined ? "none" : money(x),
      after: y === undefined ? "none" : money(y),
      // No budget is the loosest setting: setting one tightens, removing one loosens.
      direction: x === undefined ? "tighter" : y === undefined ? "looser" : y > x ? "looser" : "tighter",
    });
  }

  const days = (d: number[]) => (d.length ? d.map((n) => DAYS[n]).join(", ") : "never");
  const sameDays = a.newPayeeDenyDays.join() === b.newPayeeDenyDays.join();
  if (!sameDays) {
    out.push({
      path: "newPayeeDenyDays",
      label: "New payees denied outright on",
      before: days(a.newPayeeDenyDays),
      after: days(b.newPayeeDenyDays),
      direction: b.newPayeeDenyDays.length > a.newPayeeDenyDays.length ? "tighter" : b.newPayeeDenyDays.length < a.newPayeeDenyDays.length ? "looser" : "changed",
    });
  }
  return out;
}

/** Non-fatal oddities in a compiled policy that the reviewer should see. */
export function lintPolicy(p: PolicyDoc): string[] {
  const w: string[] = [];
  const cap = Math.min(p.limits.perPayment, p.limits.perVendorPerDay, p.limits.totalPerDay);
  if (p.approvalThreshold > p.limits.perPayment) w.push("The approval threshold is above the per-payment cap, so payments between them are denied rather than sent for approval.");
  for (const [cat, t] of Object.entries(p.categoryApprovalThresholds)) {
    if (t > p.limits.perPayment) w.push(`The ${cat} approval threshold is above the per-payment cap, so approval can never apply to it.`);
    if (!p.allowedCategories.includes(cat)) w.push(`A threshold is set for ${cat}, but ${cat} is not an allowed category.`);
  }
  if (p.limits.perPayment > p.limits.totalPerDay) w.push("The per-payment cap is above the daily total cap.");
  if (cap === 0) w.push("A limit of $0 blocks every payment.");
  for (const [vendor, budget] of Object.entries(p.vendorMonthlyBudgets ?? {})) {
    if (budget === 0) w.push(`The monthly budget for ${vendor} is $0, so every payment to it is held for approval.`);
  }
  return w;
}

export { hashPolicy };
