import { createHash } from "node:crypto";
import type { Authority, AllowedIntent } from "./authority";
import { formatAmount } from "./money";
import { AdapterError, type PaymentAdapter, type PaymentProposal, type PaymentReceipt, type PaymentStatus } from "./types";

export const PAYPAL_SANDBOX_URL = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  authority: Authority;
  /** Sandbox only. Anything that is not a sandbox or local host is refused. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
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

function mapStatus(s: string | undefined): PaymentStatus {
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
export class PayPalAdapter implements PaymentAdapter {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: PayPalConfig) {
    this.base = (cfg.baseUrl ?? PAYPAL_SANDBOX_URL).replace(/\/$/, "");
    const host = new URL(this.base).hostname;
    if (!host.includes("sandbox") && host !== "localhost" && host !== "127.0.0.1") {
      throw new Error(`refusing non-sandbox PayPal host: ${host}`);
    }
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
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
    const res = (await this.call("POST", "/v1/payments/payouts", proposal.request, { "PayPal-Request-Id": proposal.requestId })) as {
      batch_header?: { payout_batch_id?: string; batch_status?: string };
    };
    const reference = res.batch_header?.payout_batch_id;
    if (!reference) throw new AdapterError("PayPal response had no payout_batch_id", false);
    const { intent } = allowed;
    return {
      provider: "paypal",
      idempotencyKey: intent.idempotencyKey,
      requestId: proposal.requestId,
      reference,
      status: mapStatus(res.batch_header?.batch_status),
      amount: intent.amount.value,
      currency: intent.currency.value,
      receiver: intent.account.value,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  async status(reference: string): Promise<PaymentStatus> {
    const res = (await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(reference)}`)) as {
      batch_header?: { batch_status?: string };
      items?: { transaction_status?: string }[];
    };
    return mapStatus(res.items?.[0]?.transaction_status ?? res.batch_header?.batch_status);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.send(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new AdapterError("PayPal token response had no access_token", false);
    this.token = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retryAuth = true): Promise<unknown> {
    const token = await this.accessToken();
    try {
      const res = await this.send(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return await res.json();
    } catch (e) {
      if (e instanceof AdapterError && e.httpStatus === 401 && retryAuth) {
        this.token = null;
        return this.call(method, path, body, headers, false);
      }
      throw e;
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // Outcome unknown (timeout, reset): safe to retry because the request id is stable.
      throw new AdapterError(`PayPal request failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (res.ok) return res;
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new AdapterError(`PayPal ${res.status}: ${detail}`, retryable, res.status);
  }
}
