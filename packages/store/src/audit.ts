import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "@pfw/core";

export const GENESIS_HASH = "0".repeat(64);

export interface Signer {
  keyId: string;
  publicKeyPem: string;
  sign(data: Buffer): Buffer;
}

/**
 * Ed25519 signer. `privateKey` is a PKCS8 PEM, or base64 of the PKCS8 DER (handy for an env var).
 * Without one, an ephemeral key is generated; its public key is stored so old entries stay verifiable,
 * but a new process will sign with a new key.
 */
export function createSigner(privateKey?: string): Signer {
  let priv: KeyObject;
  if (privateKey) {
    priv = privateKey.includes("BEGIN")
      ? createPrivateKey(privateKey)
      : createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  } else {
    priv = generateKeyPairSync("ed25519").privateKey;
  }
  const pub = createPublicKey(priv);
  const publicKeyPem = pub.export({ type: "spki", format: "pem" }).toString();
  const keyId = createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
  return { keyId, publicKeyPem, sign: (data) => sign(null, data, priv) };
}

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
  prevHash: string;
  keyId: string;
  hash: string;
  signature: string;
}

export type AuditVerification =
  | { ok: true; count: number; head: { seq: number; hash: string } | null }
  | { ok: false; seq: number; reason: string };

export interface Row {
  seq: number;
  ts: string;
  type: string;
  payload_json: string;
  prev_hash: string;
  key_id: string;
  hash: string;
  signature: string;
}

export const auditRowToEntry = (r: Row): AuditEntry => ({
  seq: r.seq,
  ts: r.ts,
  type: r.type,
  payload: JSON.parse(r.payload_json) as unknown,
  prevHash: r.prev_hash,
  keyId: r.key_id,
  hash: r.hash,
  signature: r.signature,
});

const hashOf = (e: { seq: number; ts: string; type: string; payloadJson: string; prevHash: string; keyId: string }) =>
  createHash("sha256")
    .update(canonicalJson({ seq: e.seq, ts: e.ts, type: e.type, payload: e.payloadJson, prev: e.prevHash, key: e.keyId }))
    .digest("hex");

export class AuditLog {
  constructor(
    private readonly db: Database.Database,
    private readonly signer: Signer,
    private readonly clock: () => Date,
  ) {
    db.prepare("INSERT OR IGNORE INTO audit_keys (key_id, public_pem) VALUES (?, ?)").run(signer.keyId, signer.publicKeyPem);
  }

  /** Must run inside the caller's write transaction so the entry commits atomically with what it records. */
  append(type: string, payload: unknown): AuditEntry {
    const last = this.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const ts = this.clock().toISOString();
    const payloadJson = canonicalJson(payload);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const hash = hashOf({ seq, ts, type, payloadJson, prevHash, keyId: this.signer.keyId });
    const signature = this.signer.sign(Buffer.from(hash, "hex")).toString("base64");
    this.db
      .prepare("INSERT INTO audit_log (seq, ts, type, payload_json, prev_hash, key_id, hash, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(seq, ts, type, payloadJson, prevHash, this.signer.keyId, hash, signature);
    return { seq, ts, type, payload: JSON.parse(payloadJson) as unknown, prevHash, keyId: this.signer.keyId, hash, signature };
  }

  entries(opts: { after?: number; limit?: number } = {}): AuditEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(opts.after ?? 0, opts.limit ?? 1000) as Row[];
    return rows.map(auditRowToEntry);
  }

  head(): { seq: number; hash: string } | null {
    return (this.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined) ?? null;
  }

  /** Every entry, every signing key and the current head: all a third party needs to check the log without the server. */
  exportAll(): AuditExport {
    const rows = this.db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as Row[];
    const keys = this.db.prepare("SELECT key_id, public_pem FROM audit_keys ORDER BY key_id").all() as { key_id: string; public_pem: string }[];
    return { version: 1, entries: rows.map(auditRowToEntry), keys: keys.map((k) => ({ keyId: k.key_id, publicKeyPem: k.public_pem })), head: this.head() };
  }

  /**
   * Checks sequence, chain links, hashes and signatures. Detects edits, inserted rows and removed rows in the middle.
   * Removing the newest rows is only detectable against a head (seq + hash) recorded elsewhere, so pass `expectedHead`.
   */
  verify(expectedHead?: { seq: number; hash: string }): AuditVerification {
    return verifyAuditExport(this.exportAll(), expectedHead);
  }
}

export interface AuditExport {
  version: 1;
  entries: AuditEntry[];
  keys: { keyId: string; publicKeyPem: string }[];
  head: { seq: number; hash: string } | null;
}

/**
 * Pure check of an exported log: no database, no server. The keys come from the export itself, so this proves the entries
 * are consistent and were signed by those keys; it cannot prove those keys are the operator's. Compare a key id with one
 * published elsewhere (or the head, via `expectedHead`) to close that gap.
 */
export function verifyAuditExport(exp: AuditExport, expectedHead?: { seq: number; hash: string }): AuditVerification {
  const keys = new Map(exp.keys.map((k) => [k.keyId, createPublicKey(k.publicKeyPem)]));
  let prev = GENESIS_HASH;
  let expectSeq = 1;
  let count = 0;
  for (const r of exp.entries) {
    if (r.seq !== expectSeq) return { ok: false, seq: expectSeq, reason: "missing or out-of-order entry" };
    if (r.prevHash !== prev) return { ok: false, seq: r.seq, reason: "chain link does not match the previous entry" };
    const recomputed = hashOf({ seq: r.seq, ts: r.ts, type: r.type, payloadJson: canonicalJson(r.payload), prevHash: r.prevHash, keyId: r.keyId });
    if (recomputed !== r.hash) return { ok: false, seq: r.seq, reason: "entry contents do not match their hash" };
    const key = keys.get(r.keyId);
    if (!key || !verify(null, Buffer.from(r.hash, "hex"), key, Buffer.from(r.signature, "base64"))) {
      return { ok: false, seq: r.seq, reason: "signature is invalid" };
    }
    prev = r.hash;
    expectSeq++;
    count++;
  }
  const head = count ? { seq: expectSeq - 1, hash: prev } : null;
  const want = expectedHead ?? exp.head ?? undefined;
  if (want && (head?.seq !== want.seq || head.hash !== want.hash)) {
    return { ok: false, seq: want.seq, reason: "log head does not match the expected head (entries removed or replaced)" };
  }
  return { ok: true, count, head };
}
