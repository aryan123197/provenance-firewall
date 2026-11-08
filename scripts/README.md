# Scripts

Run from the repository root with `pnpm <name>`. The ones that talk to PayPal need `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (sandbox only; non-sandbox hosts are refused). Behind a proxy, prefix with `NODE_USE_ENV_PROXY=1`.

| Command | What it does |
| --- | --- |
| `pnpm preflight` | Reports which variables are missing, whether the sandbox host is reachable and whether PayPal accepts the credentials. Prints no secret. |
| `pnpm sandbox:check` | Checks the whole product against the real sandbox: scopes, an injected invoice denied, one $1.00 payout, a restart-safe retry, webhooks, and whether Invoicing is enabled. Needs `PFW_DEMO_RECEIVER`. |
| `pnpm demo:live <invoice-ids>` | The whole chain with real PayPal on both ends: reads the invoices from the sandbox, runs the scripted agent behind the firewall, and sends the allowed payments as real sandbox payouts to `PFW_DEMO_RECEIVER`. The injected invoice is denied before PayPal is contacted. |
| `pnpm e2e` | The scripted payment: attack, legitimate payment, retry. The attack step runs offline. |
| `pnpm harness` | Regenerates `reports/scorecard.{md,json}` (deterministic, offline). |
| `pnpm harness:llm` | The same scenarios with a real Claude agent. Needs `ANTHROPIC_API_KEY`; paid. |
| `pnpm seed:invoices`, `pnpm demo:invoices` | Create a clean and an injected invoice in the sandbox, then read them back through both agents. Need the Invoicing feature on the app (run live); `PFW_INVOICER_EMAIL` is optional. |
| `pnpm register:webhook <https-url>` | Registers the webhook endpoint and prints `PAYPAL_WEBHOOK_ID`. |
| `pnpm gen:audit-key`, `pnpm verify:audit` | Create the audit signing key; verify an exported audit log offline. |
| `pnpm lint`, `pnpm ui:check`, `pnpm audit:deps` | The CI checks beyond the tests: Biome lint; the built dashboard in a browser for WCAG 2.1 A/AA and sideways scroll; dependency audit. See CONTRIBUTING.md. |
