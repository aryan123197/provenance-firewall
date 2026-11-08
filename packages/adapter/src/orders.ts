import { createHash } from "node:crypto";
import type { AllowedIntent, Authority } from "./authority";
import { formatAmount } from "./money";
import { PayPalHttp, type PayPalHttpConfig } from "./paypal-http";
import { parseMinorUnits } from "./webhook";
import { AdapterError, type PaymentAdapter, type PaymentProposal, type PaymentReceipt, type PaymentStatus } from "./types";

export interface PayPalOrdersConfig extends PayPalHttpConfig {
  authority: Authority;
  /** Where PayPal sends the buyer after they approve or cancel. Required by PayPal; the defaults only suit a sandbox demo. */
  returnUrl?: string;
  cancelUrl?: string;
}

interface OrderBody {
  id?: string;
  status?: string;
  purchase_units?: { reference_id?: string; amount?: { currency_code?: string; value?: string }; payee?: { email_address?: string } }[];
  links?: { href?: string; rel?: string }[];
}

const stable = (key: string) => `pfw-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/** An order is not money moved until the buyer approves it on PayPal and it is captured. Until then it is pending. */
export function mapOrderStatus(s: string | undefined): PaymentStatus {
  switch (s) {
    case "COMPLETED":
      return "success";
    case "CREATED":
    case "SAVED":
    case "APPROVED":
    case "PAYER_ACTION_REQUIRED":
      return "pending";
    case "VOIDED":
      return "failed";
    default:
      return "unknown";
  }
}

const asOrder = (res: unknown, what: string): OrderBody => {
  if (res !== null && typeof res === "object" && !Array.isArray(res)) return res as OrderBody;
  throw new AdapterError(`PayPal returned an unexpected ${what} response`, true);
};

/**
 * PayPal Orders v2 (sandbox): an agent buying goods from a merchant. The firewall decides on the merchant (the payee), the amount and
 * the currency exactly as it does for a payout. `execute` only CREATES the order, which PayPal answers with PAYER_ACTION_REQUIRED and a
 * link the buyer must open: no money moves until the account holder approves it there. `capture` is a separate step that refuses any
 * order that does not match what the firewall authorized (checked live: capturing an unapproved order is a 422 ORDER_NOT_APPROVED).
 */
export class PayPalOrdersAdapter implements PaymentAdapter {
  private readonly http: PayPalHttp;

  constructor(private readonly cfg: PayPalOrdersConfig) {
    this.http = new PayPalHttp(cfg);
  }

  propose(allowed: AllowedIntent): PaymentProposal {
    this.cfg.authority.verify(allowed);
    const { intent } = allowed;
    const id = stable(intent.idempotencyKey);
    const request = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: id,
          custom_id: id,
          description: `Payment to ${intent.payee.value}`.slice(0, 127),
          amount: { currency_code: intent.currency.value, value: formatAmount(intent.amount.value, intent.currency.value) },
          payee: { email_address: intent.account.value },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: this.cfg.returnUrl ?? "https://example.com/pfw/return",
            cancel_url: this.cfg.cancelUrl ?? "https://example.com/pfw/cancel",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    };
    return { idempotencyKey: intent.idempotencyKey, requestId: id, request };
  }

  async execute(allowed: AllowedIntent): Promise<PaymentReceipt> {
    const proposal = this.propose(allowed);
    const created = asOrder(await this.http.request("POST", "/v2/checkout/orders", proposal.request, { "PayPal-Request-Id": proposal.requestId }), "order");
    if (typeof created.id !== "string" || !created.id) throw new AdapterError("PayPal response had no order id", false);
    // A repeated PayPal-Request-Id returns the ORIGINAL order even when the body differs (seen live), so what came back is read and
    // compared with what was authorized before it is reported as this payment.
    const order = asOrder(await this.http.request("GET", `/v2/checkout/orders/${encodeURIComponent(created.id)}`), "order");
    const { intent } = allowed;
    this.assertMatches(order, { amount: intent.amount.value, currency: intent.currency.value, receiver: intent.account.value });
    return {
      provider: "paypal-orders",
      idempotencyKey: intent.idempotencyKey,
      requestId: proposal.requestId,
      reference: created.id,
      status: mapOrderStatus(order.status),
      amount: intent.amount.value,
      currency: intent.currency.value,
      receiver: intent.account.value,
      createdAt: new Date(this.http.now()).toISOString(),
      ...(approvalLink(order) ? { approvalUrl: approvalLink(order)! } : {}),
    };
  }

  async status(reference: string): Promise<PaymentStatus> {
    const order = asOrder(await this.http.request("GET", `/v2/checkout/orders/${encodeURIComponent(reference)}`), "order");
    return mapOrderStatus(order.status);
  }

  /**
   * Captures an order the buyer has approved, but only if it still matches what the firewall authorized: the same amount, currency and
   * merchant. A return-URL handler must call this with the recorded decision, never with whatever order id it was handed.
   */
  async capture(reference: string, expected: { amount: number; currency: string; receiver: string }): Promise<PaymentStatus> {
    const order = asOrder(await this.http.request("GET", `/v2/checkout/orders/${encodeURIComponent(reference)}`), "order");
    this.assertMatches(order, expected);
    if (order.status === "COMPLETED") return "success";
    if (order.status !== "APPROVED") throw new AdapterError(`the buyer has not approved this order (it is ${order.status ?? "in an unknown state"})`, false);
    const done = asOrder(await this.http.request("POST", `/v2/checkout/orders/${encodeURIComponent(reference)}/capture`, {}, { "PayPal-Request-Id": `${stable(reference)}-capture` }), "capture");
    return mapOrderStatus(done.status);
  }

  private assertMatches(order: OrderBody, want: { amount: number; currency: string; receiver: string }): void {
    const unit = order.purchase_units?.[0];
    const problems: string[] = [];
    if (order.purchase_units?.length !== 1) problems.push("it does not have exactly one purchase unit");
    if (unit?.amount?.currency_code !== want.currency) problems.push(`currency ${unit?.amount?.currency_code} is not ${want.currency}`);
    if (parseMinorUnits(unit?.amount?.value) !== want.amount) problems.push(`amount ${unit?.amount?.value} is not the authorized amount`);
    if ((unit?.payee?.email_address ?? "").toLowerCase() !== want.receiver.toLowerCase()) problems.push(`merchant ${unit?.payee?.email_address} is not the authorized one`);
    if (problems.length) throw new AdapterError(`PayPal's order does not match what was authorized: ${problems.join("; ")}`, false);
  }
}

const approvalLink = (o: OrderBody) => o.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
