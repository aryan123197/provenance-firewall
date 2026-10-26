# Provenance Firewall for Payment Agents

A policy layer between an LLM agent and PayPal that refuses any payment whose payee or amount came from untrusted content (an invoice, email, or web page). Every field of a payment intent carries a provenance tag, and deterministic rules reason about where a value came from, not only what it is.

> Status: scaffold (Oct 2026). See [SPEC.md](SPEC.md) for the full design and schedule.

## Where PayPal and the LLM are used

- **PayPal (sandbox):** Payouts to pay vendors, Invoicing as the source of the attack text, Orders/Checkout for agent purchases, and webhooks for reconciliation against the audit log. Only `packages/adapter` talks to PayPal.
- **LLM:** drives the demo procurement agent and, later, compiles plain-English policies into rules. The LLM never decides whether money moves; the decision function is pure and deterministic.

## Layout

| Package | Role |
| --- | --- |
| `packages/core` | Provenance model, intent schema, policy engine (pure, no I/O) |
| `packages/store` | SQLite: idempotency, vendor registry, purchase orders, spend counters |
| `packages/adapter` | `PaymentAdapter` interface and PayPal sandbox implementation |
| `packages/firewall` | Service that wires the above; the only path to PayPal |
| `policies/` | Versioned policy files |
| `scripts/` | End-to-end scripts |

## Develop

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm check      # typecheck + tests
```

PayPal sandbox credentials are read from the environment (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`); see `.env.example`. Never commit them.

## License

MIT
