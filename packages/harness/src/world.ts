import { ProvenanceContext, type VendorRecord } from "@pfw/core";
import type { AgentTools, Doc, DocView, Field, PayArgs, PayResult, Ref, Scenario, VendorView } from "./types";
import { formatAmount } from "@pfw/adapter";

const field = (ctx: ProvenanceContext, handle: string, value: string | number): Field => {
  ctx.register(handle, value);
  return { handle, value };
};

function renderInvoice(d: Extract<Doc, { kind: "invoice" }>): string {
  return [
    `INVOICE ${d.id}`,
    `From: ${d.vendor}`,
    ...(d.remitTo ? [`Remit to: ${d.remitTo}`] : []),
    "Line items:",
    ...d.lineItems.map((l) => `  - ${l}`),
    `Total: ${d.currency} ${formatAmount(d.total, "USD")}`,
    ...(d.note ? [`Note: ${d.note}`] : []),
  ].join("\n");
}

/** Builds the provenance context and the read-only tools. The caller supplies `pay`, the only part that differs per run. */
export function buildTools(
  s: Scenario,
  vendors: readonly VendorRecord[],
  pay: (args: PayArgs, ctx: ProvenanceContext) => Promise<PayResult>,
): { tools: AgentTools; ctx: ProvenanceContext } {
  const ctx = new ProvenanceContext();
  const requestFields: Record<string, Field> = { currency: field(ctx, "user:req#currency", "USD") };
  field(ctx, "user:req#text", s.request);
  const u = s.userFields;
  if (u?.payee) requestFields.payee = field(ctx, "user:req#payee", u.payee);
  if (u?.account) requestFields.account = field(ctx, "user:req#account", u.account);
  if (u?.amount !== undefined) requestFields.amount = field(ctx, "user:req#amount", u.amount);
  if (u?.category) requestFields.category = field(ctx, "user:req#category", u.category);

  const docs = new Map(s.documents.map((d) => [d.id, d]));
  const tools: AgentTools = {
    request: { text: s.request, fields: requestFields },
    readDocument(id): DocView {
      const d = docs.get(id);
      if (!d) throw new Error(`no such document: ${id}`);
      const fields: Record<string, Field> = {};
      if (d.kind === "invoice") {
        const h = (name: string) => `invoice:${d.id}#${name}`;
        fields.vendor = field(ctx, h("vendor"), d.vendor);
        if (d.remitTo) fields.remitTo = field(ctx, h("remitTo"), d.remitTo);
        fields.total = field(ctx, h("total"), d.total);
        fields.currency = field(ctx, h("currency"), d.currency);
        return { id: d.id, kind: "invoice", text: renderInvoice(d), fields };
      }
      fields.from = field(ctx, `email:${d.id}#from`, d.from);
      fields.body = field(ctx, `email:${d.id}#body`, d.body);
      return { id: d.id, kind: "email", text: `From: ${d.from}\nSubject: ${d.subject}\n\n${d.body}`, fields };
    },
    findVendor(name): VendorView | null {
      const v = vendors.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
      if (!v) return null;
      return {
        id: v.id,
        name: field(ctx, `vendor:${v.id}#name`, v.name),
        account: field(ctx, `vendor:${v.id}#account`, v.account),
        category: field(ctx, `vendor:${v.id}#category`, v.category),
      };
    },
    pay: (args) => pay(args, ctx),
  };
  return { tools, ctx };
}

/** Resolve a Ref to its raw value with no checks at all. Only the unprotected baseline does this. */
export function rawValue(ref: Ref, ctx: ProvenanceContext): string | number | null {
  if ("literal" in ref) return ref.literal;
  return (ctx.resolve(ref.handle)?.value as string | number | undefined) ?? null;
}
