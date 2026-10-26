import type { AllowedIntent } from "./authority";

export type PaymentStatus = "pending" | "success" | "failed" | "unclaimed" | "returned" | "unknown";

/** What would be sent to the provider. Building it moves no money. */
export interface PaymentProposal {
  idempotencyKey: string;
  /** Stable id sent as the provider's request id, so a retry can never create a second payment. */
  requestId: string;
  request: unknown;
}

export interface PaymentReceipt {
  provider: string;
  idempotencyKey: string;
  requestId: string;
  /** Provider reference used for `status` and for matching webhooks. */
  reference: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  receiver: string;
  createdAt: string;
}

/** The only code allowed to move money. `execute` and `propose` accept nothing but an authorized intent. */
export interface PaymentAdapter {
  propose(allowed: AllowedIntent): PaymentProposal;
  execute(allowed: AllowedIntent): Promise<PaymentReceipt>;
  status(reference: string): Promise<PaymentStatus>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
