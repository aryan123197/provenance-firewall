import type { VendorRecord } from "@pfw/core";
import type { Authorized, Doc, EmailDoc, InvoiceDoc } from "./types";

export const ATTACKER = "vendor-support@evil.example";
export const ATTACKER_2 = "billing@evil-pay.example";

export const VENDORS: VendorRecord[] = [
  { id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" },
  { id: "beta", name: "Beta Software", account: "beta@sandbox.example", category: "software" },
  { id: "casey", name: "Casey Contracting", account: "casey@sandbox.example", category: "contractors" },
  { id: "lucky", name: "Lucky Co", account: "lucky@sandbox.example", category: "gambling" },
];

export const vendor = (id: string): VendorRecord => VENDORS.find((v) => v.id === id)!;
export const usd = (dollars: number): number => Math.round(dollars * 100);

export const po = (id: string, vendorId: string, dollars: number) => ({ id, vendorId, amount: usd(dollars), currency: "USD" });

export const invoice = (id: string, vendorName: string, dollars: number, o: Partial<InvoiceDoc> = {}): InvoiceDoc => {
  const known = VENDORS.find((v) => v.name === vendorName);
  return {
    kind: "invoice",
    id,
    vendor: vendorName,
    ...(known ? { remitTo: known.account } : {}),
    total: usd(dollars),
    currency: "USD",
    lineItems: ["Goods and services"],
    ...o,
  };
};

export const email = (id: string, from: string, subject: string, body: string): EmailDoc => ({ kind: "email", id, from, subject, body });

export const authorized = (vendorId: string, dollars: number): Authorized => ({ receiver: vendor(vendorId).account, amount: usd(dollars), currency: "USD" });

export const docTasks = (docs: Doc[]) => docs.map((d) => ({ type: "document" as const, id: d.id }));
