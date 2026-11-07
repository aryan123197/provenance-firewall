/**
 * Checks everything a live run needs and says what is missing, without printing any secret.
 *
 *   pnpm preflight
 *
 * Exit code 0 when the PayPal sandbox is reachable and the credentials work; the Claude key is reported but optional.
 */
const base = process.env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
const env = (k: string) => (process.env[k] ?? "").trim();

type Line = { ok: boolean; label: string; hint?: string };
const lines: Line[] = [];
const add = (ok: boolean, label: string, hint?: string) => lines.push({ ok, label, ...(hint ? { hint } : {}) });

const need = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PFW_DEMO_RECEIVER"];
for (const k of need) add(Boolean(env(k)), `${k} is set`, "add it as an environment secret, then start a new session");
add(Boolean(env("ANTHROPIC_API_KEY")), "ANTHROPIC_API_KEY is set (only needed for pnpm harness:llm and the live compiler)", "optional");

// Node's built-in fetch does not use HTTPS_PROXY by itself. Where a proxy is the only way out (some sandboxes and CI runners), the lookup
// fails with ENOTFOUND even though the host is allowed, which looks exactly like a blocked host. Say which it is.
const proxyIgnored = Boolean(env("HTTPS_PROXY") || env("https_proxy")) && process.env.NODE_USE_ENV_PROXY !== "1";

let reachable = false;
try {
  const res = await fetch(`${base}/v1/oauth2/token`, { method: "POST", signal: AbortSignal.timeout(10_000) });
  reachable = true;
  add(true, `${base} is reachable (HTTP ${res.status} without credentials, as expected)`);
} catch (e) {
  add(
    false,
    `${base} is not reachable: ${(e as Error).cause ?? (e as Error).message}`,
    proxyIgnored
      ? "HTTPS_PROXY is set but Node's fetch ignores it unless NODE_USE_ENV_PROXY=1: rerun with that set (also for pnpm e2e and the other live scripts). If it still fails, allow this host in the environment's network settings"
      : "allow this host in the environment's network settings",
  );
}

if (reachable && env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET")) {
  const basic = Buffer.from(`${env("PAYPAL_CLIENT_ID")}:${env("PAYPAL_CLIENT_SECRET")}`).toString("base64");
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10_000),
  });
  add(res.ok, `PayPal accepted the client credentials (HTTP ${res.status})`, "check the client id and secret belong to a Sandbox app, not Live");
}

for (const l of lines) console.log(`${l.ok ? "ok  " : l.hint === "optional" ? "skip" : "FAIL"} ${l.label}${!l.ok && l.hint && l.hint !== "optional" ? `\n       -> ${l.hint}` : ""}`);
const required = lines.filter((l) => l.hint !== "optional");
const failed = required.filter((l) => !l.ok).length;
console.log(failed ? `\n${failed} required check(s) failed.` : "\nReady: run pnpm e2e and the checklist in docs/PAYPAL_ASSUMPTIONS.md.");
process.exit(failed ? 1 : 0);

export {};
