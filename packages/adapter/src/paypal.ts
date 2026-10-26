import { createHash } from "node:crypto";
import type { Authority, AllowedIntent } from "./authority";
import { formatAmount } from "./money";
import { parseMinorUnits, type ProviderEvent, type WebhookVerifier } from "./webhook";
import { PayPalHttp, type PayPalHttpConfig } from "./paypal-http";
import { AdapterError, type PaymentAdapter, type PaymentProposal, type PaymentReceipt, type PaymentStatus } from "./types";

export interface PayPalConfig extends PayPalHttpConfig {
  authority: Authority;
  /** The webhook id PayPal assigns when you register the endpoint. Needed only for `verify`. */
  webhookId?: string;
}

interface PayoutBody {
  sender_batch_header: { sender_batch_id: string; email_subject: string };
  items: {
    recipient_type: "EMAIL" | "PAYPAL_ID";
    receiver: string;
    amount: { value: string; currency: string };
    note: string;
    sender_item_id: string;
  }[];
}

const stable = (key: string) => `pfw-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

export function mapPayPalStatus(s: string | undefined): PaymentStatus {
  switch (s) {
    case "SUCCESS":
      return "success";
    case "PENDING":
    case "PROCESSING":
    case "NEW":
    case "ONHOLD":
      return "pending";
    case "FAILED":
    case "DENIED":
    case "CANCELED":
    case "BLOCKED":
    case "REFUNDED":
    case "REVERSED":
      return "failed";
    case "UNCLAIMED":
      return "unclaimed";
    case "RETURNED":
      return "returned";
    default:
      return "unknown";
  }
}

/** PayPal Payouts (sandbox). The account on a payment is the receiver's PayPal email or PayPal ID. */
export class PayPalAdapter implements PaymentAdapter, WebhookVerifier {
  private readonly http: PayPalHttp;

  constructor(private readonly cfg: PayPalConfig) {
    this.http = new PayPalHttp(cfg);
  }

  propose(allowed: AllowedIntent): PaymentProposal {
    this.cfg.authority.verify(allowed);
    const { intent } = allowed;
    const id = stable(intent.idempotencyKey);
    const receiver = intent.account.value;
    const body: PayoutBody = {
      sender_batch_header: { sender_batch_id: id, email_subject: "Payment from Provenance Firewall" },
      items: [
        {
          recipient_type: /^[A-Z0-9]{13}$/.test(receiver) ? "PAYPAL_ID" : "EMAIL",
          receiver,
          amount: { value: formatAmount(intent.amount.value, intent.currency.value), currency: intent.currency.value },
          note: `Payment to ${intent.payee.value}`.slice(0, 160),
          sender_item_id: id,
        },
      ],
    };
    return { idempotencyKey: intent.idempotencyKey, requestId: id, request: body };
  }

  async execute(allowed: AllowedIntent): Promise<PaymentReceipt> {
    const proposal = this.propose(allowed);
    let res: { batch_header?: { payout_batch_id?: string; batch_status?: string } };
    try {
      res = (await this.http.request("POST", "/v1/payments/payouts", proposal.request, { "PayPal-Request-Id": proposal.requestId })) as typeof res;
    } catch (e) {
      // A retry after a lost response must not be recorded as a failure when the payout actually went through.
      const original = await this.originalPayout(e, proposal.requestId);
      if (!original) throw e instanceof AdapterError && e.httpStatus === 409 ? new AdapterError(e.message, true, 409, e.body) : e;
      res = { batch_header: { payout_batch_id: original.id, ...(original.status ? { batch_status: original.status } : {}) } };
    }
    const reference = res.batch_header?.payout_batch_id;
    if (!reference) throw new AdapterError("PayPal response had no payout_batch_id", false);
    const { intent } = allowed;
    return {
      provider: "paypal",
      idempotencyKey: intent.idempotencyKey,
      requestId: proposal.requestId,
      reference,
      status: mapPayPalStatus(res.batch_header?.batch_status),
      amount: intent.amount.value,
      currency: intent.currency.value,
      receiver: intent.account.value,
      createdAt: new Date(this.http.now()).toISOString(),
    };
  }

  /**
   * PayPal rejects a reused sender_batch_id with a link to the original payout. If a failed request carries such a link, and
   * that payout really has our sender_batch_id, the earlier attempt succeeded and this is it. Anything else is a real error.
   */
  private async originalPayout(e: unknown, senderBatchId: string): Promise<{ id: string; status: string | undefined } | null> {
    if (!(e instanceof AdapterError) || e.httpStatus === undefined || e.httpStatus < 400 || e.httpStatus >= 500) return null;
    const links = (e.body as { links?: { href?: string }[] } | undefined)?.links ?? [];
    for (const l of links) {
      const id = /\/v1\/payments\/payouts\/([A-Za-z0-9]{6,40})(?:[/?#]|$)/.exec(l.href ?? "")?.[1];
      if (!id) continue;
      const got = (await this.http.request("GET", `/v1/payments/payouts/${id}`)) as { batch_header?: { batch_status?: string; sender_batch_header?: { sender_batch_id?: string } } } | undefined;
      if (got?.batch_header?.sender_batch_header?.sender_batch_id === senderBatchId) return { id, status: got.batch_header.batch_status };
    }
    return null;
  }

  async status(reference: string): Promise<PaymentStatus> {
    const res = (await this.http.request("GET", `/v1/payments/payouts/${encodeURIComponent(reference)}`)) as {
      batch_header?: { batch_status?: string };
      items?: { transaction_status?: string }[];
    };
    return mapPayPalStatus(res.items?.[0]?.transaction_status ?? res.batch_header?.batch_status);
  }

  /** Asks PayPal to verify the webhook signature, so a forged notification cannot move our records. */
  async verify(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    if (!this.cfg.webhookId) throw new Error("webhookId is required to verify webhooks");
    const h = (k: string) => headers[k];
    const needed = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (needed.some((k) => !h(k))) return false;
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return false;
    }
    const res = (await this.http.request("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: this.cfg.webhookId,
      webhook_event: event,
    })) as { verification_status?: string };
    return res.verification_status === "SUCCESS";
  }
}

interface PayPalEvent {
  id?: string;
  event_type?: string;
  resource?: {
    batch_header?: {
      payout_batch_id?: string;
      batch_status?: string;
      amount?: { value?: string; currency?: string };
      sender_batch_header?: { sender_batch_id?: string };
    };
    payout_batch_id?: string;
    transaction_status?: string;
    payout_item?: { receiver?: string; sender_item_id?: string; amount?: { value?: string; currency?: string } };
  };
}

/** Payouts batch and item events become a ProviderEvent. Other event types return null and are ignored. */
export function parsePayPalEvent(raw: unknown): ProviderEvent | null {
  const e = raw as PayPalEvent | null;
  if (!e || typeof e.id !== "string" || typeof e.event_type !== "string") return null;
  const r = e.resource ?? {};
  const base = { id: e.id, provider: "paypal" as const, type: e.event_type };
  if (e.event_type.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    const b = r.batch_header ?? {};
    return pick({
      ...base,
      reference: b.payout_batch_id,
      senderRef: b.sender_batch_header?.sender_batch_id,
      status: mapPayPalStatus(b.batch_status),
      amount: parseMinorUnits(b.amount?.value),
      currency: b.amount?.currency,
    });
  }
  if (e.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const i = r.payout_item ?? {};
    return pick({
      ...base,
      reference: r.payout_batch_id,
      senderRef: i.sender_item_id,
      status: mapPayPalStatus(r.transaction_status),
      amount: parseMinorUnits(i.amount?.value),
      currency: i.amount?.currency,
      receiver: i.receiver,
    });
  }
  return null;
}

/** Drops undefined fields, which the ProviderEvent type does not allow. */
function pick(o: Record<string, unknown>): ProviderEvent {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as ProviderEvent;
}
