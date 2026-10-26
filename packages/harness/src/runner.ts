import { loadPolicy, type Policy } from "@pfw/core";
import { Authority, PayPalAdapter, formatAmount, type PaymentReceipt } from "@pfw/adapter";
import { createFakePayPal, type FakePayout } from "@pfw/adapter/testing";
import { Store } from "@pfw/store";
import { Firewall } from "@pfw/firewall";
import { VENDORS } from "./fixtures";
import { buildTools, rawValue } from "./world";
import type { Agent, PayArgs, PayResult, Scenario } from "./types";

export const CLOCK = new Date("2026-11-03T15:00:00.000Z");
const AGENT_ID = "procurement-agent";
const OPERATOR = "operator@company.example";
const BASE = "http://localhost:9999";

export interface PayCall {
  key: string;
  status: PayResult["status"];
  rule?: string;
  message: string;
  findings: string[];
}

export interface RunResult {
  side: "baseline" | "firewalled";
  payouts: FakePayout[];
  /** Every `pay` call the agent made, in order. */
  calls: PayCall[];
  /** Idempotency keys whose held request a person approved. */
  approvedKeys: string[];
  /** Everything left waiting for a person at the end. */
  pendingApprovals: number;
}

export function loadDefaultPolicy(yaml: string): Policy {
  return loadPolicy(yaml);
}

/** The unprotected agent: holds PayPal credentials and sends whatever it is told, without an idempotency key. */
async function directPayout(fetchFn: typeof fetch, n: number, receiver: string, amount: number, currency: string): Promise<void> {
  const basic = Buffer.from("test-id:test-secret").toString("base64");
  const tok = await fetchFn(`${BASE}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const { access_token } = (await tok.json()) as { access_token: string };
  const res = await fetchFn(`${BASE}/v1/payments/payouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: `baseline-${n}` },
      items: [{ recipient_type: "EMAIL", receiver, amount: { value: formatAmount(amount, "USD"), currency }, sender_item_id: `baseline-${n}` }],
    }),
  });
  if (!res.ok) throw new Error(`PayPal ${res.status}`);
}

export async function runBaseline(s: Scenario, agent: Agent): Promise<RunResult> {
  const fake = createFakePayPal();
  for (const f of s.paypalFaults ?? []) fake.failNext(f);
  const calls: PayCall[] = [];
  let n = 0;

  const { tools } = buildTools(s, VENDORS, async (args: PayArgs, ctx) => {
    const payee = rawValue(args.payee, ctx);
    const account = rawValue(args.account, ctx);
    const amount = rawValue(args.amount, ctx);
    const currency = rawValue(args.currency, ctx);
    let result: PayResult;
    if (typeof account !== "string" || !account || typeof amount !== "number" || !Number.isInteger(amount) || typeof currency !== "string" || payee === null) {
      result = { status: "invalid", message: "unusable payment arguments", retryable: false };
    } else {
      try {
        await directPayout(fake.fetch, ++n, account, amount, currency);
        result = { status: "executed", message: "paid", retryable: false };
      } catch (e) {
        result = { status: "error", message: e instanceof Error ? e.message : String(e), retryable: true };
      }
    }
    calls.push({ key: args.idempotencyKey, status: result.status, message: result.message, findings: [] });
    return result;
  });

  await agent.run(s.tasks, tools);
  return { side: "baseline", payouts: [...fake.payouts], calls, approvedKeys: [], pendingApprovals: 0 };
}

/** An already-running firewall to drive, for the live demo. The harness's own runs build a fresh one per scenario. */
export interface FirewalledEnv {
  store: Store;
  firewall: Firewall;
  /** Prepended to idempotency keys and purchase-order ids so repeated demo runs never collide. */
  keyPrefix?: string;
  /** Have a simulated operator approve everything held. Off for live demos, where a person clicks. */
  autoApprove?: boolean;
}

export interface FirewalledRun {
  calls: PayCall[];
  approvedKeys: string[];
  pendingApprovals: number;
  /** One per payment the firewall reports as executed. */
  receipts: PaymentReceipt[];
}

export async function runOnFirewall(s: Scenario, agent: Agent, env: FirewalledEnv): Promise<FirewalledRun> {
  const { store, firewall } = env;
  const prefix = env.keyPrefix ?? "";
  for (const v of VENDORS) store.upsertVendor(v);
  for (const p of s.purchaseOrders) store.addPurchaseOrder({ ...p, id: `${prefix}${p.id}` });
  const calls: PayCall[] = [];
  const receipts: PaymentReceipt[] = [];

  const { tools } = buildTools(s, VENDORS, async (args, ctx) => {
    const key = `${prefix}${args.idempotencyKey}`;
    const o = await firewall.submit({ agentId: AGENT_ID, ...args, idempotencyKey: key }, ctx);
    let result: PayResult;
    let findings: string[] = [];
    switch (o.status) {
      case "executed":
        findings = o.decision.findings.map((f) => f.rule);
        if (!receipts.some((r) => r.reference === o.receipt.reference)) receipts.push(o.receipt);
        result = { status: "executed", message: "paid", retryable: false };
        break;
      case "denied":
      case "needs_approval":
      case "rejected":
        findings = o.decision.findings.map((f) => f.rule);
        result = { status: o.status, message: o.decision.reason, retryable: false, rule: o.decision.rule };
        break;
      case "execution_failed":
        findings = o.decision.findings.map((f) => f.rule);
        result = { status: "error", message: o.error.message, retryable: o.error.retryable };
        break;
      case "invalid":
        result = { status: "invalid", message: o.errors.join("; "), retryable: false };
        break;
    }
    calls.push({ key, status: result.status, ...(result.rule ? { rule: result.rule } : {}), message: result.message, findings });
    return result;
  });

  await agent.run(s.tasks, tools);

  const approvedKeys: string[] = [];
  if (env.autoApprove) {
    for (const a of store.listApprovals("pending")) {
      if (!a.idempotencyKey.startsWith(prefix)) continue;
      const r = await firewall.resolveApproval(a.id, { approver: OPERATOR, approve: true, note: "harness operator" });
      if (r.status === "executed") {
        approvedKeys.push(a.idempotencyKey);
        receipts.push(r.receipt);
      }
    }
  }
  const pendingApprovals = store.listApprovals("pending").filter((a) => a.idempotencyKey.startsWith(prefix)).length;
  return { calls, approvedKeys, pendingApprovals, receipts };
}

export async function runFirewalled(s: Scenario, agent: Agent, policy: Policy): Promise<RunResult> {
  const fake = createFakePayPal();
  for (const f of s.paypalFaults ?? []) fake.failNext(f);
  const authority = new Authority("harness-authority-key-0123456789");
  const adapter = new PayPalAdapter({ clientId: "test-id", clientSecret: "test-secret", authority, baseUrl: BASE, fetch: fake.fetch, now: () => CLOCK.getTime() });
  const store = new Store({ clock: () => CLOCK });
  const firewall = new Firewall({ store, adapter, authority, policy });

  const run = await runOnFirewall(s, agent, { store, firewall, autoApprove: s.operator === "approve" });
  return { side: "firewalled", payouts: [...fake.payouts], calls: run.calls, approvedKeys: run.approvedKeys, pendingApprovals: run.pendingApprovals };
}
