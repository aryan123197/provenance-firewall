# Threat model

Provenance Firewall sits between an LLM agent and PayPal. This document says what it protects, what it assumes, how each attack is stopped (with the code and tests that show it), and what it does not protect against.

## What is protected

Money leaving a PayPal account through an agent: who is paid (payee and account), how much, and how many times.

## Trust boundaries

| Party | Trusted? | Why |
| --- | --- | --- |
| The operator and the vendor registry / purchase orders they maintain | Yes (T1) | They are configured outside the agent's reach. `Store.upsertVendor` and `addPurchaseOrder` are not exposed to the agent. |
| The user's own instruction in this session | Yes (T0) | Registered by the harness, not by the model. |
| Anything an agent reads: invoices, emails, web pages, tool output | **No (T3)** | Third parties write it. This is where prompt injection arrives. |
| The agent (LLM) itself | **No** | It may be fully compromised. The design does not depend on it behaving. |
| The firewall process, its database and its keys | Yes | If this is compromised, the guarantees are gone (see "Out of scope"). |
| PayPal | Trusted to execute and to report truthfully, verified by signature on webhooks. | |

## Core invariant

A payee, account or amount that originated in untrusted content can never authorize a payment by itself. It needs a match against a trusted record or a person's confirmation. The model never decides whether money moves.

## Attacks and mitigations

| # | Attack | How it is stopped | Where | Tested in |
| --- | --- | --- | --- | --- |
| 1 | **Prompt injection** in an invoice, email or line item tells the agent to pay an attacker | Fields carry the trust of their source. A T3 payee or account that does not exactly match a registry entry is denied. Phrasing is irrelevant because no text is interpreted at decision time. | `core/provenance`, `core/engine` (`untrusted_payee`) | `engine.test.ts`, `harness` scenarios `inj-*` |
| 2 | **Payee swap**: real vendor name, attacker's account | A registered name with a different account is denied and raises an alert, regardless of the trust level of the account. | `engine` (`payee_change`) | `engine.property.test.ts`, `swap-*` |
| 3 | **Agent launders a value** by typing it as a literal, or claims a higher trust level | Raw literals are always T3. Trust is derived from the source kind by the harness; the intent schema is strict and has no trust field. Handles of kind `literal` are rejected. | `core/intent`, `core/handles` | `provenance.test.ts` |
| 4 | **Amount inflation or surcharge** on an otherwise valid invoice | A T3 amount must match an open purchase order for that vendor within the tolerance, in the same currency. Otherwise a person decides. | `engine` (`amount_mismatch`) | property tests, `infl-*` |
| 5 | **Splitting** a large payment into many small ones | Without purchase orders each invoice needs approval. With them, per-vendor and total daily caps and per-agent velocity apply. Spend is counted in the same transaction as the decision, so parallel payments cannot both fit under a cap. | `store.decide`, `engine` | `store.test.ts`, `split-no-po`, `burst-extra-pos` |
| 6 | **Duplicate charge** from a retry, timeout or lost response | One decision per idempotency key. Execution uses a stable `PayPal-Request-Id` derived from the key, so PayPal also deduplicates. Reusing a key for different values is an error, not a replay. | `store`, `adapter/paypal` | `firewall.test.ts`, `dup-*` |
| 7 | **Re-sent invoice** paid twice under a new key | A purchase order closes when paid against, so the second invoice has no order to match and needs approval. | `store.consumePurchaseOrder` | `store.test.ts` |
| 8 | **Social pressure** ("CEO approved, skip checks") | There is no code path that reads such text. An approval only comes from the authenticated operator endpoint, and an agent cannot approve its own request. | `store.resolveApproval`, `server` | `social-*`, `firewall.test.ts` |
| 9 | **Bypassing the firewall** by calling the adapter directly | The adapter only accepts an `AllowedIntent` carrying an HMAC the firewall minted over the exact values, decision and policy hash. A forged, edited or relabelled authorization is rejected before any request. | `adapter/authority` | `adapter.test.ts` |
| 10 | **Approval abuse**: reuse, overriding a deny, approving something different | Approvals bind to one idempotency key and work once. Approving re-evaluates against current state and cannot override a deny. The authorization records who approved. | `store.resolveApproval` | `firewall.test.ts` |
| 11 | **Forged webhook** to hide or invent payments | Signatures are verified with PayPal's verification endpoint before anything changes. Events are deduplicated. | `adapter/paypal.verify`, `firewall.handleWebhook` | `firewall.test.ts` |
| 12 | **Money moved outside the firewall** (stolen credentials, a bug) | Reconciliation compares PayPal's reports with authorized decisions and opens a drift record, shown as a banner, for payments we never authorized or that differ in amount, currency or receiver. | `store.recordProviderEvent` | `firewall.test.ts` |
| 13 | **Tampering with history** | The audit log is append-only in SQL and hash-chained with an Ed25519 signature per entry. Edits, insertions and mid-log deletions fail verification, even if the SQL triggers are dropped. | `store/audit` | `audit.test.ts` |
| 14 | **Policy edits that weaken security** | The policy schema has no setting for the provenance rules, so no policy can loosen them. Unknown keys are rejected. | `core/policy` | `engine.test.ts` |
| 15 | **A bad or manipulated plain-English policy** (misread units, injected instructions in the text, a clause quietly dropped) | The compiler returns only a patch validated against a strict schema, so there is nothing to carry a provenance setting. Unsupported clauses are listed and must be acknowledged. The server recomputes the diff, lint warnings and tests itself and refuses activation if any test fails, including the author's own examples, which catch slips such as dollars compiled as cents. Activation needs the operator token, a named confirmer and the current base version, and records the English, the patch and who confirmed in the audit log. | `core/policy-edit`, `core/policy-tests`, `server` | `policy-edit.test.ts`, `policy.test.ts` (server), `llm.test.ts` |

The engine's safety claims are also checked as properties over tens of thousands of random intents (`engine.property.test.ts`), stated independently of the rule code: allow implies an exact registry match; a payee swap is always denied with an alert; an untrusted amount is allowed only against a matching order; every limit holds on allow; lowering trust never improves a verdict.

## Measured results

`pnpm harness` runs 26 scenarios against an unprotected baseline and the firewall ([reports/scorecard.md](reports/scorecard.md)). The agent in that run is a deterministic stand-in that obeys instructions found in documents, and payments go to an in-process fake of PayPal Payouts. The result measures the firewall, not any real model, and not live PayPal.

## Known limitations and non-goals

- **Registry compromise.** If an attacker can edit the vendor registry, they can register themselves. Registry edits are operator-token-only, validated, attributed to a named person and written to the signed audit log with before and after values; changing where an existing vendor is paid is flagged in the audit entry and needs an explicit confirmation in the dashboard. That makes a malicious change visible, not impossible: a stolen operator token still edits the registry. Keep the token out of the agent's reach.
- **Approval fatigue and social engineering of the operator.** The firewall shows the evidence and provenance and refuses to let approvals override hard limits, but a person who approves everything defeats the "needs approval" layer. The harness does not model a careless approver.
- **Bounded, not zero, loss under a compromised agent with real purchase orders.** In the `burst-extra-pos` scenario an agent pays two real orders that were not requested before the daily cap stops it ($800 in the committed run). Caps bound the damage; they do not prevent it.
- **Amount tolerance.** A T3 amount within the tolerance of a real order is paid as invoiced (the default is 5%).
- **Truncation of the audit log** is detectable only against a head hash recorded elsewhere. `AuditLog.verify(expectedHead)` supports this; `GET /api/status` returns the current head, but nothing publishes it externally yet.
- **Single process.** Concurrency safety relies on SQLite's single writer. Multiple server instances sharing one file are not supported.
- **Authentication.** Operator actions (approve, reject, edit the registry, activate a policy, run or reset the demo) use one bearer token. There is no user directory, so the approver name is self-reported. **Read endpoints (decisions, registry, audit, drift) are unauthenticated**, so a deployment holding real vendor data should sit behind an authenticating proxy. `OPEN_OPERATOR=1` removes the token and is for public demos on simulated or sandbox money only.
- **Simulated mode accepts no webhooks.** The simulation's signature check is a fixed value, so it is deliberately not wired in; reconciliation in the demo is driven by an operator-only route. Rate limiting is per client IP in memory and does not replace an upstream proxy or firewall.
- **Provenance depends on the harness.** The guarantee holds only if every tool result is labelled by the harness and the agent passes handles. An integration that lets raw strings through is still safe (they are untrusted) but will be blocked more often.
- **Non-USD currencies, multi-item payouts and refunds** are not supported.
- **LLM-authored policies** are a new way to make a mistake. The tests and diff catch inconsistency and unit slips, but not a reviewer who confirms without reading, and a policy that is internally consistent yet wrong for the business passes every test. The generated tests check that the compiled numbers behave as the engine should, not that they are what the operator should have wanted.
- **The live Claude agent and compiler have not been run against the live API.** They are tested against a fake client that checks request shape and handling of refusals, truncation and malformed output.

## Slack input

The optional Slack input (`packages/server/src/slack.ts`) is another way to start a demo scenario, not another way to pay. Requests are accepted only with a valid Slack signature (HMAC over the exact body, five-minute window) and are de-duplicated by event id. A message can name a scenario id and, for the live Claude agent, a request sentence; it cannot supply a payee, account or amount, and it cannot approve a held payment, so a hijacked or malicious Slack workspace member can at most run the demo scenarios the dashboard already offers. Set `SLACK_ALLOWED_USERS` to restrict who can. It is not tested against a real Slack workspace; the tests sign requests themselves and stub the Slack API.

## Out of scope

Compromise of the firewall host, its database file, `AUTHORITY_KEY` or `AUDIT_SIGNING_KEY`; compromise of the PayPal account or API credentials held by the firewall; denial of service; and attacks on PayPal itself.
