import { AdapterError } from "./types";

export const PAYPAL_SANDBOX_URL = "https://api-m.sandbox.paypal.com";

export interface PayPalHttpConfig {
  clientId: string;
  clientSecret: string;
  /** Sandbox only. Anything that is not a sandbox or local host is refused. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * OAuth client-credentials, token reuse and refresh, timeouts, and error classification, shared by every PayPal surface
 * we talk to (Payouts, Invoicing, webhook verification). A failure whose outcome is unknown (timeout, reset) or that PayPal
 * says is transient (408, 429, 5xx) is marked retryable; other 4xx are not.
 */
export class PayPalHttp {
  readonly base: string;
  readonly now: () => number;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly cfg: PayPalHttpConfig) {
    this.base = (cfg.baseUrl ?? PAYPAL_SANDBOX_URL).replace(/\/$/, "");
    const host = new URL(this.base).hostname;
    if (!host.includes("sandbox") && host !== "localhost" && host !== "127.0.0.1") {
      throw new Error(`refusing non-sandbox PayPal host: ${host}`);
    }
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  /** Parsed JSON body, or undefined when PayPal returns an empty one (for example 202 after sending an invoice). */
  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, retryAuth = true): Promise<unknown> {
    const token = await this.accessToken();
    try {
      const res = await this.send(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : undefined;
    } catch (e) {
      if (e instanceof AdapterError && e.httpStatus === 401 && retryAuth) {
        this.token = null;
        return this.request(method, path, body, headers, false);
      }
      throw e;
    }
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

  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      // Outcome unknown (timeout, reset). Safe to retry only where the request carries a stable id.
      throw new AdapterError(`PayPal request failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    if (res.ok) return res;
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new AdapterError(`PayPal ${res.status}: ${detail}`, retryable, res.status);
  }
}
