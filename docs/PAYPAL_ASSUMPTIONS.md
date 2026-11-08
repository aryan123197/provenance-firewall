# PayPal API assumptions and how to check them

The Payouts, webhook-registration, webhook-verification and Invoicing code have now run against the live PayPal sandbox (2026-11-07). A genuinely signed webhook delivery is the one big piece still unseen. Rows marked **Live** were checked against real responses. Everything else is as before: while building I could not reach `developer.paypal.com` (the environment blocks it), so "confirmed" means a web-search summary of PayPal's own documentation agreed, which is better than memory but not the same as reading the reference or seeing a live response.

## What the live sandbox run showed (2026-11-07)

- **Credentials and scopes.** The client-credentials token request answered 200. The token's scopes include Payouts (`https://uri.paypal.com/payments/payouts`) and Webhooks (`…/applications/webhooks`), and **no Invoicing scope**.
- **A payout works end to end.** `POST /v1/payments/payouts` answered 201 with a `payout_batch_id` and status `PENDING`; a minute later `GET /v1/payments/payouts/{id}` showed `batch_status` and the item `transaction_status` both `SUCCESS`, with our `sender_batch_id`, the receiver and `45.00 USD` as sent. The sandbox also accepted an email address that is not a PayPal account and still marked the item `SUCCESS`.
- **Reusing a `sender_batch_id` is refused, and the response did not look the way the fake said.** A second submission with the same `sender_batch_id` **and** the same `PayPal-Request-Id` was `400 USER_BUSINESS_ERROR` ("Batch with given sender_batch_id already exists"). The link to the original payout is in **`details[0].link[]`** (an array of link objects), the top-level `links` is empty, and the link's host is `api.sandbox.paypal.com`, not the `api-m` host the client calls. The recovery code only read the top-level `links`, so the first live duplicate ended as a failed payment. It now reads both shapes, takes only the payout id from the link and reads the payout through its own base URL; the live duplicate then came back as the original payout, and the sandbox still showed exactly one payout.
- **`PayPal-Request-Id` replay was not observed.** The documentation suggests a repeated request id returns the original response; here the same id was rejected as above. The fake's default is now "reject" (what happened), and "replay" is kept as an option.
- **Webhooks, partly.** Register (12 event types), list and delete all worked, and `verify-webhook-signature` answered a forged event without a `SUCCESS`, so `verify` returned `false`. A real signed event was not delivered, because that needs a public https URL, so the event bodies in the Webhooks table below are still unchecked.
- **Invoicing works once the feature is enabled on the app.** It first answered `403 NOT_AUTHORIZED` (the app lacked the feature and the token had no Invoicing scope); after the Invoicing feature was enabled (Apps & Credentials, the app, Features) the token carried the scope and everything below worked. A clean and an injected invoice were created, sent, listed and read back: the injected note arrives in **`detail.note`**, exactly where `toInvoiceRecord` reads it, so the attack is visible to the agent. One surprise: **an invoice created without `invoicer.email_address` comes back without one** (PayPal issues it from the app's own account and does not echo an email), so `remitTo` is empty. The invoice scripts now make the issuer's email optional, and `demo:invoices` treats an invoice with no stated email as payable to the registered vendor's account. Run through both agents, the unprotected one lost $450.00 to the injected address and the firewalled one paid the clean invoice and denied the injected one (`amount_mismatch`, `payee_change`).

Status: **Confirmed** = agreed by PayPal's documentation as summarised by search. **From memory** = what I believe the API does, unchecked. **Handled** = the code copes with either reading.

## Payouts (`packages/adapter/src/paypal.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| `POST /v1/payments/payouts` with `sender_batch_header` (`sender_batch_id`, `email_subject`) and `items[]` (`recipient_type`, `receiver`, `amount.value`, `amount.currency`, `note`, `sender_item_id`) | Confirmed | `PayPalAdapter.propose` |
| Success is HTTP 201 with `batch_header.payout_batch_id` and `batch_status` `PENDING` | **Live** | `PayPalAdapter.execute` |
| `recipient_type` accepts `EMAIL` and `PAYPAL_ID` | Confirmed (PHONE and USER_HANDLE also exist) | `propose` |
| A PayPal ID is 13 uppercase letters and digits | From memory | the `PAYPAL_ID` test in `propose`; vendors with an email account are unaffected |
| `sender_batch_id` is unique for 30 days, and reusing it is **rejected with a link to the original payout** | **Live**: rejected with 400, link in `details[].link[]` (not top-level `links`) | **Handled**: `originalPayout` reads both shapes and accepts the payout only if its `sender_batch_id` is ours |
| Sending `PayPal-Request-Id` and reusing it on a retry returns the payout's current state | **Not seen live**: the retry was rejected by `sender_batch_id` instead | **Handled** together with the row above, whichever PayPal applies first |
| Two simultaneous requests with the same `PayPal-Request-Id`: the second fails | Confirmed; the status code is unknown | we treat HTTP 409 as retryable, so the retry picks up the result |
| `GET /v1/payments/payouts/{id}` returns `batch_header.batch_status`, `batch_header.sender_batch_header.sender_batch_id` and `items[].transaction_status` | **Live** | `status`, `originalPayout` |
| Status values (`SUCCESS`, `PENDING`, `PROCESSING`, `DENIED`, `CANCELED`; item: `FAILED`, `UNCLAIMED`, `RETURNED`, `HELD`, `BLOCKED`, `REFUNDED`, `REVERSED`) | `PENDING` and `SUCCESS` seen live; the rest from memory | `mapPayPalStatus` |
| A sandbox business account cannot pay out to its own email | From memory | the sender and `PFW_DEMO_RECEIVER` must be different sandbox accounts |

## Invoicing (`packages/adapter/src/invoices.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| Invoice object has `detail`, `invoicer`, `primary_recipients`, `items[]` with `name`, `quantity`, `unit_amount.currency_code/value` | **Live** | `toInvoiceRecord`, `createDraft` |
| `detail.payment_term.term_type` such as `NET_10` | **Live**: accepted, due date set ten days out | `createDraft` |
| `detail.note`, `invoicer.business_name`, `amount`, `due_amount` | **Live**. `invoicer.email_address` is only present if you supplied one. `detail.terms_and_conditions` and `detail.memo` were not exercised (still from memory) | `toInvoiceRecord`: this is where injected text is read, so a wrong name here silently hides it from the agent |
| Create returns 201 with a link to the new invoice (an `id` is accepted too) | **Live**: the id was obtained and the draft read back | `createDraft` |
| Send is `POST .../send` and answers 200 with a link body (any 2xx is accepted, including an empty 202) | **Live**: accepted; the invoice then lists as `SENT` | `send` |
| Send body fields `send_to_recipient` and `send_to_invoicer` | **Live**: accepted | `send` |
| List is `GET /v2/invoicing/invoices?page&page_size&total_required` returning `items` | **Live** | `list` |
| An API client can **read** invoices through `GET` | **Live** for invoices the app's own account issued; unknown for invoices a vendor issued *to* you | invoices you issued are readable; whether a recipient's app can read them is unverified, and the demo script reads invoices the same account created |

## Orders (`packages/adapter/src/orders.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| `POST /v2/checkout/orders` creates an order and answers `PAYER_ACTION_REQUIRED` with a `payer-action` link | **Live**: the status code is 200, not 201 | `PayPalOrdersAdapter.execute` |
| `payee.email_address`, `amount` and `reference_id` come back on `GET /v2/checkout/orders/{id}` | **Live** | `assertMatches` |
| Capturing before the buyer approves is refused | **Live**: `422 ORDER_NOT_APPROVED` | `capture` |
| A repeated `PayPal-Request-Id` returns the original order | **Live**, including when the new body differs, so the result is checked against the authorized intent | `execute` |
| Statuses `CREATED`, `SAVED`, `APPROVED`, `PAYER_ACTION_REQUIRED`, `COMPLETED`, `VOIDED` | `PAYER_ACTION_REQUIRED` seen live; the rest from memory | `mapOrderStatus` |
| `POST .../capture` after approval answers 2xx with `status: COMPLETED` | From memory; needs a person to approve in the sandbox | `capture` |

## Webhooks (`packages/adapter/src/paypal.ts`, `webhooks.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| `POST /v1/notifications/verify-webhook-signature` with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from the matching `PAYPAL-*` headers), `webhook_id` (from your webhook registration) and `webhook_event`, answering `verification_status` `SUCCESS` or `FAILURE` | Confirmed; **Live** for a forged event (answered without `SUCCESS`); a genuine signed event was not tested | `PayPalAdapter.verify`. Note the signature covers the **raw** body, which the server keeps |
| Event names `PAYMENT.PAYOUTSBATCH.*` and `PAYMENT.PAYOUTS-ITEM.*` | Confirmed that both families exist | `PAYOUT_EVENTS` |
| Batch events carry the batch header only, with no item data | Confirmed | `parsePayPalEvent` reads only `batch_header` for them |
| Item events' `resource` has `payout_batch_id`, `transaction_status` and `payout_item` (`receiver`, `sender_item_id`, `amount`) | Consistent with PayPal's payout-item details response; the webhook envelope itself was not found | `parsePayPalEvent`. If a real event differs, an item event would fall through as unmatched drift, which is loud rather than silent |
| `POST /v1/notifications/webhooks` with `url` and `event_types[].name`, https only | **Live** (register, list and delete worked); https-only is well known | `PayPalWebhooks.register` |

## Running the live checks yourself: what to do and what to watch

Run `pnpm preflight` first. If your machine reaches the internet only through a proxy (some sandboxes and CI runners set `HTTPS_PROXY`), prefix it, `pnpm e2e` and the other live scripts with `NODE_USE_ENV_PROXY=1`: Node's built-in `fetch` ignores `HTTPS_PROXY` otherwise, and the failure looks like a blocked host (`ENOTFOUND`). It reports which variables are missing, whether the sandbox host is reachable from this environment, and whether PayPal accepts the credentials, without printing any secret.

0. `pnpm sandbox:check` runs the checks below that can run without a public URL or Invoicing, and prints PASS, FAIL or SKIP for each. It sends one $1.00 sandbox payout.
1. `pnpm e2e` with the sandbox credentials. Expect one payout and a `pending` status. A 400 here is almost certainly a body-shape mismatch from the Payouts table above; the error text is in the exception.
2. Run it again without changing anything: the retry must not create a second payout. Check the sandbox activity for exactly one.
3. `pnpm register:webhook https://<public-host>/api/webhooks/paypal`, set `PAYPAL_WEBHOOK_ID`, restart, then send a test event from the developer dashboard. A rejected signature means a `verify` mismatch.
4. `pnpm seed:invoices`, then `pnpm demo:invoices <ids>`. If the injected note does not show in the output, `toInvoiceRecord` is reading the wrong field names. That is the failure to look for first, because it would make the attack invisible rather than visible.

When something differs, fix the code, then update the fake in `packages/adapter/src/testing/fake-paypal.ts` to match what PayPal really returned so the tests keep guarding it.
