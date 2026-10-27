import { evaluate, type Decision, type PolicyState, type Verdict, type VendorRecord } from "./engine";
import type { ResolvedIntent } from "./intent";
import type { OriginKind } from "./provenance";
import { tag } from "./provenance";
import { hashPolicy, type Policy, type PolicyDoc } from "./policy";

export interface PolicyTestResult {
  id: string;
  group: "thresholds" | "limits" | "new payees" | "allowlist" | "provenance (built in)";
  description: string;
  expected: string;
  actual: string;
  passed: boolean;
}

interface Case {
  id: string;
  group: PolicyTestResult["group"];
  description: string;
  intent: ResolvedIntent;
  state: PolicyState;
  expect: { verdict: Verdict; rule?: string; alert?: boolean };
}

const f = <T>(kind: OriginKind, value: T) => tag(value, { kind, ref: `${kind}:test` });
const SUNDAY = Date.UTC(2026, 10, 1, 12); // 2026-11-01 is a Sunday
const at = (day: number) => new Date(SUNDAY + day * 86_400_000).toISOString();
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const usd = (minor: number) => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const baseState = (vendors: VendorRecord[], now = at(2)): PolicyState => ({
  now,
  vendors,
  purchaseOrder: null,
  vendorSpentToday: {},
  totalSpentToday: 0,
  paymentsLastHour: 0,
});

/** An intent whose fields all come from trusted sources, so only the thresholds are being tested. */
const trusted = (v: VendorRecord, amount: number, currency: string, key: string): ResolvedIntent => ({
  agentId: "policy-test",
  idempotencyKey: key,
  payee: f("vendor", v.name),
  account: f("vendor", v.account),
  amount: f("user", amount),
  currency: f("user", currency),
  category: f("vendor", v.category),
});

/**
 * Tests generated from a policy's own numbers, with expectations worked out by plain arithmetic rather than by the
 * engine: just under, at and just over each threshold and cap, the weekday rule, the allowlist, velocity, and the
 * built-in provenance rules (which must hold under every policy). Running them is how a compiled policy is shown to
 * do what its author said before anyone activates it.
 */
export function generatePolicyTests(p: PolicyDoc): (Case & { policy: Policy })[] {
  const policy: Policy = { ...p, hash: hashPolicy(p) };
  const cur = p.currency;
  const cases: Case[] = [];
  const catVendor = (cat: string): VendorRecord => ({ id: `v_${cat}`, name: `Test ${cat}`, account: `${cat}@vendors.example`, category: cat });
  const vendors = p.allowedCategories.map(catVendor);
  const outside: VendorRecord = { id: "v_outside", name: "Outside Co", account: "outside@vendors.example", category: "__not_allowed__" };
  const allVendors = [...vendors, outside];

  // Independent expectation for a clean payment of `amount` from a vendor in `category`.
  const expectFor = (amount: number, category: string): Verdict => {
    if (amount > p.limits.perPayment || amount > p.limits.perVendorPerDay || amount > p.limits.totalPerDay) return "deny";
    const t = p.categoryApprovalThresholds[category] ?? p.approvalThreshold;
    return amount > t ? "require_approval" : "allow";
  };

  const amountCase = (id: string, group: PolicyTestResult["group"], desc: string, v: VendorRecord, amount: number) => {
    if (amount < 0) return;
    cases.push({ id, group, description: desc, intent: trusted(v, amount, cur, id), state: baseState(allVendors), expect: { verdict: expectFor(amount, v.category) } });
  };

  for (const v of vendors) {
    const t = p.categoryApprovalThresholds[v.category] ?? p.approvalThreshold;
    const where = p.categoryApprovalThresholds[v.category] !== undefined ? `${v.category} approval threshold` : `approval threshold (${v.category})`;
    amountCase(`threshold-at:${v.category}`, "thresholds", `Exactly ${usd(t)}, the ${where}, is not above it`, v, t);
    amountCase(`threshold-over:${v.category}`, "thresholds", `${usd(t + 1)} is one cent over the ${where}`, v, t + 1);
  }
  const first = vendors[0]!;
  amountCase("cap-per-payment-at", "limits", `Exactly ${usd(p.limits.perPayment)}, the per-payment cap, is not over it`, first, p.limits.perPayment);
  amountCase("cap-per-payment-over", "limits", `${usd(p.limits.perPayment + 1)} is over the per-payment cap`, first, p.limits.perPayment + 1);

  // Vendor and total daily caps: spend already at cap - 1 cent, then a 1 cent and a 2 cent payment.
  for (const [id, label, spentKey, cap] of [
    ["cap-vendor-day", "per-vendor daily cap", "vendor", p.limits.perVendorPerDay],
    ["cap-total-day", "all-vendors daily cap", "total", p.limits.totalPerDay],
  ] as const) {
    const state = baseState(allVendors);
    const spent = Math.max(cap - 1, 0);
    if (spentKey === "vendor") state.vendorSpentToday = { [first.id]: spent };
    else state.totalSpentToday = spent;
    for (const [n, amt] of [["fits", 1], ["over", 2]] as const) {
      const fits = spent + amt <= cap;
      // The payment must trip nothing but the cap under test: it has to fit under the other two caps and the approval threshold too.
      const withinOthers = amt <= Math.min(p.limits.perPayment, p.limits.perVendorPerDay, p.limits.totalPerDay, p.categoryApprovalThresholds[first.category] ?? p.approvalThreshold);
      if (!withinOthers) continue;
      cases.push({
        id: `${id}-${n}`,
        group: "limits",
        description: `With ${usd(spent)} already paid today, ${usd(amt)} ${fits ? "fits under" : "goes over"} the ${label} of ${usd(cap)}`,
        intent: trusted(first, amt, cur, `${id}-${n}`),
        state,
        expect: { verdict: fits ? "allow" : "deny" },
      });
    }
  }

  // Tolerance against a purchase order, using a base that stays under every threshold.
  const baseAmt = Math.min(10_000, p.approvalThreshold, p.limits.perPayment, p.limits.perVendorPerDay, p.limits.totalPerDay);
  if (baseAmt >= 100) {
    const edge = baseAmt + Math.floor((baseAmt * p.amountToleranceBps) / 10_000);
    const po = { id: "po", vendorId: first.id, amount: baseAmt, currency: cur };
    const invoice = (amt: number, id: string): ResolvedIntent => ({ ...trusted(first, amt, cur, id), amount: f("invoice", amt) });
    const withinCaps = (amt: number) => amt <= Math.min(p.limits.perPayment, p.limits.perVendorPerDay, p.limits.totalPerDay, p.categoryApprovalThresholds[first.category] ?? p.approvalThreshold);
    if (withinCaps(edge)) {
      cases.push({ id: "tolerance-edge", group: "thresholds", description: `An invoice of ${usd(edge)} against a ${usd(baseAmt)} purchase order is within the ${p.amountToleranceBps / 100}% tolerance`, intent: invoice(edge, "tolerance-edge"), state: { ...baseState(allVendors), purchaseOrder: po }, expect: { verdict: "allow" } });
    }
    if (withinCaps(edge + 1) && (edge + 1 - baseAmt) * 10_000 > baseAmt * p.amountToleranceBps) {
      cases.push({ id: "tolerance-over", group: "thresholds", description: `An invoice of ${usd(edge + 1)} against a ${usd(baseAmt)} purchase order is one cent outside the tolerance`, intent: invoice(edge + 1, "tolerance-over"), state: { ...baseState(allVendors), purchaseOrder: po }, expect: { verdict: "require_approval", rule: "amount_mismatch" } });
    }
  }

  // An amount that trips no threshold or cap, so the rule under test is the only one that can fire.
  const safeAmt = Math.min(100, p.limits.perPayment, p.limits.perVendorPerDay, p.limits.totalPerDay, p.categoryApprovalThresholds[first.category] ?? p.approvalThreshold);

  // New payees: held for approval, or denied on the configured weekdays.
  const newbie = (id: string): ResolvedIntent => ({
    agentId: "policy-test",
    idempotencyKey: id,
    payee: f("user", "Brand New Vendor"),
    account: f("user", "new@vendors.example"),
    amount: f("user", safeAmt),
    currency: f("user", cur),
    category: f("user", first.category),
  });
  const openDay = [2, 3, 4, 1, 5, 0, 6].find((d) => !p.newPayeeDenyDays.includes(d));
  for (const d of [...p.newPayeeDenyDays, ...(openDay !== undefined ? [openDay] : [])]) {
    const denied = p.newPayeeDenyDays.includes(d);
    cases.push({
      id: `new-payee-${DAYS[d]!.toLowerCase()}`,
      group: "new payees",
      description: denied ? `A new payee on a ${DAYS[d]} is denied outright` : `A new payee on a ${DAYS[d]} is held for a person to approve`,
      intent: newbie(`new-payee-${d}`),
      state: baseState(allVendors, at(d)),
      expect: { verdict: denied ? "deny" : "require_approval", rule: "new_payee" },
    });
  }

  // Allowlist and velocity.
  cases.push({ id: "allowlist-outside", group: "allowlist", description: "A registered vendor in a category that is not allowed is denied", intent: trusted(outside, 100, cur, "allowlist-outside"), state: baseState(allVendors), expect: { verdict: "deny", rule: "allowlist" } });
  for (const [n, recent, verdict] of [["under", p.velocity.maxPerHour - 1, "allow"], ["at", p.velocity.maxPerHour, "deny"]] as const) {
    const amt = safeAmt;
    const state = { ...baseState(allVendors), paymentsLastHour: recent };
    cases.push({ id: `velocity-${n}`, group: "limits", description: `With ${recent} payments this hour from the agent, another is ${verdict === "allow" ? "allowed" : "denied"} (limit ${p.velocity.maxPerHour} per hour)`, intent: trusted(first, amt, cur, `velocity-${n}`), state, expect: { verdict } });
  }

  // Built-in provenance rules: must hold whatever the policy says.
  const swapped = { ...trusted(first, 100, cur, "prov-swap"), payee: f("invoice", first.name), account: f("invoice", "attacker@evil.example") };
  cases.push({ id: "prov-payee-swap", group: "provenance (built in)", description: "A registered vendor's name with a different account is denied with an alert", intent: swapped, state: baseState(allVendors), expect: { verdict: "deny", rule: "payee_change", alert: true } });
  const injected = { ...trusted(first, 100, cur, "prov-injected"), payee: f("invoice", "Evil Corp"), account: f("invoice", "attacker@evil.example") };
  cases.push({ id: "prov-untrusted-payee", group: "provenance (built in)", description: "A payee and account taken from an invoice that match no registered vendor are denied", intent: injected, state: baseState(allVendors), expect: { verdict: "deny", rule: "untrusted_payee" } });
  const literal = { ...trusted(first, 100, cur, "prov-literal"), account: f("literal", "attacker@evil.example") };
  cases.push({ id: "prov-literal-account", group: "provenance (built in)", description: "An account the agent typed itself, not taken from a record, is never trusted", intent: literal, state: baseState(allVendors), expect: { verdict: "deny" } });

  return cases.map((c) => ({ ...c, policy }));
}

export function runPolicyTests(p: PolicyDoc): PolicyTestResult[] {
  return generatePolicyTests(p).map((c) => {
    const d: Decision = evaluate(c.intent, c.policy, c.state);
    const ruleOk = c.expect.rule === undefined || d.findings.some((x) => x.rule === c.expect.rule && x.verdict === c.expect.verdict) || (c.expect.verdict === "deny" && d.rule === c.expect.rule);
    const alertOk = c.expect.alert === undefined || d.alert === c.expect.alert;
    const passed = d.verdict === c.expect.verdict && ruleOk && alertOk;
    const label = (v: string, r?: string) => `${v.replace("_", " ")}${r ? ` (${r})` : ""}`;
    return {
      id: c.id,
      group: c.group,
      description: c.description,
      expected: label(c.expect.verdict, c.expect.rule),
      actual: label(d.verdict, d.verdict === "allow" ? undefined : d.rule),
      passed,
    };
  });
}

/**
 * Examples the author's own sentence implies ("$500.00 for a contractor is paid, $500.01 needs approval"), written by
 * whoever compiled the policy. They are run against the compiled numbers, so a slip such as dollars read as cents shows
 * up as a mismatch between what was meant and what was compiled.
 */
export interface IntentExample {
  description: string;
  /** Dollars, as the author would say them. */
  amount: number;
  category: string;
  newPayee?: boolean;
  /** UTC weekday, 0 = Sunday. Defaults to a Tuesday. */
  weekday?: number;
  expect: Verdict;
}

export function runIntentExamples(p: PolicyDoc, examples: IntentExample[]): PolicyTestResult[] {
  const policy: Policy = { ...p, hash: hashPolicy(p) };
  return examples.map((ex, i) => {
    const vendor: VendorRecord = { id: `ex_${i}`, name: `Example ${ex.category} vendor`, account: `ex${i}@vendors.example`, category: ex.category };
    const amount = Math.round(ex.amount * 100);
    const intent: ResolvedIntent = ex.newPayee
      ? { ...trusted(vendor, amount, p.currency, `ex-${i}`), payee: f("user", "Brand New Vendor"), account: f("user", "new@vendors.example") }
      : trusted(vendor, amount, p.currency, `ex-${i}`);
    const d = evaluate(intent, policy, baseState([vendor], at(ex.weekday ?? 2)));
    return {
      id: `intent-${i}`,
      group: "thresholds",
      description: ex.description,
      expected: ex.expect.replace("_", " "),
      actual: d.verdict.replace("_", " "),
      passed: d.verdict === ex.expect,
    } as PolicyTestResult;
  });
}
