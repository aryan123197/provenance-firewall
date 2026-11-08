/**
 * Checks reconciliation against the real PayPal sandbox, end to end.
 *
 *   NODE_USE_ENV_PROXY=1 pnpm recon:live-check      (leave NODE_USE_ENV_PROXY out if you are not behind a proxy)
 *
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PFW_DEMO_RECEIVER (the email of a sandbox personal account; one that is not a
 * PayPal account makes the item UNCLAIMED, which is also worth checking). It sends ONE real payout of $1.00 in the sandbox
 * through the firewall, reads PayPal's payout batch details back, maps and imports them, and checks the payment and the line match.
 *
 * Set RECON_SAVE_FIXTURE=path.json to write the recorded response (ours and PayPal's, unedited) to a file, for example to record a
 * fully SUCCESSFUL item as a new fixture. Nothing secret is printed or saved.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ProvenanceContext, loadPolicy } from "@pfw/core";
import { Authority, PAYPAL_SANDBOX_URL, PayPalAdapter } from "@pfw/adapter";
import { Store } from "@pfw/store";
import { Firewall } from "@pfw/firewall";
import { ReconStore, bankLinesFromPayoutBatch } from "@pfw/recon";

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PFW_DEMO_RECEIVER: receiver } = process.env;
if (!clientId || !clientSecret || !receiver) {
  console.error("Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PFW_DEMO_RECEIVER (a sandbox personal account's email). `pnpm preflight` explains each.");
  process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
};

const policy = loadPolicy(readFileSync(new URL("../policies/default.policy.yaml", import.meta.url), "utf8"));
const authority = new Authority(randomBytes(32));
const store = new Store();
store.upsertVendor({ id: "acme", name: "Acme Supplies", account: receiver, category: "office_supplies" });
store.addPurchaseOrder({ id: "po_live", vendorId: "acme", amount: 100, currency: "USD" });
const firewall = new Firewall({ store, adapter: new PayPalAdapter({ clientId, clientSecret, authority }), authority, policy });
const ctx = new ProvenanceContext();
ctx.register("vendor:acme#name", "Acme Supplies");
ctx.register("vendor:acme#account", receiver);
ctx.register("vendor:acme#category", "office_supplies");
ctx.register("user:req#currency", "USD");
ctx.register("invoice:live#total", 100);

const key = `recon-live-${Date.now()}`;
const paid = await firewall.submit(
  { agentId: "recon-live-check", idempotencyKey: key, currency: { handle: "user:req#currency" }, category: { handle: "vendor:acme#category" }, payee: { handle: "vendor:acme#name" }, account: { handle: "vendor:acme#account" }, amount: { handle: "invoice:live#total" } },
  ctx,
);
if (paid.status !== "executed") {
  check("1 a $1.00 sandbox payout is sent through the firewall", false, `expected executed, got ${paid.status}`);
  process.exit(1);
}
check("1 a $1.00 sandbox payout is sent through the firewall", true, `payout_batch_id ${paid.receipt.reference}`);

// 2. Read PayPal's own record of it back, waiting for the item to leave PENDING.
const tokenRes = await fetch(`${PAYPAL_SANDBOX_URL}/v1/oauth2/token`, {
  method: "POST",
  headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
const { access_token: token } = (await tokenRes.json()) as { access_token?: string };
if (!token) {
  check("2 PayPal's payout batch details are read back", false, `token request failed (HTTP ${tokenRes.status})`);
  process.exit(1);
}
let batch: unknown;
let itemStatus = "";
for (let i = 0; i < 24; i++) {
  const res = await fetch(`${PAYPAL_SANDBOX_URL}/v1/payments/payouts/${paid.receipt.reference}`, { headers: { authorization: `Bearer ${token}` } });
  batch = await res.json();
  itemStatus = String((batch as { items?: { transaction_status?: string }[] }).items?.[0]?.transaction_status ?? "");
  if (res.ok && itemStatus && itemStatus !== "PENDING") break;
  await new Promise((r) => setTimeout(r, 5000));
}
check("2 PayPal's payout batch details are read back", itemStatus !== "", `item is ${itemStatus || "missing"}`);
if (process.env.RECON_SAVE_FIXTURE) {
  writeFileSync(process.env.RECON_SAVE_FIXTURE, `${JSON.stringify({ ledger: { reference: paid.receipt.reference, requestId: paid.receipt.requestId, amount: paid.receipt.amount, currency: paid.receipt.currency, receiver: paid.receipt.receiver, createdAt: paid.receipt.createdAt }, batch }, null, 2)}\n`);
  console.log(`      recorded to ${process.env.RECON_SAVE_FIXTURE}`);
}

// 3. Map and import it, then reconcile it against what the firewall really stored.
const recon = new ReconStore(store);
try {
  const lines = bankLinesFromPayoutBatch(batch);
  check("3 the real response maps to settlement lines", lines.length === 1, JSON.stringify(lines[0]));
  recon.importBankLines(lines, "recon-live-check");
  const item = recon.run("recon-live-check").report.items[0];
  check("4 the payment and PayPal's line match by reference", item?.status === "matched" && item.method === "reference" && item.ledgerKey === key, `${item?.status}/${item?.reason}${item?.method ? ` via ${item.method}` : ""}`);
  check("5 the amounts agree and the purchase order is linked", item?.difference === 0 && item.invoice.poId === "po_live", `difference ${item?.difference}, invoice ${JSON.stringify(item?.invoice)}`);
  check("6 PayPal's fee is proposed as an adjustment, not posted", recon.adjustments("proposed").some((a) => a.kind === "fee" && a.amount === item?.fee) && item!.fee > 0, `fee ${item?.fee} cents`);
} catch (e) {
  check("3-6 map, import and reconcile", false, e instanceof Error ? e.message : String(e));
}
console.log(`\nObserved transaction_status: ${itemStatus}. ${itemStatus === "SUCCESS" ? "" : "A fully SUCCESSFUL item (use a sandbox personal account as PFW_DEMO_RECEIVER) has not been checked by this run."}`);
process.exit(failed ? 1 : 0);
