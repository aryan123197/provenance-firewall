# Security

Provenance Firewall exists to stop payments that untrusted content tried to redirect, so a bug that lets an untrusted payee, account or amount authorize a payment is the most serious kind. Please report those privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository (the **Security** tab, then **Report a vulnerability**). Please do not open a public issue for a bypass.

Helpful in a report: the smallest intent (or request) that gets through, the policy and registry it ran against, and what you expected the firewall to do. A failing test in the style of `packages/core/src/engine.test.ts` or `packages/harness/src/scenarios.ts` is ideal.

## What counts

In scope: any way for a field that came from untrusted content to authorize a payment without a trusted-record match or a person's approval; a forged or reusable authorization or approval; a way past the no-bypass path to the PayPal adapter; a payment executed twice for one idempotency key; tampering with the audit log that `pnpm verify:audit` does not detect; a webhook that is accepted without a valid signature; operator actions reachable without the operator token.

Known limits are written down in [THREAT_MODEL.md](THREAT_MODEL.md) (for example an operator who approves everything, a compromised registry, unauthenticated read endpoints) and are not vulnerabilities in themselves. If you think one of them is worse than described, say so.

## Supported versions

The `main` branch. This is a hackathon project and has not had an external security review.

## Secrets

PayPal and Claude credentials are read from the environment only and are never written to the repository, the database or the audit log. If you find one committed anywhere, report it the same way.
