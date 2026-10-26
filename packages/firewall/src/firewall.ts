import { resolveIntent, type Decision, type Policy, type ProvenanceContext } from "@pfw/core";
import { AdapterError, type Authority, type PaymentAdapter, type PaymentReceipt } from "@pfw/adapter";
import type { Store } from "@pfw/store";

export type Outcome =
  | { status: "invalid"; errors: string[] }
  | { status: "denied"; decision: Decision; replayed: boolean }
  | { status: "needs_approval"; decision: Decision; replayed: boolean }
  | { status: "executed"; decision: Decision; receipt: PaymentReceipt; replayed: boolean }
  | { status: "execution_failed"; decision: Decision; error: { message: string; retryable: boolean }; replayed: boolean };

export interface FirewallConfig {
  store: Store;
  adapter: PaymentAdapter;
  authority: Authority;
  policy: Policy;
}

/**
 * The single entry point for payments. The agent proposes handles, the firewall decides, and only an allow
 * decision is turned into an authorization the adapter will accept.
 */
export class Firewall {
  private readonly inflight = new Map<string, Promise<Outcome>>();

  constructor(private readonly cfg: FirewallConfig) {}

  submit(proposed: unknown, ctx: ProvenanceContext): Promise<Outcome> {
    const resolved = resolveIntent(proposed, ctx);
    if (!resolved.ok) return Promise.resolve({ status: "invalid", errors: resolved.errors });

    // Concurrent calls with one key share a single run; the adapter's request id covers separate processes.
    const key = resolved.intent.idempotencyKey;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(resolved.intent).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(intent: Parameters<Store["decide"]>[0]): Promise<Outcome> {
    const { store, adapter, authority, policy } = this.cfg;
    const { decision, replayed } = store.decide(intent, policy);

    if (decision.verdict === "deny") return { status: "denied", decision, replayed };
    if (decision.verdict === "require_approval") return { status: "needs_approval", decision, replayed };

    const prior = store.getExecution(intent.idempotencyKey);
    if (prior?.state === "executed") return { status: "executed", decision, receipt: prior.payload as PaymentReceipt, replayed: true };
    if (prior?.state === "failed" && !prior.retryable) {
      return { status: "execution_failed", decision, error: prior.payload as { message: string; retryable: boolean }, replayed: true };
    }

    try {
      const receipt = await adapter.execute(authority.mint(intent, decision));
      store.saveExecution(intent.idempotencyKey, { state: "executed", retryable: false, payload: receipt });
      return { status: "executed", decision, receipt, replayed };
    } catch (e) {
      if (!(e instanceof AdapterError)) throw e; // authorization or programming errors must not be swallowed
      const error = { message: e.message, retryable: e.retryable };
      store.saveExecution(intent.idempotencyKey, { state: "failed", retryable: e.retryable, payload: error });
      return { status: "execution_failed", decision, error, replayed };
    }
  }
}
