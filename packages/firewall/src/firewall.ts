import { resolveIntent, type Decision, type Policy, type ProvenanceContext, type ResolvedIntent } from "@pfw/core";
import { AdapterError, parsePayPalEvent, type AllowedIntent, type Authority, type PaymentAdapter, type PaymentReceipt, type WebhookVerifier } from "@pfw/adapter";
import type { ReconcileResult, Store } from "@pfw/store";

type Failure = { message: string; retryable: boolean };

export type Outcome =
  | { status: "invalid"; errors: string[] }
  | { status: "denied"; decision: Decision; replayed: boolean }
  | { status: "needs_approval"; decision: Decision; approvalId: string; replayed: boolean }
  | { status: "rejected"; decision: Decision; approvalId: string; replayed: boolean }
  | { status: "executed"; decision: Decision; receipt: PaymentReceipt; replayed: boolean }
  | { status: "execution_failed"; decision: Decision; error: Failure; replayed: boolean };

export type ApprovalOutcome =
  | Outcome
  /** The payment now violates a hard rule. Approving cannot override a deny, so it stays pending. */
  | { status: "blocked"; reason: string };

export interface FirewallConfig {
  store: Store;
  adapter: PaymentAdapter;
  authority: Authority;
  policy: Policy;
  /** Verifies provider webhook signatures. Without one, webhooks are refused. */
  webhooks?: WebhookVerifier;
}

export type WebhookOutcome =
  | { status: "rejected"; reason: string }
  | { status: "ignored" }
  | ({ status: "processed" } & ReconcileResult);

/**
 * The single entry point for payments. The agent proposes handles, the firewall decides, and only an allow
 * decision (or a person's approval of a "needs approval" one) is turned into an authorization the adapter accepts.
 */
export class Firewall {
  private readonly inflight = new Map<string, Promise<Outcome>>();

  constructor(private readonly cfg: FirewallConfig) {}

  submit(proposed: unknown, ctx: ProvenanceContext): Promise<Outcome> {
    const resolved = resolveIntent(proposed, ctx);
    if (!resolved.ok) return Promise.resolve({ status: "invalid", errors: resolved.errors });
    return this.once(resolved.intent);
  }

  /** Operator action (never exposed to the agent): approve or reject a pending request, then execute if approved. */
  async resolveApproval(id: string, input: { approver: string; approve: boolean; note?: string }): Promise<ApprovalOutcome> {
    const { store, policy } = this.cfg;
    const res = store.resolveApproval(id, input, policy);
    if (!res.ok) return { status: "blocked", reason: res.reason };
    const approval = store.getApproval(id)!;
    return this.once(approval.intent);
  }

  /**
   * PayPal webhook entry point. Pass the raw request body exactly as received (the signature covers it).
   * Payments PayPal reports that we did not authorize, or that differ from what we authorized, become drift.
   */
  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<WebhookOutcome> {
    const { webhooks, store } = this.cfg;
    if (!webhooks) return { status: "rejected", reason: "no webhook verifier configured" };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    let ok = false;
    try {
      ok = await webhooks.verify(lower, rawBody);
    } catch {
      return { status: "rejected", reason: "signature could not be verified" };
    }
    if (!ok) return { status: "rejected", reason: "invalid signature" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: "rejected", reason: "body is not JSON" };
    }
    const ev = parsePayPalEvent(parsed);
    if (!ev) return { status: "ignored" };
    return { status: "processed", ...store.recordProviderEvent(ev) };
  }

  // Concurrent calls with one key share a single run; the adapter's request id covers separate processes.
  private once(intent: ResolvedIntent): Promise<Outcome> {
    const key = intent.idempotencyKey;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(intent).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(intent: ResolvedIntent): Promise<Outcome> {
    const { store, authority, policy } = this.cfg;
    const { decision, replayed } = store.decide(intent, policy);

    if (decision.verdict === "deny") return { status: "denied", decision, replayed };

    if (decision.verdict === "require_approval") {
      const approval = store.getApprovalByKey(intent.idempotencyKey)!;
      if (approval.status === "pending") return { status: "needs_approval", decision, approvalId: approval.id, replayed };
      if (approval.status === "rejected") return { status: "rejected", decision, approvalId: approval.id, replayed };
      const grant = store.getGrant(intent.idempotencyKey)!;
      return this.execute(intent, decision, () => authority.mintApproved(intent, decision, grant), replayed);
    }
    return this.execute(intent, decision, () => authority.mint(intent, decision), replayed);
  }

  private async execute(intent: ResolvedIntent, decision: Decision, authorize: () => AllowedIntent, replayed: boolean): Promise<Outcome> {
    const { store, adapter } = this.cfg;
    const prior = store.getExecution(intent.idempotencyKey);
    if (prior?.state === "executed") return { status: "executed", decision, receipt: prior.payload as PaymentReceipt, replayed: true };
    if (prior?.state === "failed" && !prior.retryable) {
      return { status: "execution_failed", decision, error: prior.payload as Failure, replayed: true };
    }

    try {
      const receipt = await adapter.execute(authorize());
      store.saveExecution(intent.idempotencyKey, {
        state: "executed",
        retryable: false,
        payload: receipt,
        reference: receipt.reference,
        requestId: receipt.requestId,
      });
      return { status: "executed", decision, receipt, replayed };
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e; // authorization or programming errors must not be swallowed
      const error: Failure = { message: e.message, retryable: e.retryable };
      store.saveExecution(intent.idempotencyKey, { state: "failed", retryable: e.retryable, payload: error });
      return { status: "execution_failed", decision, error, replayed };
    }
  }
}
