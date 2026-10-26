/**
 *   pnpm register:webhook https://your-host/api/webhooks/paypal
 *
 * Registers your firewall's webhook endpoint with the PayPal sandbox for the payout events reconciliation uses, and prints the
 * id to set as PAYPAL_WEBHOOK_ID (the server needs it to verify event signatures). PayPal only delivers to public https URLs.
 * Not yet run against the live sandbox.
 */
import { PayPalWebhooks } from "@pfw/adapter";

const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
const url = process.argv[2];
if (!clientId || !clientSecret || !url) {
  console.error("Usage: pnpm register:webhook <https-url>   (needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)");
  process.exit(2);
}

const hooks = new PayPalWebhooks({ clientId, clientSecret });
const reg = await hooks.register(url);
console.log(`Registered ${reg.url} for ${reg.events.length} events.`);
console.log(`\nSet this on the server, then restart it:\n  PAYPAL_WEBHOOK_ID=${reg.id}`);
