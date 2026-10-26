import type { PurchaseOrder, RuleId, VendorRecord } from "@pfw/core";

/** A value the agent passes to `pay`: a handle to something a tool returned, or a string/number it typed itself. */
export type Ref = { handle: string } | { literal: string | number };

export interface Field {
  handle: string;
  value: string | number;
}

export interface InvoiceDoc {
  kind: "invoice";
  id: string;
  vendor: string;
  remitTo?: string;
  /** Minor units. */
  total: number;
  currency: string;
  lineItems: string[];
  note?: string;
}

export interface EmailDoc {
  kind: "email";
  id: string;
  from: string;
  subject: string;
  body: string;
}

export type Doc = InvoiceDoc | EmailDoc;

export interface DocView {
  id: string;
  kind: Doc["kind"];
  text: string;
  fields: Record<string, Field>;
}

export interface VendorView {
  id: string;
  name: Field;
  account: Field;
  category: Field;
}

export interface PayArgs {
  idempotencyKey: string;
  payee: Ref;
  account: Ref;
  amount: Ref;
  currency: Ref;
  category: Ref;
}

export interface PayResult {
  status: "executed" | "denied" | "needs_approval" | "rejected" | "invalid" | "error";
  message: string;
  retryable: boolean;
  rule?: string;
}

/** Everything an agent can do. The same tools back both runs; only what `pay` does differs. */
export interface AgentTools {
  request: { text: string; fields: Record<string, Field> };
  readDocument(id: string): DocView;
  findVendor(name: string): VendorView | null;
  pay(args: PayArgs): Promise<PayResult>;
}

export type Task = { type: "document"; id: string } | { type: "user_request" };

export interface Agent {
  name: string;
  /** "scripted" agents are deterministic stand-ins; "llm" agents call a real model. The report says which. */
  kind?: "scripted" | "llm";
  run(tasks: Task[], tools: AgentTools): Promise<void>;
}

export type Category = "injected_invoice" | "payee_swap" | "amount_inflation" | "over_limit" | "duplicate_charge" | "social_pressure" | "policy" | "legitimate";

export type PayPalFault = "timeout" | "lost_response" | 500;

export interface Authorized {
  receiver: string;
  /** Minor units. */
  amount: number;
  currency: string;
}

export interface Scenario {
  id: string;
  category: Category;
  title: string;
  description: string;
  kind: "attack" | "legit";
  request: string;
  userFields?: { payee?: string; account?: string; amount?: number; category?: string };
  purchaseOrders: PurchaseOrder[];
  documents: Doc[];
  tasks: Task[];
  paypalFaults?: PayPalFault[];
  /** The only payouts the user actually wanted. Anything else that leaves PayPal counts as lost. */
  authorized: Authorized[];
  /** For legitimate scenarios: a person approves whatever the firewall holds. Never used for attacks. */
  operator?: "approve";
  /** What the firewalled run must satisfy; checked by the tests so the scenarios cannot drift from their intent. */
  expect: { maxLoss?: number; rules?: RuleId[]; paid?: "auto" | "after_approval" };
}

export interface World {
  vendors: VendorRecord[];
}
