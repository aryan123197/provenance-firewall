import type { PaymentStatus } from "./types";

/** A provider notification reduced to what reconciliation needs. */
export interface ProviderEvent {
  id: string;
  provider: "paypal";
  type: string;
  /** Provider's batch/payment id, matched against the receipt reference. */
  reference?: string;
  /** Our own id echoed back (sender_batch_id / sender_item_id), matched against the receipt request id. */
  senderRef?: string;
  status: PaymentStatus;
  /** Minor units. */
  amount?: number;
  currency?: string;
  receiver?: string;
}

export interface WebhookVerifier {
  /** True only when the provider vouches for this exact body. Header names are lower-case. */
  verify(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
}

export function parseMinorUnits(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(n) ? n : undefined;
}
