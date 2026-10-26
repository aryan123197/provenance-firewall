import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildServer, configFromEnv, type ServerConfig } from "./server";

const policyPath = new URL("../../../policies/default.policy.yaml", import.meta.url).pathname;
const base = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  databasePath: ":memory:",
  policyPath,
  staticDir: "/nonexistent",
  scorecardPath: "/nonexistent.json",
  port: 0,
  host: "127.0.0.1",
  authorityKey: "test-authority-key-0123456789",
  openOperator: false,
  llmDailyCalls: 300,
  rateLimitPerMinute: 0,
  trustProxy: false,
  demo: false,
  llm: null,
  ...o,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pfw-cfg-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("configFromEnv", () => {
  test("safe defaults: nothing open, no PayPal, no demo, sensible limits", () => {
    const c = configFromEnv({});
    expect(c).toMatchObject({ port: 3000, host: "0.0.0.0", openOperator: false, demo: false, trustProxy: false, llmDailyCalls: 300, rateLimitPerMinute: 240 });
    expect(c.paypal).toBeUndefined();
    expect(c.operatorToken).toBeUndefined();
    expect(c.authorityKey.length).toBeGreaterThanOrEqual(32); // random per process when not set
    expect(configFromEnv({}).authorityKey).not.toBe(c.authorityKey);
  });
  test("only the literal 1 turns on the risky switches", () => {
    for (const v of ["true", "yes", "0", ""]) {
      const c = configFromEnv({ OPEN_OPERATOR: v, DEMO_MODE: v, TRUST_PROXY: v });
      expect([c.openOperator, c.demo, c.trustProxy], v).toEqual([false, false, false]);
    }
    expect(configFromEnv({ OPEN_OPERATOR: "1", DEMO_MODE: "1", TRUST_PROXY: "1" })).toMatchObject({ openOperator: true, demo: true, trustProxy: true });
  });
  test("PayPal credentials need both halves; the webhook id is optional", () => {
    expect(configFromEnv({ PAYPAL_CLIENT_ID: "a" }).paypal).toBeUndefined();
    expect(configFromEnv({ PAYPAL_CLIENT_SECRET: "b" }).paypal).toBeUndefined();
    expect(configFromEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" }).paypal).toEqual({ clientId: "a", clientSecret: "b" });
    expect(configFromEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_WEBHOOK_ID: "W" }).paypal).toEqual({ clientId: "a", clientSecret: "b", webhookId: "W" });
  });
  test("numbers, tokens and keys are read, and an empty token counts as unset", () => {
    expect(configFromEnv({ PORT: "8080", LLM_DAILY_CALLS: "5", RATE_LIMIT_PER_MIN: "0", OPERATOR_TOKEN: "tok", AUDIT_SIGNING_KEY: "k", AUTHORITY_KEY: "fixed", REGISTRY_PATH: "/r.json" })).toMatchObject({
      port: 8080, llmDailyCalls: 5, rateLimitPerMinute: 0, operatorToken: "tok", auditKey: "k", authorityKey: "fixed", registryPath: "/r.json",
    });
    expect(configFromEnv({ OPERATOR_TOKEN: "" }).operatorToken).toBeUndefined();
  });
});

describe("buildServer wiring", () => {
  test("no PayPal credentials means simulated, and the status says so", async () => {
    const s = buildServer(base());
    expect(s.mode).toBe("simulated");
    expect((await s.app.inject({ url: "/api/status" })).json()).toMatchObject({ mode: "simulated" });
  });
  test("PayPal credentials mean sandbox, without any network call at startup", async () => {
    const s = buildServer(base({ paypal: { clientId: "id", clientSecret: "secret" } }));
    expect(s.mode).toBe("sandbox");
    expect((await s.app.inject({ url: "/api/status" })).json()).toMatchObject({ mode: "sandbox" });
  });
  test("sandbox mode with no webhook id refuses every webhook; with one it checks the signature headers first", async () => {
    const without = buildServer(base({ paypal: { clientId: "id", clientSecret: "secret" } }));
    expect((await without.app.inject({ method: "POST", url: "/api/webhooks/paypal", headers: { "content-type": "application/json" }, payload: "{}" })).json()).toMatchObject({ status: "rejected", reason: "no webhook verifier configured" });
    const withId = buildServer(base({ paypal: { clientId: "id", clientSecret: "secret", webhookId: "WH-1" } }));
    // No signature headers: rejected locally, before anything is sent to PayPal.
    expect((await withId.app.inject({ method: "POST", url: "/api/webhooks/paypal", headers: { "content-type": "application/json" }, payload: "{}" })).json()).toMatchObject({ status: "rejected", reason: "invalid signature" });
  });
  test("a non-sandbox PayPal host cannot be configured through the server", () => {
    // The adapter refuses it; the server uses the sandbox host by default, so this documents that there is no override.
    const s = buildServer(base({ paypal: { clientId: "id", clientSecret: "secret" } }));
    expect(s.mode).toBe("sandbox");
  });

  test("the registry file is loaded at start: vendors and purchase orders, and loading twice is harmless", async () => {
    const d = tmp();
    const registryPath = join(d, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ vendors: [{ id: "acme", name: "Acme Supplies", account: "acme@sandbox.example", category: "office_supplies" }], purchaseOrders: [{ id: "po1", vendorId: "acme", amount: 4500, currency: "USD" }] }));
    const databasePath = join(d, "pfw.db");
    for (let start = 0; start < 2; start++) {
      const s = buildServer(base({ databasePath, registryPath }));
      const reg = (await s.app.inject({ url: "/api/registry" })).json() as { vendors: { id: string }[]; purchaseOrders: { id: string }[] };
      expect(reg.vendors.map((v) => v.id)).toEqual(["acme"]);
      expect(reg.purchaseOrders.map((p) => p.id)).toEqual(["po1"]);
      await s.close();
    }
  });
  test("a missing registry file is not an error", async () => {
    const s = buildServer(base({ registryPath: join(tmp(), "nope.json") }));
    expect(((await s.app.inject({ url: "/api/registry" })).json() as { vendors: unknown[] }).vendors).toEqual([]);
  });

  test("a file database keeps its data across restarts, and the audit chain still verifies", async () => {
    const databasePath = join(tmp(), "nested", "pfw.db"); // the directory is created
    const first = buildServer(base({ databasePath, operatorToken: "t" }));
    await first.app.inject({ method: "POST", url: "/api/registry/vendors", headers: { authorization: "Bearer t" }, payload: { id: "beta", name: "Beta Software", account: "beta@sandbox.example", category: "software", changedBy: "dana" } });
    await first.close();
    const second = buildServer(base({ databasePath }));
    expect(((await second.app.inject({ url: "/api/registry" })).json() as { vendors: { id: string }[] }).vendors.map((v) => v.id)).toEqual(["beta"]);
    expect((await second.app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true, count: 1 });
    await second.close();
  });
  test("the demo reset deletes the database files and starts clean", async () => {
    const databasePath = join(tmp(), "pfw.db");
    const s = buildServer(base({ databasePath, demo: true, openOperator: true }));
    await s.app.inject({ method: "POST", url: "/api/demo/run", payload: { scenarioId: "legit-po-match" } });
    expect(existsSync(databasePath)).toBe(true);
    expect((await s.app.inject({ method: "POST", url: "/api/demo/reset" })).statusCode).toBe(200);
    expect(((await s.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toEqual([]);
    expect((await s.app.inject({ url: "/api/audit/verify" })).json()).toMatchObject({ ok: true, count: 0 });
    await s.close();
  });
  test("a stable audit key gives the same key id across restarts", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const auditKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    const databasePath = join(tmp(), "pfw.db");
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const s = buildServer(base({ databasePath, auditKey, operatorToken: "t" }));
      await s.app.inject({ method: "POST", url: "/api/registry/vendors", headers: { authorization: "Bearer t" }, payload: { id: `v${i}-co`, name: `Vendor ${i}`, account: `v${i}@x.example`, category: "software", changedBy: "d" } });
      ids.push(...((await s.app.inject({ url: "/api/audit/export" })).json() as { keys: { keyId: string }[] }).keys.map((k) => k.keyId));
      await s.close();
    }
    expect(new Set(ids).size).toBe(1);
  });
});
