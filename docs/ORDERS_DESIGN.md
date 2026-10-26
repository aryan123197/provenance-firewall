# Orders / Checkout: design note (not implemented)

The spec lists an Orders path for agents buying goods from a merchant as a should-have. It is not built. This note records why, and how it would fit, so it is a small step once there is a sandbox to test against rather than a rewrite.

## Why it was left out

PayPal's Orders v2 flow, as its documentation describes it (confirmed through search summaries; I could not read the reference or call the API):

1. `POST /v2/checkout/orders` with `intent: CAPTURE`, `purchase_units[]` (`reference_id`, `amount.currency_code/value`, `payee.email_address`) and `payment_source.paypal.experience_context` (`return_url`, `cancel_url`). The order comes back `PAYER_ACTION_REQUIRED` with a `payer-action` link.
2. **The buyer approves the order on PayPal's checkout page.** A capture succeeds only if the buyer has approved it or a valid `payment_source` is supplied.
3. `POST /v2/checkout/orders/{id}/capture`.

An agent can therefore start a purchase, but it cannot finish one on its own. Finishing without a person present needs a **vaulted** PayPal wallet (`payment_source.paypal.vault_id`), which requires approval for PayPal Billing Agreements on the account. I could not confirm that is available to a sandbox app, and the docs show a 422 "payer action required" case even with a token.

Building the create, approve and capture state machine, a return-URL endpoint and the extra webhook events against an API I cannot reach would add a lot of unverified code to a money path. That seemed worse than leaving the surface out and saying so.

## How it would fit

- **Same decision, earlier.** The firewall decides on the merchant (payee), the amount and the currency exactly as it does for a payout. A merchant is a registry vendor whose account is its PayPal email, so the payee-swap and untrusted-payee rules apply unchanged. Nothing is sent to PayPal unless the verdict is allow or a person approved.
- **A second, independent gate.** Because the buyer must approve the order in PayPal, an order the firewall allowed still cannot complete without the actual account holder. For agentic commerce that is a feature: the firewall stops the agent from *starting* a bad purchase, and PayPal's approval stops a purchase *finishing* without the owner.
- **Adapter.** `PayPalOrdersAdapter implements PaymentAdapter`: `execute` creates the order and returns a receipt with status `pending` and the `payer-action` link; `status` reads the order. It would take the same `AllowedIntent` and verify it the same way, and reuse `PayPalHttp`.
- **Capture is a separate, guarded step.** After the buyer approves (`CHECKOUT.ORDER.APPROVED`, or the return URL), a capture call must check that the order id belongs to an execution we recorded and that its amount and payee still match the authorized decision, then capture, then record the capture in the audit log. A return-URL endpoint must not capture an order the firewall did not authorize.
- **Idempotency.** `PayPal-Request-Id` is mandatory on single-step create calls and, per the docs, stored for **6 hours** by default (72 with an account manager), much shorter than the 30 days for a Payouts `sender_batch_id`. Retries beyond that window need the same "find the original" recovery the Payouts adapter has, keyed on `reference_id`.
- **Reconciliation.** `PAYMENT.CAPTURE.COMPLETED` events carry the order id; they would be parsed into `ProviderEvent` and matched the same way, so a capture PayPal reports that we did not authorize becomes drift.
- **Dashboard.** The decision replay would show "waiting for the buyer to approve" with the PayPal link, and a drift or capture status once known.

## What to check first when building it

Create an order with a payee in the sandbox and confirm the response shape and `links`; confirm whether a sandbox business account can vault a wallet for off-session capture; confirm the capture, approval and reconciliation event payloads; and confirm `PayPal-Request-Id` retention behaviour for a retried create.
