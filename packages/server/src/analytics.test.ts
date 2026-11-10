import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildServer, type Server } from "./server";

let server: Server;
beforeEach(() => {
  server = buildServer({
    databasePath: ":memory:",
    policyPath: new URL("../../../policies/default.policy.yaml", import.meta.url).pathname,
    staticDir: "/nonexistent",
    scorecardPath: "/nonexistent.json",
    port: 0,
    host: "127.0.0.1",
    authorityKey: "test-authority-key-0123456789",
    openOperator: true,
    llmDailyCalls: 300,
    rateLimitPerMinute: 0,
    trustProxy: false,
    demo: true,
  });
});
afterEach(() => server.close());

const get = async (q = "") => (await server.app.inject({ url: `/api/analytics${q}` })).json() as {
  days: number;
  currency: string;
  budgets: Record<string, number>;
  anomaly: unknown;
  daily: unknown[];
  totals: { requests: number; paid: { count: number }; blocked: { count: number; amount: number }; waiting: { count: number }; alerts: number };
  rules: { rule: string }[];
  vendors: { name: string }[];
};
const run = (scenarioId: string) => server.app.inject({ method: "POST", url: "/api/demo/run", payload: { scenarioId } });

describe("GET /api/analytics", () => {
  test("is empty but well-formed before anything happens", async () => {
    const a = await get();
    expect(a).toMatchObject({ days: 30, currency: "USD", budgets: {}, anomaly: null });
    expect(a.daily).toHaveLength(30);
    expect(a.totals.requests).toBe(0);
  });

  test("reflects what the live firewall decided", async () => {
    await run("inj-note-redirect"); // denied payee swap on the firewall side
    await run("legit-above-threshold"); // held for approval
    const a = await get("?days=7");
    expect(a.days).toBe(7);
    expect(a.daily).toHaveLength(7);
    expect(a.totals).toMatchObject({ waiting: { count: 1 }, blocked: { count: 1 }, alerts: 1 });
    expect(a.rules.map((r) => r.rule)).toEqual(expect.arrayContaining(["payee_change", "approval_threshold"]));
  });

  test("days is clamped to 1..90 and ignores junk", async () => {
    expect((await get("?days=0")).days).toBe(1);
    expect((await get("?days=9999")).days).toBe(90);
    expect((await get("?days=abc")).days).toBe(30);
  });

  test("is open to read, like the rest of the dashboard's read routes, and writes nothing", async () => {
    await run("inj-note-redirect");
    const before = (await server.app.inject({ url: "/api/audit" })).json() as { entries: unknown[] };
    await get();
    const after = (await server.app.inject({ url: "/api/audit" })).json() as { entries: unknown[] };
    expect(after.entries.length).toBe(before.entries.length);
  });
});
