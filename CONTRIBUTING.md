# Contributing

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm check      # typecheck (all packages and the dashboard) and every test
pnpm coverage   # the same tests with a coverage floor, which CI also enforces
pnpm build      # build the dashboard
pnpm harness    # regenerate reports/scorecard.{md,json}
```

## Rules that keep the guarantees true

- **The decision function stays pure.** `evaluate` in `packages/core` takes an intent, a policy and state, and returns a decision. No model call, clock, network or database access. Time comes in through `state.now`.
- **Provenance rules are not configurable.** The untrusted-payee, payee-change and new-payee rules live in the engine, not in the policy schema, so no policy can loosen them. Do not add a setting for them.
- **Trust is derived, never claimed.** An agent passes handles; the harness decides each value's trust from where it came from. Raw literals are untrusted. Do not add a way for an agent to state a trust level.
- **Only the adapter talks to PayPal, and only with an authorization the firewall minted.** Keep it that way.
- **Anything that changes money-moving behaviour needs a test that fails without the change**, and a safety-relevant engine change should hold under `engine.property.test.ts`. For UI controls that gate an action, break the gating on purpose and confirm a test goes red.
- **PayPal behaviour you assume goes in [docs/PAYPAL_ASSUMPTIONS.md](docs/PAYPAL_ASSUMPTIONS.md)**, marked confirmed or from memory, and the fake in `packages/adapter/src/testing/fake-paypal.ts` should be updated to match what PayPal really returns.
- **If you change a scenario, the policy, or a rule,** run `pnpm harness` and commit the regenerated report; a test fails if it is stale.

## Pull requests

Describe what changed and why, what you ran, and what you did not verify. Keep claims about real PayPal or Claude behaviour to what you have actually run. Never commit credentials; use environment variables (see `.env.example`).
