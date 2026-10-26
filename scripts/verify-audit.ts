/**
 *   curl -s http://localhost:3000/api/audit/export > audit.json
 *   pnpm verify:audit audit.json [expected-head-hash]
 *
 * Verifies an exported audit log with no server and no database: sequence, hash chain, every entry's hash and its Ed25519
 * signature against the public keys in the export. Passing the head hash you recorded earlier also catches entries removed
 * from the end. Exits 0 when valid, 1 when not.
 */
import { readFileSync } from "node:fs";
import { verifyAuditExport, type AuditExport } from "@pfw/store";

const [file, headHash] = process.argv.slice(2);
if (!file) {
  console.error("Usage: pnpm verify:audit <audit-export.json> [expected-head-hash]");
  process.exit(2);
}

const exp = JSON.parse(readFileSync(file, "utf8")) as AuditExport;
const last = exp.entries.at(-1);
const result = verifyAuditExport(exp, headHash && last ? { seq: last.seq, hash: headHash } : undefined);

if (result.ok) {
  console.log(`OK: ${result.count} entries verify. Head #${result.head?.seq ?? 0} ${result.head?.hash ?? ""}`);
  console.log(`Signing keys in this export: ${exp.keys.map((k) => k.keyId).join(", ") || "none"}`);
  if (!headHash) console.log("Note: no expected head given, so removal of the newest entries would not be caught. Pass the head hash you recorded earlier.");
} else {
  console.error(`INVALID at entry #${result.seq}: ${result.reason}`);
  process.exit(1);
}
