/**
 * The whole chain with real PayPal on both ends.
 *
 *   pnpm demo:live <invoice-id> [<invoice-id> ...]      (invoices made by `pnpm seed:invoices`)
 *
 * Reads the invoices from your PayPal sandbox (Invoicing API), lets the scripted agent that obeys whatever a document says process them
 * through the firewall, and sends the payments the firewall allows as REAL payouts in the sandbox, to PFW_DEMO_RECEIVER (the registered
 * vendor's account). The injected invoice is denied before PayPal is contacted. Sandbox money only; each run pays real sandbox payouts,
 * so a repeat run uses fresh request ids and sends again. Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PFW_DEMO_RECEIVER.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadPolicy } from "@pfw/core";
import { Authority, PayPalAdapter, PayPalInvoices } from "@pfw/adapter";
import { Firewall } from "@pfw/firewall";
import { GullibleAgent, runOnFirewall, scenarioFromInvoices, withVendorAccount } from "@pfw/harness";
import { Store } from "@pfw/store";

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PFW_DEMO_RECEIVER: receiver } = process.env;
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!clientId || !clientSecret || !receiver || ids.length === 0) {
  console.error("Usage: pnpm demo:live <invoice-id> [...]   (needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PFW_DEMO_RECEIVER)");
  process.exit(2);
}

const invoices = new PayPalInvoices({ clientId, clientSecret });
const fetched = await Promise.all(ids.map((id) => invoices.get(id)));
for (const r of fetched) console.log(`${r.id}: ${r.vendorName} · ${(r.total / 100).toFixed(2)} ${r.currency} · note: ${r.note ? JSON.stringify(r.note.slice(0, 100)) : "(none)"}`);

const vendor = { id: "acme-live", name: "Acme Supplies", account: receiver, category: "office_supplies" };
const scenario = scenarioFromInvoices(withVendorAccount(fetched, receiver), {
  vendors: [vendor],
  purchaseOrders: [{ id: "po_live", vendorId: vendor.id, amount: fetched[0]?.total ?? 0, currency: fetched[0]?.currency ?? "USD" }],
});

const policy = loadPolicy(readFileSync(new URL("../policies/default.policy.yaml", import.meta.url), "utf8"));
const authority = new Authority(randomBytes(32));
const adapter = new PayPalAdapter({ clientId, clientSecret, authority });
const store = new Store();
const firewall = new Firewall({ store, adapter, authority, policy });

console.log("\nThe agent (which does whatever a document says) now processes them, behind the firewall, with real sandbox payouts:\n");
const run = await runOnFirewall(scenario, new GullibleAgent(), { store, firewall, keyPrefix: `live-${Date.now()}-` });
for (const c of run.calls) console.log(`  ${c.status.padEnd(14)} ${c.rule ?? "all checks passed"}: ${c.message}`);
for (const r of run.receipts) console.log(`  PAID ${(r.amount / 100).toFixed(2)} ${r.currency} to ${r.receiver} · payout ${r.reference} · PayPal says ${await adapter.status(r.reference)}`);
const evil = fetched.filter((r) => /evil\.example/.test(r.note ?? ""));
console.log(`\n${run.receipts.length} real payout(s) sent; ${evil.length ? `${evil.length} injected invoice(s) in the batch, and no payment went to the injected address: ${run.receipts.every((r) => r.receiver === receiver)}` : "no injected invoice in this batch"}.`);
console.log(`Audit log: ${JSON.stringify(store.audit.verify())}`);
process.exit(run.receipts.every((r) => r.receiver === receiver) ? 0 : 1);
