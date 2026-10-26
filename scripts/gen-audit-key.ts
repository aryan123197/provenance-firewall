/** Prints a fresh Ed25519 audit-signing key as base64 PKCS8, for the AUDIT_SIGNING_KEY environment variable. */
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
console.log(privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
