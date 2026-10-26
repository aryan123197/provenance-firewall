import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, type Decision, type ResolvedIntent } from "@pfw/core";

/**
 * Proof that the firewall allowed exactly this intent. The tag is an HMAC over the values that matter,
 * keyed with a secret only the firewall and adapter share, so an agent (or any other code) cannot forge one,
 * and changing the amount or account after minting invalidates it.
 */
export interface AllowedIntent {
  readonly intent: ResolvedIntent;
  readonly decision: Decision;
  readonly authorizedBy: string;
  readonly tag: string;
}

export class UnauthorizedPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedPaymentError";
  }
}

export class Authority {
  private readonly key: Buffer;

  constructor(key: string | Buffer) {
    this.key = Buffer.from(key);
    if (this.key.length < 16) throw new Error("authority key must be at least 16 bytes");
  }

  private tagFor(i: ResolvedIntent, d: Decision, by: string): string {
    const msg = canonicalJson({
      key: i.idempotencyKey,
      agent: i.agentId,
      payee: i.payee.value,
      account: i.account.value,
      amount: i.amount.value,
      currency: i.currency.value,
      verdict: d.verdict,
      policy: d.policy.hash,
      at: d.evaluatedAt,
      by,
    });
    return createHmac("sha256", this.key).update(msg).digest("hex");
  }

  /** Called by the firewall only. Refuses anything but an allow decision for this very intent. */
  mint(intent: ResolvedIntent, decision: Decision): AllowedIntent {
    if (decision.verdict !== "allow") throw new UnauthorizedPaymentError(`cannot authorize a "${decision.verdict}" decision`);
    const f = decision.fields;
    if (
      f.payee.value !== intent.payee.value ||
      f.account.value !== intent.account.value ||
      f.amount.value !== intent.amount.value ||
      f.currency.value !== intent.currency.value
    ) {
      throw new UnauthorizedPaymentError("decision does not match the intent");
    }
    const authorizedBy = "policy";
    return { intent, decision, authorizedBy, tag: this.tagFor(intent, decision, authorizedBy) };
  }

  /** Called by adapters before any money moves. */
  verify(a: AllowedIntent): void {
    const expected = Buffer.from(this.tagFor(a.intent, a.decision, a.authorizedBy), "hex");
    const actual = Buffer.from(typeof a.tag === "string" ? a.tag : "", "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || a.decision.verdict !== "allow") {
      throw new UnauthorizedPaymentError("missing or invalid authorization for this payment");
    }
  }
}
