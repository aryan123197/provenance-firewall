# PayPal API assumptions and how to check them

None of the PayPal code has run against the live sandbox. This page lists every assumption the adapter makes, how well each is backed, and what to look at if a real response disagrees. While building I could not reach `developer.paypal.com` (the environment blocks it), so "confirmed" below means a web-search summary of PayPal's own documentation agreed, which is better than memory but not the same as reading the reference or seeing a live response.

Status: **Confirmed** = agreed by PayPal's documentation as summarised by search. **From memory** = what I believe the API does, unchecked. **Handled** = the code copes with either reading.

## Payouts (`packages/adapter/src/paypal.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| `POST /v1/payments/payouts` with `sender_batch_header` (`sender_batch_id`, `email_subject`) and `items[]` (`recipient_type`, `receiver`, `amount.value`, `amount.currency`, `note`, `sender_item_id`) | Confirmed | `PayPalAdapter.propose` |
| Success is HTTP 201 with `batch_header.payout_batch_id` and `batch_status` `PENDING` | Confirmed | `PayPalAdapter.execute` |
| `recipient_type` accepts `EMAIL` and `PAYPAL_ID` | Confirmed (PHONE and USER_HANDLE also exist) | `propose` |
| A PayPal ID is 13 uppercase letters and digits | From memory | the `PAYPAL_ID` test in `propose`; vendors with an email account are unaffected |
| `sender_batch_id` is unique for 30 days, and reusing it is **rejected with a link to the original payout** | Confirmed | **Handled**: `originalPayout` follows such a link and accepts it only if that payout's `sender_batch_id` is ours |
| Sending `PayPal-Request-Id` and reusing it on a retry returns the payout's current state | Confirmed (retention period not found) | **Handled** together with the row above, whichever PayPal applies first |
| Two simultaneous requests with the same `PayPal-Request-Id`: the second fails | Confirmed; the status code is unknown | we treat HTTP 409 as retryable, so the retry picks up the result |
| `GET /v1/payments/payouts/{id}` returns `batch_header.batch_status`, `batch_header.sender_batch_header.sender_batch_id` and `items[].transaction_status` | From memory | `status`, `originalPayout` |
| Status values (`SUCCESS`, `PENDING`, `PROCESSING`, `DENIED`, `CANCELED`; item: `FAILED`, `UNCLAIMED`, `RETURNED`, `HELD`, `BLOCKED`, `REFUNDED`, `REVERSED`) | From memory | `mapPayPalStatus` |
| A sandbox business account cannot pay out to its own email | From memory | the sender and `PFW_DEMO_RECEIVER` must be different sandbox accounts |

## Invoicing (`packages/adapter/src/invoices.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| Invoice object has `detail`, `invoicer`, `primary_recipients`, `items[]` with `name`, `quantity`, `unit_amount.currency_code/value` | Confirmed | `toInvoiceRecord`, `createDraft` |
| `detail.payment_term.term_type` such as `NET_10` | Confirmed that `term_type` exists with values like `NET_30`; `NET_10` from memory | `createDraft` |
| `detail.note`, `detail.terms_and_conditions`, `detail.memo`, `invoicer.business_name`, `invoicer.email_address`, `amount`, `due_amount` | From memory | `toInvoiceRecord`: this is where injected text is read, so a wrong name here silently hides it from the agent |
| Create returns 201 with a link to the new invoice (an `id` is accepted too) | Confirmed that it is 201 with a PayPal-assigned id; link-versus-id shape handled both ways | `createDraft` |
| Send is `POST .../send` and answers 200 with a link body (any 2xx is accepted, including an empty 202) | Confirmed 200 and the link body | `send` |
| Send body fields `send_to_recipient` and `send_to_invoicer` | `send_to_invoicer` confirmed from PayPal's sample; `send_to_recipient` from memory | `send` |
| List is `GET /v2/invoicing/invoices?page&page_size&total_required` returning `items` | From memory | `list` |
| An API client can **read** invoices through `GET` | Unknown for invoices a vendor issued *to* you | invoices you issued are readable; whether a recipient's app can read them is unverified, and the demo script reads invoices the same account created |

## Webhooks (`packages/adapter/src/paypal.ts`, `webhooks.ts`)

| Assumption | Status | If wrong, look at |
| --- | --- | --- |
| `POST /v1/notifications/verify-webhook-signature` with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (from the matching `PAYPAL-*` headers), `webhook_id` (from your webhook registration) and `webhook_event`, answering `verification_status` `SUCCESS` or `FAILURE` | Confirmed | `PayPalAdapter.verify`. Note the signature covers the **raw** body, which the server keeps |
| Event names `PAYMENT.PAYOUTSBATCH.*` and `PAYMENT.PAYOUTS-ITEM.*` | Confirmed that both families exist | `PAYOUT_EVENTS` |
| Batch events carry the batch header only, with no item data | Confirmed | `parsePayPalEvent` reads only `batch_header` for them |
| Item events' `resource` has `payout_batch_id`, `transaction_status` and `payout_item` (`receiver`, `sender_item_id`, `amount`) | Consistent with PayPal's payout-item details response; the webhook envelope itself was not found | `parsePayPalEvent`. If a real event differs, an item event would fall through as unmatched drift, which is loud rather than silent |
| `POST /v1/notifications/webhooks` with `url` and `event_types[].name`, https only | From memory (https-only is well known) | `PayPalWebhooks.register` |

## First run against the sandbox: what to do and what to watch

1. `pnpm e2e` with the sandbox credentials. Expect one payout and a `pending` status. A 400 here is almost certainly a body-shape mismatch from the Payouts table above; the error text is in the exception.
2. Run it again without changing anything: the retry must not create a second payout. Check the sandbox activity for exactly one.
3. `pnpm register:webhook https://<public-host>/api/webhooks/paypal`, set `PAYPAL_WEBHOOK_ID`, restart, then send a test event from the developer dashboard. A rejected signature means a `verify` mismatch.
4. `pnpm seed:invoices`, then `pnpm demo:invoices <ids>`. If the injected note does not show in the output, `toInvoiceRecord` is reading the wrong field names. That is the failure to look for first, because it would make the attack invisible rather than visible.

When something differs, fix the code, then update the fake in `packages/adapter/src/testing/fake-paypal.ts` to match what PayPal really returned so the tests keep guarding it.
