/**
 * One command that checks the whole product against the real PayPal sandbox, and what it cannot check yet.
 *
 *   NODE_USE_ENV_PROXY=1 pnpm sandbox:check      (leave NODE_USE_ENV_PROXY out if you are not behind a proxy)
 *
 * Needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PFW_DEMO_RECEIVER (a sandbox personal account's email). It sends ONE real payout of
 * $1.00 to the receiver, in the sandbox, and registers then deletes a throwaway webhook. Nothing is printed that is secret.
 *
 * Steps: 1 credentials and scopes; 2 an injected invoice is denied before PayPal is contacted; 3 a legitimate payment is paid;
 * 4 the same payment resubmitted by a "restarted" firewall (empty store, same request) resolves to the same payout, not a second;
 * 4b the payout's status is read back by polling (no webhook needed); 4c an Orders purchase waits for the buyer and cannot be captured before they approve; 5 webhook register, list, forged-event rejection, delete; 6 whether Invoicing is enabled and, if so, that an injected invoice note and amount survive a create-and-read round trip.
 * Each step prints PASS, FAIL or SKIP with a reason. Exit code 1 if any step fails; a skipped step is not a failure.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProvenanceContext, loadPolicy } from "@pfw/core";
import { Authority, PAYPAL_SANDBOX_URL, PayPalAdapter, PayPalInvoices, PayPalOrdersAdapter, PayPalWebhooks } from "@pfw/adapter";
import { Store } from "@pfw/store";
import { Firewall } from "@pfw/firewall";

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret, PFW_DEMO_RECEIVER: receiver } = process.env;
if (!clientId || !clientSecret || !receiver) {
  console.error("Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PFW_DEMO_RECEIVER (a sandbox personal account's email). `pnpm preflight` explains each.");
  process.exit(2);
}

let failed = 0;
const pass = (step: string, detail = "") => console.log(`PASS  ${step}${detail ? `: ${detail}` : ""}`);
const fail = (step: string, detail: string) => {
  failed++;
  console.log(`FAIL  ${step}: ${detail}`);
};
const skip = (step: string, why: string) => console.log(`SKIP  ${step}: ${why}`);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 1. Credentials and scopes, read straight from the token response.
let token = "";
try {
  const res = await fetch(`${PAYPAL_SANDBOX_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`HTTP ${res.status} ${body.error_description ?? ""}`.trim());
  token = body.access_token;
  const scopes = (body.scope ?? "").split(" ");
  const has = (s: string) => scopes.some((x) => x.includes(s));
  const missing = ["payments/payouts", "applications/webhooks"].filter((s) => !has(s));
  if (missing.length) fail("1 credentials and scopes", `token works but lacks: ${missing.join(", ")}. Enable those features on the app.`);
  else pass("1 credentials and scopes", `token accepted; Payouts and Webhooks present; Invoicing scope ${has("invoicing") ? "present" : "absent"}`);
} catch (e) {
  fail("1 credentials and scopes", `${msg(e)}. Run \`pnpm preflight\` for the cause (a proxy needs NODE_USE_ENV_PROXY=1).`);
  process.exit(1);
}

const policy = loadPolicy(readFileSync(new URL("../policies/default.policy.yaml", import.meta.url), "utf8"));
const authority = new Authority(randomBytes(32));
/** PayPal requests made through the adapters built by `make`, so a step can prove none were made. */
let paypalCalls = 0;
const countingFetch: typeof fetch = (input, init) => {
  paypalCalls++;
  return fetch(input, init);
};
const make = () => {
  const store = new Store();
  store.upsertVendor({ id: "acme", name: "Acme Supplies", account: receiver, category: "office_supplies" });
  store.addPurchaseOrder({ id: "po_chk", vendorId: "acme", amount: 100, currency: "USD" });
  const adapter = new PayPalAdapter({ clientId, clientSecret, authority, fetch: countingFetch });
  return { store, adapter, firewall: new Firewall({ store, adapter, authority, policy }) };
};
const ctx = new ProvenanceContext();
ctx.register("vendor:acme#name", "Acme Supplies");
ctx.register("vendor:acme#account", receiver);
ctx.register("vendor:acme#category", "office_supplies");
ctx.register("user:req#currency", "USD");
ctx.register("invoice:chk#payee", "vendor-support@evil.example");
ctx.register("invoice:chk#total", 100);
const base = { agentId: "sandbox-check", currency: { handle: "user:req#currency" }, category: { handle: "vendor:acme#category" } };
const run = Date.now();

// 2. The attack never reaches PayPal.
try {
  const { firewall } = make();
  const before = paypalCalls;
  const r = await firewall.submit({ ...base, idempotencyKey: `chk-attack-${run}`, payee: { handle: "invoice:chk#payee" }, account: { handle: "invoice:chk#payee" }, amount: { handle: "invoice:chk#total" } }, ctx);
  if (r.status === "denied" && paypalCalls !== before) fail("2 injected invoice denied", `denied, but ${paypalCalls - before} PayPal request(s) were made first`);
  else if (r.status === "denied") pass("2 injected invoice denied", `${"rule" in r.decision ? r.decision.rule : "denied"}; no PayPal request made`);
  else fail("2 injected invoice denied", `expected denied, got ${r.status}`);
} catch (e) {
  fail("2 injected invoice denied", msg(e));
}

// 3 and 4. A legitimate $1.00 payment, then the same request from a firewall with an empty store.
const legit = { ...base, idempotencyKey: `chk-legit-${run}`, payee: { handle: "vendor:acme#name" }, account: { handle: "vendor:acme#account" }, amount: { handle: "invoice:chk#total" } };
let reference: string | undefined;
let paid: ReturnType<typeof make> | undefined;
try {
  paid = make();
  const { firewall, adapter } = paid;
  const r = await firewall.submit(legit, ctx);
  if (r.status !== "executed") fail("3 legitimate payment paid", `expected executed, got ${r.status}${"decision" in r ? `: ${r.decision.reason}` : ""}`);
  else {
    reference = r.receipt.reference;
    pass("3 legitimate payment paid", `batch ${reference}, PayPal says ${await adapter.status(reference)}`);
  }
} catch (e) {
  fail("3 legitimate payment paid", msg(e));
}
if (!reference) skip("4 resubmission after a restart", "step 3 did not produce a payout");
else {
  try {
    const { firewall } = make();
    const r = await firewall.submit(legit, ctx);
    if (r.status === "executed" && r.receipt.reference === reference) pass("4 resubmission after a restart", "resolved to the same payout, no second one");
    else fail("4 resubmission after a restart", r.status === "executed" ? `a different payout was created: ${r.receipt.reference}` : `expected executed, got ${r.status}`);
  } catch (e) {
    fail("4 resubmission after a restart", msg(e));
  }
}

// 4b. Polling: the status PayPal reports for that payout is read and recorded without any webhook.
if (!paid || !reference) skip("4b status polling", "step 3 did not produce a payout");
else {
  try {
    await paid.firewall.refreshPayoutStatuses();
    const recorded = paid.store.getExecution(legit.idempotencyKey)?.providerStatus;
    if (recorded) pass("4b status polling", `recorded PayPal's status: ${recorded}`);
    else fail("4b status polling", "no provider status was recorded after polling");
  } catch (e) {
    fail("4b status polling", msg(e));
  }
}

// 4c. Orders: an agent buying from a merchant. The firewall allows it, PayPal creates the order and waits for the BUYER; capture is refused until then.
try {
  const store = new Store();
  store.upsertVendor({ id: "acme", name: "Acme Supplies", account: receiver, category: "office_supplies" });
  store.addPurchaseOrder({ id: "po_ord", vendorId: "acme", amount: 100, currency: "USD" });
  const orders = new PayPalOrdersAdapter({ clientId, clientSecret, authority, fetch: countingFetch });
  const firewall = new Firewall({ store, adapter: orders, authority, policy });
  const order = { ...base, idempotencyKey: `chk-order-${run}`, payee: { handle: "vendor:acme#name" }, account: { handle: "vendor:acme#account" }, amount: { handle: "invoice:chk#total" } };
  const r = await firewall.submit(order, ctx);
  if (r.status !== "executed") fail("4c orders", `expected executed, got ${r.status}`);
  else {
    const again = await firewall.submit(order, ctx);
    const standalone = await new PayPalOrdersAdapter({ clientId, clientSecret, authority }).status(r.receipt.reference);
    let refused = "";
    try {
      await orders.capture(r.receipt.reference, { amount: 100, currency: "USD", receiver });
    } catch (e) {
      refused = msg(e);
    }
    if (!r.receipt.approvalUrl) fail("4c orders", "no link for the buyer to approve");
    else if (standalone !== "pending") fail("4c orders", `expected pending, PayPal says ${standalone}`);
    else if (!(again.status === "executed" && again.receipt.reference === r.receipt.reference)) fail("4c orders", "a resubmission did not resolve to the same order");
    else if (!/buyer has not approved/.test(refused)) fail("4c orders", `capture before the buyer approved was not refused: ${refused || "it went through"}`);
    else pass("4c orders", `order ${r.receipt.reference} created, waiting for the buyer (${r.receipt.approvalUrl}); retry resolves to the same order; capture refused until approved`);
  }
} catch (e) {
  fail("4c orders", msg(e));
}

// 5. Webhooks: register a throwaway endpoint, list it, send a forged event for verification, delete it.
let hookId: string | undefined;
try {
  const hooks = new PayPalWebhooks({ clientId, clientSecret });
  const reg = await hooks.register(`https://example.com/pfw-sandbox-check-${run}`);
  hookId = reg.id;
  const listed = (await hooks.list()).some((h) => h.id === reg.id);
  const verifier = new PayPalAdapter({ clientId, clientSecret, authority, webhookId: reg.id });
  const forged = await verifier.verify(
    { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270", "paypal-transmission-id": "00000000-0000-0000-0000-000000000000", "paypal-transmission-sig": "AAAA", "paypal-transmission-time": new Date().toISOString() },
    JSON.stringify({ id: "WH-FORGED", event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS", resource: {} }),
  );
  if (!listed) fail("5 webhooks", "registered but not in the list");
  else if (forged) fail("5 webhooks", "a forged event was reported as genuine");
  else pass("5 webhooks", `registered (${reg.events.length} events), listed, forged event rejected`);
} catch (e) {
  fail("5 webhooks", msg(e));
} finally {
  if (hookId) await new PayPalWebhooks({ clientId, clientSecret }).remove(hookId).catch((e) => console.log(`WARN  could not delete the throwaway webhook ${hookId}: ${msg(e)}`));
}
skip("5b signed event delivery", "needs a public https URL: `pnpm register:webhook <url>`, then send a test event from the developer dashboard");

// 6. Is Invoicing enabled on this app? (The invoice scripts need it.)
try {
  const res = await fetch(`${PAYPAL_SANDBOX_URL}/v2/invoicing/invoices?page=1&page_size=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (res.ok) {
    // The attack depends on the agent seeing the invoice's free text, so check a note survives the round trip (a draft, deleted after).
    const marker = `PFW-CHECK-NOTE-${run}`;
    const invoices = new PayPalInvoices({ clientId, clientSecret, fetch: countingFetch });
    const id = await invoices.createDraft({ businessName: "Acme Supplies", recipientEmail: receiver, invoiceNumber: `PFW-CHK-${run.toString(36).toUpperCase()}`, items: [{ name: "check", amount: 100 }], note: marker });
    try {
      const read = await invoices.get(id);
      if (read.note?.includes(marker) && read.total === 100) pass("6 invoicing", "created a draft and read its note and amount back: injected text reaches the agent");
      else fail("6 invoicing", `the note or amount did not survive the round trip (note ${JSON.stringify(read.note)}, total ${read.total})`);
    } finally {
      await fetch(`${PAYPAL_SANDBOX_URL}/v2/invoicing/invoices/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    }
  }
  else if (res.status === 403) skip("6 invoicing", "403 NOT_AUTHORIZED: enable Invoicing on the app (Apps & Credentials, the app, Features), then `pnpm seed:invoices`");
  else fail("6 invoicing", `unexpected HTTP ${res.status}`);
} catch (e) {
  fail("6 invoicing", msg(e));
}

console.log(failed ? `\n${failed} step(s) failed.` : "\nAll checked steps passed.");
process.exit(failed ? 1 : 0);
