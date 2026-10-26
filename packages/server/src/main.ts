import { buildServer, configFromEnv } from "./server";

const cfg = configFromEnv();
const server = buildServer(cfg);

if (!process.env.AUDIT_SIGNING_KEY) console.warn("AUDIT_SIGNING_KEY is not set: audit entries are signed with an ephemeral key that changes on restart.");
if (!process.env.AUTHORITY_KEY) console.warn("AUTHORITY_KEY is not set: using a random per-process key.");
if (!cfg.operatorToken && !cfg.openOperator) console.warn("No OPERATOR_TOKEN and OPEN_OPERATOR is off: approvals cannot be resolved over HTTP.");

await server.app.listen({ port: cfg.port, host: cfg.host });
console.log(`Provenance Firewall listening on http://${cfg.host}:${cfg.port} (${server.mode === "sandbox" ? "PayPal sandbox" : "simulated PayPal"}${cfg.demo ? ", demo mode" : ""})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.close().then(() => process.exit(0));
  });
}
