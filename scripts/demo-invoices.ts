/**
 *   pnpm demo:invoices <invoice-id> [<invoice-id> ...] [--po=450.00]
 *
 * Reads the given invoices from your PayPal sandbox (Invoicing API) and shows what an unprotected agent and the same agent
 * behind the firewall do with them. The registry says the issuer (business name "Acme Supplies"; its account is PFW_INVOICER_EMAIL if set, else the invoice's own) is a
 * trusted vendor with one open purchase order of --po (default 450.00). Payouts on both sides are simulated, so no sandbox
 * money moves; only the invoices are read live. Run live against the sandbox.
 */
import { readFileSync } from "node:fs";
import { loadPolicy } from "@pfw/core";
import { PayPalInvoices } from "@pfw/adapter";
import { GullibleAgent, runAll, scenarioFromInvoices } from "@pfw/harness";

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PFW_INVOICER_EMAIL: issuer } = process.env;
const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith("--"));
const po = Number(args.find((a) => a.startsWith("--po="))?.slice(5) ?? "450");
if (!clientId || !clientSecret || ids.length === 0 || !Number.isFinite(po)) {
  console.error("Usage: pnpm demo:invoices <invoice-id> [...] [--po=450.00]   (needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET; PFW_INVOICER_EMAIL optional)");
  process.exit(2);
}

const invoices = new PayPalInvoices({ clientId, clientSecret });
const fetched = await Promise.all(ids.map((id) => invoices.get(id)));
for (const r of fetched) console.log(`${r.id}: ${r.vendorName} · ${(r.total / 100).toFixed(2)} ${r.currency} · note: ${r.note ? JSON.stringify(r.note.slice(0, 100)) : "(none)"}`);

const vendorAccount = issuer ?? fetched.find((r) => r.remitTo)?.remitTo ?? "acme@sandbox.example";
// A real sandbox invoice does not state the issuer's email (seen live): payment goes to the issuer implicitly. So where it is absent,
// the invoice is treated as asking for the registered vendor's own account; where an invoice does state one, that is kept as is.
const records = fetched.map((r) => (r.remitTo ? r : { ...r, remitTo: vendorAccount }));
if (fetched.some((r) => !r.remitTo)) console.log("(PayPal does not return the issuer's email on these invoices, so they are treated as payable to the registered vendor's account.)");
const vendor = { id: "acme-live", name: "Acme Supplies", account: vendorAccount, category: "office_supplies" };
const scenario = scenarioFromInvoices(records, {
  vendors: [vendor],
  purchaseOrders: [{ id: "po_live", vendorId: vendor.id, amount: Math.round(po * 100), currency: "USD" }],
});

const policy = loadPolicy(readFileSync(new URL("../policies/default.policy.yaml", import.meta.url), "utf8"));
const { card } = await runAll(policy, new GullibleAgent(), [scenario]);
const r = card.scenarios[0]!;
console.log(`\nUnprotected agent: ${r.baseline.unauthorizedPayouts ? `LOST $${(r.baseline.unauthorizedAmount / 100).toFixed(2)}` : r.baseline.summary}`);
console.log(`With the firewall: ${r.firewalled.unauthorizedPayouts ? `LOST $${(r.firewalled.unauthorizedAmount / 100).toFixed(2)}` : r.firewalled.summary}${r.firewalled.rules.length ? `  (rules: ${r.firewalled.rules.join(", ")})` : ""}`);
