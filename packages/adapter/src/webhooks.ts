import { PayPalHttp, type PayPalHttpConfig } from "./paypal-http";
import { AdapterError } from "./types";

/** The Payouts events reconciliation understands (see `parsePayPalEvent`). */
export const PAYOUT_EVENTS = [
  "PAYMENT.PAYOUTSBATCH.PROCESSING",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
  "PAYMENT.PAYOUTS-ITEM.DENIED",
  "PAYMENT.PAYOUTS-ITEM.HELD",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
] as const;

export interface WebhookRegistration {
  id: string;
  url: string;
  events: string[];
}

interface PayPalWebhook {
  id?: string;
  url?: string;
  event_types?: { name?: string }[];
}

const toRegistration = (w: PayPalWebhook): WebhookRegistration => {
  if (!w.id || !w.url) throw new AdapterError("PayPal returned a webhook with no id or url", false);
  return { id: w.id, url: w.url, events: (w.event_types ?? []).map((e) => e.name ?? "").filter(Boolean) };
};

/** Registers the endpoint PayPal should send payout events to. The id it returns is the PAYPAL_WEBHOOK_ID used to verify them. */
export class PayPalWebhooks {
  private readonly http: PayPalHttp;

  constructor(cfg: PayPalHttpConfig | PayPalHttp) {
    this.http = cfg instanceof PayPalHttp ? cfg : new PayPalHttp(cfg);
  }

  /** PayPal only delivers to public https URLs, so anything else is refused here with a clear reason. */
  async register(url: string, events: readonly string[] = PAYOUT_EVENTS): Promise<WebhookRegistration> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AdapterError("the webhook url is not a valid URL", false);
    }
    if (u.protocol !== "https:") throw new AdapterError("PayPal only delivers webhooks to https URLs", false);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") throw new AdapterError("PayPal cannot reach localhost; use a public https URL (a tunnel works for local testing)", false);
    return toRegistration((await this.http.request("POST", "/v1/notifications/webhooks", { url: u.href, event_types: events.map((name) => ({ name })) })) as PayPalWebhook);
  }

  async list(): Promise<WebhookRegistration[]> {
    const res = (await this.http.request("GET", "/v1/notifications/webhooks")) as { webhooks?: PayPalWebhook[] } | undefined;
    return (res?.webhooks ?? []).map(toRegistration);
  }

  async remove(id: string): Promise<void> {
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) throw new AdapterError("not a PayPal webhook id", false);
    await this.http.request("DELETE", `/v1/notifications/webhooks/${id}`);
  }
}
