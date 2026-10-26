import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildServer, type Server } from "./server";

let dir: string;
let server: Server;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pfw-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Provenance Firewall</title><div id=root></div>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')");
  writeFileSync(`${dir}-secret.txt`, "not in the static root");
  server = buildServer({
    databasePath: ":memory:",
    policyPath: new URL("../../../policies/default.policy.yaml", import.meta.url).pathname,
    staticDir: dir,
    scorecardPath: "/nonexistent.json",
    port: 0,
    host: "127.0.0.1",
    authorityKey: "test-authority-key-0123456789",
    operatorToken: "t",
    openOperator: false,
    llmDailyCalls: 1,
    rateLimitPerMinute: 0,
    trustProxy: false,
    demo: false,
    llm: null,
  });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}-secret.txt`, { force: true });
});

describe("dashboard hosting", () => {
  test("the app shell is served at the root", async () => {
    const r = await server.app.inject({ url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toContain("Provenance Firewall");
  });
  test("built assets are served with a JavaScript content type", async () => {
    const r = await server.app.inject({ url: "/assets/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/javascript/);
  });
  test("an unknown page falls back to the app shell so client-side routes survive a reload", async () => {
    const r = await server.app.inject({ url: "/decision/some-key" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("<div id=root>");
  });
  test("an unknown API path is a JSON 404, never the app shell", async () => {
    const r = await server.app.inject({ url: "/api/no-such-thing" });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "not found" });
  });
  test("paths that climb out of the static directory do not reach other files", async () => {
    const name = `${dir.split("/").pop()}-secret.txt`;
    for (const url of [`/../${name}`, `/%2e%2e/${name}`, `/assets/../../${name}`, `/..%2f${name}`]) {
      const r = await server.app.inject({ url });
      expect(r.body, url).not.toContain("not in the static root");
    }
  });
  test("API routes still win over the fallback", async () => {
    expect((await server.app.inject({ url: "/api/status" })).json()).toMatchObject({ mode: "simulated" });
  });
});

describe("without a built dashboard", () => {
  test("the API works and the root is a plain 404", async () => {
    const s = buildServer({ ...server.config, staticDir: join(dir, "does-not-exist") });
    expect((await s.app.inject({ url: "/api/status" })).statusCode).toBe(200);
    expect((await s.app.inject({ url: "/" })).statusCode).toBe(404);
  });
});
