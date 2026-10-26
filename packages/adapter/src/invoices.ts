import { formatAmount } from "./money";
import { PayPalHttp, type PayPalHttpConfig } from "./paypal-http";
import { AdapterError } from "./types";
import { parseMinorUnits } from "./webhook";

/**
 * An invoice as PayPal Invoicing returns it, reduced to what an agent reads. Every field here was written by whoever
 * issued the invoice, so all of it is untrusted content: the free-text fields (note, terms, memo, line item names and
 * descriptions) are exactly where injected instructions arrive.
 */
export interface InvoiceRecord {
  id: string;
  number?: string;
  status?: string;
  /** The issuer's business name, else their personal name. */
  vendorName?: string;
  /** The issuer's PayPal email, where the invoice asks to be paid. */
  remitTo?: string;
  /** Minor units. */
  total: number;
  currency: string;
  lineItems: string[];
  /** note, terms and memo joined, in that order. */
  note?: string;
}

export interface NewInvoice {
  businessName: string;
  /** The issuer's email. */
  email: string;
  recipientEmail: string;
  invoiceNumber?: string;
  currency?: string;
  items: { name: string; description?: string; /** Minor units. */ amount: number }[];
  note?: string;
  terms?: string;
}

interface PayPalInvoice {
  id?: string;
  status?: string;
  detail?: { invoice_number?: string; currency_code?: string; note?: string; memo?: string; terms_and_conditions?: string };
  invoicer?: { business_name?: string; name?: { full_name?: string; given_name?: string; surname?: string }; email_address?: string };
  items?: { name?: string; description?: string; quantity?: string; unit_amount?: { currency_code?: string; value?: string } }[];
  amount?: { currency_code?: string; value?: string };
  due_amount?: { currency_code?: string; value?: string };
}

/** PayPal invoice ids look like INV2-ABCD-1234-WXYZ-5678. Anything else would be a path injection, so it is refused. */
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new AdapterError(`not a PayPal invoice id: ${JSON.stringify(id).slice(0, 40)}`, false);
  return id;
};

export function toInvoiceRecord(raw: PayPalInvoice): InvoiceRecord {
  const money = raw.amount ?? raw.due_amount;
  const total = parseMinorUnits(money?.value);
  if (!raw.id || total === undefined || !money?.currency_code) throw new AdapterError("the invoice has no id or amount", false);
  const inv = raw.invoicer;
  const fullName = inv?.name?.full_name ?? [inv?.name?.given_name, inv?.name?.surname].filter(Boolean).join(" ");
  const vendorName = inv?.business_name ?? (fullName || undefined);
  const note = [raw.detail?.note, raw.detail?.terms_and_conditions, raw.detail?.memo].filter((t): t is string => Boolean(t)).join("\n");
  return {
    id: raw.id,
    ...(raw.detail?.invoice_number ? { number: raw.detail.invoice_number } : {}),
    ...(raw.status ? { status: raw.status } : {}),
    ...(vendorName ? { vendorName } : {}),
    ...(inv?.email_address ? { remitTo: inv.email_address } : {}),
    total,
    currency: money.currency_code,
    lineItems: (raw.items ?? []).map((i) => `${i.name ?? "Item"}${i.description ? `: ${i.description}` : ""}${i.quantity && i.quantity !== "1" ? ` x${i.quantity}` : ""}`),
    ...(note ? { note } : {}),
  };
}

/** PayPal Invoicing (v2). Read invoices an agent should process, and create sandbox invoices to demonstrate attacks. */
export class PayPalInvoices {
  private readonly http: PayPalHttp;

  constructor(cfg: PayPalHttpConfig | PayPalHttp) {
    this.http = cfg instanceof PayPalHttp ? cfg : new PayPalHttp(cfg);
  }

  async get(id: string): Promise<InvoiceRecord> {
    return toInvoiceRecord((await this.http.request("GET", `/v2/invoicing/invoices/${checkId(id)}`)) as PayPalInvoice);
  }

  async list(opts: { page?: number; pageSize?: number } = {}): Promise<InvoiceRecord[]> {
    const q = `page=${opts.page ?? 1}&page_size=${Math.min(opts.pageSize ?? 20, 100)}&total_required=true`;
    const res = (await this.http.request("GET", `/v2/invoicing/invoices?${q}`)) as { items?: PayPalInvoice[] } | undefined;
    return (res?.items ?? []).map(toInvoiceRecord);
  }

  /** Creates a draft invoice and returns its id. Sandbox use: seeding the invoices the demo agent reads. */
  async createDraft(spec: NewInvoice): Promise<string> {
    const cur = spec.currency ?? "USD";
    const body = {
      detail: {
        ...(spec.invoiceNumber ? { invoice_number: spec.invoiceNumber } : {}),
        currency_code: cur,
        ...(spec.note ? { note: spec.note } : {}),
        ...(spec.terms ? { terms_and_conditions: spec.terms } : {}),
        payment_term: { term_type: "NET_10" },
      },
      invoicer: { business_name: spec.businessName, email_address: spec.email },
      primary_recipients: [{ billing_info: { email_address: spec.recipientEmail } }],
      items: spec.items.map((i) => ({
        name: i.name,
        ...(i.description ? { description: i.description } : {}),
        quantity: "1",
        unit_amount: { currency_code: cur, value: formatAmount(i.amount, cur) },
      })),
    };
    const res = (await this.http.request("POST", "/v2/invoicing/invoices", body)) as { href?: string } | undefined;
    const id = res?.href?.split("/").pop();
    if (!id) throw new AdapterError("PayPal did not return the new invoice's link", false);
    return checkId(id);
  }

  /** Sends a draft to its recipient, which makes it a real (sandbox) invoice. */
  async send(id: string): Promise<void> {
    await this.http.request("POST", `/v2/invoicing/invoices/${checkId(id)}/send`, { send_to_recipient: true, send_to_invoicer: false });
  }
}
