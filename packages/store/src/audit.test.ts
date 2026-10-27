import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadPolicy, tag, type OriginKind, type ResolvedIntent } from "@pfw/core";
import { Store, createSigner, verifyAuditExport } from "./index";

const policy = loadPolicy(readFileSync(new URL("../../../policies/default.policy.yaml", import.meta.url), "utf8"));
const f = <T>(kind: OriginKind, value: T) => tag(value, { kind, ref: `${kind}:test` });
const intent = (key: string, o: Partial<ResolvedIntent> = {}): ResolvedIntent => ({
  agentId: "a1",
  idempotencyKey: key,
  payee: f("vendor", "Acme Supplies"),
  account: f("vendor", "acct_acme"),
  amount: f("user", 4500),
  currency: f("user", "USD"),
  category: f("vendor", "office_supplies"),
  ...o,
});

let store: Store;
beforeEach(() => {
  store = new Store({ clock: () => new Date("2026-10-29T12:00:00.000Z") });
  store.upsertVendor({ id: "acme", name: "Acme Supplies", account: "acct_acme", category: "office_supplies" });
});
afterEach(() => store.close());

const fill = () => {
  store.decide(intent("k1"), policy);
  store.decide(intent("k2", { account: f("invoice", "acct_evil") }), policy); // denial is logged too
  store.saveExecution("k1", { state: "executed", retryable: false, payload: { reference: "B1" } });
};
const dropTriggers = () => store.db.exec("DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;");

describe("offline verification of an export", () => {
  test("a faithful export verifies without the database, and carries the signing keys", () => {
    fill();
    const exp = store.audit.exportAll();
    expect(exp.entries).toHaveLength(3);
    expect(exp.keys).toHaveLength(1);
    expect(verifyAuditExport(JSON.parse(JSON.stringify(exp)))).toMatchObject({ ok: true, count: 3 });
  });
  test("an empty export verifies", () => expect(verifyAuditExport(store.audit.exportAll())).toEqual({ ok: true, count: 0, head: null }));
  test("editing, removing, reordering or re-signing entries in the file is caught", () => {
    fill();
    const base = JSON.parse(JSON.stringify(store.audit.exportAll())) as ReturnType<typeof store.audit.exportAll>;
    const edit = structuredClone(base);
    (edit.entries[1]!.payload as { decision: { verdict: string } }).decision.verdict = "allow";
    expect(verifyAuditExport(edit)).toMatchObject({ ok: false, seq: 2 });
    const middle = structuredClone(base);
    middle.entries.splice(1, 1);
    expect(verifyAuditExport(middle)).toMatchObject({ ok: false, seq: 2 });
    const swap = structuredClone(base);
    [swap.entries[0], swap.entries[1]] = [swap.entries[1]!, swap.entries[0]!];
    expect(verifyAuditExport(swap).ok).toBe(false);
    const wrongKey = structuredClone(base);
    wrongKey.keys = [{ keyId: wrongKey.keys[0]!.keyId, publicKeyPem: createSigner().publicKeyPem }];
    expect(verifyAuditExport(wrongKey)).toMatchObject({ ok: false, reason: "signature is invalid" });
  });
  test("dropping the newest entries is caught against a head recorded earlier, but not against the export's own head", () => {
    fill();
    const recorded = store.audit.head()!;
    const cut = JSON.parse(JSON.stringify(store.audit.exportAll())) as ReturnType<typeof store.audit.exportAll>;
    cut.entries.pop();
    cut.head = { seq: cut.entries.at(-1)!.seq, hash: cut.entries.at(-1)!.hash }; // a tamperer fixes the export's own head too
    expect(verifyAuditExport(cut).ok).toBe(true);
    expect(verifyAuditExport(cut, recorded)).toMatchObject({ ok: false });
  });
});

describe("audit log", () => {
  test("records every decision (including denials) and executions in a verifiable chain", () => {
    fill();
    const entries = store.audit.entries();
    expect(entries.map((e) => e.type)).toEqual(["decision", "decision", "execution"]);
    expect(entries[0]?.prevHash).toBe("0".repeat(64));
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect((entries[1]?.payload as { decision: { verdict: string } }).decision.verdict).toBe("deny");
    expect(store.audit.verify()).toMatchObject({ ok: true, count: 3 });
  });
  test("an empty log verifies", () => expect(store.audit.verify()).toEqual({ ok: true, count: 0, head: null }));
  test("replays and rejected key reuse add no entries", () => {
    store.decide(intent("k1"), policy);
    store.decide(intent("k1"), policy);
    expect(() => store.decide(intent("k1", { amount: f("user", 1) }), policy)).toThrow();
    expect(store.audit.entries()).toHaveLength(1);
  });
  test("a decision and its audit entry commit or roll back together", () => {
    const broken = { ...intent("kx"), amount: undefined } as unknown as ResolvedIntent;
    expect(() => store.decide(broken, policy)).toThrow();
    expect(store.audit.entries()).toHaveLength(0);
  });

  test("normal SQL cannot edit or delete entries", () => {
    fill();
    expect(() => store.db.prepare("UPDATE audit_log SET type = 'x'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
  });

  describe("tampering is detected even when the database triggers are bypassed", () => {
    beforeEach(() => {
      fill();
      dropTriggers();
    });
    test("edited payload", () => {
      store.db.prepare("UPDATE audit_log SET payload_json = replace(payload_json, 'deny', 'allow') WHERE seq = 2").run();
      expect(store.audit.verify()).toMatchObject({ ok: false, seq: 2, reason: expect.stringContaining("hash") });
    });
    test("edited execution payload is detected", () => {
      const row = store.db.prepare("SELECT * FROM audit_log WHERE seq = 3").get() as { payload_json: string };
      const forged = row.payload_json.replace("B1", "B2");
      store.db.prepare("UPDATE audit_log SET payload_json = ? WHERE seq = 3").run(forged);
      expect(store.audit.verify().ok).toBe(false);
    });
    test("removed middle entry", () => {
      store.db.prepare("DELETE FROM audit_log WHERE seq = 2").run();
      expect(store.audit.verify()).toMatchObject({ ok: false, seq: 2 });
    });
    test("swapped signature", () => {
      const sig = (store.db.prepare("SELECT signature FROM audit_log WHERE seq = 1").get() as { signature: string }).signature;
      store.db.prepare("UPDATE audit_log SET signature = ? WHERE seq = 2").run(sig);
      expect(store.audit.verify()).toMatchObject({ ok: false, seq: 2, reason: "signature is invalid" });
    });
    test("a key swapped into audit_keys cannot vouch for entries signed by another key", () => {
      const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
      const id = (store.db.prepare("SELECT key_id FROM audit_log WHERE seq = 1").get() as { key_id: string }).key_id;
      store.db.prepare("UPDATE audit_keys SET public_pem = ? WHERE key_id = ?").run(other, id);
      expect(store.audit.verify().ok).toBe(false);
    });
    test("removed newest entries are caught against a recorded head", () => {
      const head = store.audit.head()!;
      store.db.prepare("DELETE FROM audit_log WHERE seq = 3").run();
      expect(store.audit.verify().ok).toBe(true); // a bare chain cannot show truncation
      expect(store.audit.verify(head)).toMatchObject({ ok: false });
    });
  });

  test("the log stays verifiable across restarts and key changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfw-"));
    const path = join(dir, "pfw.db");
    try {
      const clock = () => new Date("2026-10-29T12:00:00.000Z");
      let s = new Store({ path, clock, signer: createSigner() });
      s.upsertVendor({ id: "acme", name: "Acme Supplies", account: "acct_acme", category: "office_supplies" });
      s.decide(intent("a"), policy);
      s.close();
      s = new Store({ path, clock, signer: createSigner() }); // new key
      s.decide(intent("b"), policy);
      const keys = new Set(s.audit.entries().map((e) => e.keyId));
      expect(keys.size).toBe(2);
      expect(s.audit.verify()).toMatchObject({ ok: true, count: 2 });
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a signer can be restored from a base64 PKCS8 key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const b64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    expect(createSigner(b64).keyId).toBe(createSigner(b64).keyId);
    expect(createSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).keyId).toBe(createSigner(b64).keyId);
  });
});

describe("incremental verification (the status-poll health check)", () => {
  test("agrees with a full verification as the log grows, first call and later ones", () => {
    expect(store.audit.verifyIncremental()).toEqual(store.audit.verify()); // empty log
    fill();
    expect(store.audit.verifyIncremental()).toEqual(store.audit.verify());
    store.decide(intent("k3"), policy);
    const inc = store.audit.verifyIncremental();
    expect(inc).toEqual(store.audit.verify());
    expect(inc).toMatchObject({ ok: true, count: store.audit.head()!.seq });
    expect(store.audit.verifyIncremental()).toEqual(inc); // nothing new
  });

  test("a new entry that was tampered with is caught without a full pass", () => {
    fill();
    store.audit.verifyIncremental();
    store.decide(intent("k3"), policy);
    dropTriggers();
    const last = store.audit.head()!.seq;
    store.db.prepare("UPDATE audit_log SET payload_json = replace(payload_json, 'allow', 'deny') WHERE seq = ?").run(last);
    expect(store.audit.verifyIncremental()).toMatchObject({ ok: false, seq: last });
  });

  test("changing the last verified entry falls back to a full pass and fails", () => {
    fill();
    expect(store.audit.verifyIncremental().ok).toBe(true);
    dropTriggers();
    store.db.prepare("UPDATE audit_log SET payload_json = replace(payload_json, 'B1', 'B2') WHERE seq = 3").run();
    expect(store.audit.verifyIncremental()).toMatchObject({ ok: false, seq: 3 });
    // And it keeps failing, rather than trusting a stale baseline.
    expect(store.audit.verifyIncremental().ok).toBe(false);
  });

  test("removing the last verified entry is not trusted either", () => {
    fill();
    store.audit.verifyIncremental();
    dropTriggers();
    store.db.prepare("DELETE FROM audit_log WHERE seq = 3").run();
    store.decide(intent("k9"), policy); // appends after a different head
    expect(store.audit.verifyIncremental().ok).toBe(true); // the log is internally consistent again...
    expect(store.audit.verify(/* ...and a full pass agrees */).ok).toBe(true);
  });

  test("an edit to an older, already verified row is only found by the full pass (documented trade-off)", () => {
    fill();
    store.audit.verifyIncremental();
    dropTriggers();
    store.db.prepare("UPDATE audit_log SET payload_json = replace(payload_json, 'deny', 'allow') WHERE seq = 2").run();
    expect(store.audit.verifyIncremental().ok).toBe(true);
    expect(store.audit.verify()).toMatchObject({ ok: false, seq: 2 });
    // The full pass resets the baseline, so the incremental check now reports it too.
    expect(store.audit.verifyIncremental().ok).toBe(false);
  });

  test("is much cheaper than a full pass on a long log", () => {
    for (let i = 0; i < 2000; i++) store.audit.append("probe", { i, note: "x".repeat(100) });
    store.audit.verifyIncremental();
    store.audit.append("probe", { i: 2000 });
    const t0 = performance.now();
    store.audit.verifyIncremental();
    const incremental = performance.now() - t0;
    const t1 = performance.now();
    store.audit.verify();
    const full = performance.now() - t1;
    expect(incremental).toBeLessThan(full / 4);
  });
});
