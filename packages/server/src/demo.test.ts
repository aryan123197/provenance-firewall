import { beforeEach, describe, expect, test } from "vitest";
import { buildServer, type Server } from "./server";

let server: Server;
const run = async (scenarioId: string) => {
  const r = await server.app.inject({ method: "POST", url: "/api/demo/run", payload: { scenarioId } });
  expect(r.statusCode).toBe(200);
  return r.json() as {
    baseline: { score: { unauthorizedAmount: number; unauthorizedPayouts: number }; payouts: { receiver: string }[] };
    firewalled: { score: { unauthorizedPayouts: number; denied: number; heldForApproval: number }; payouts: unknown[]; calls: { key: string; status: string; rule?: string }[]; pendingApprovals: number };
  };
};

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
    demo: true,
  });
});

describe("demo mode", () => {
  test("lists the scenarios", async () => {
    const r = (await server.app.inject({ url: "/api/demo/scenarios" })).json() as { scenarios: { id: string }[] };
    expect(r.scenarios.length).toBeGreaterThanOrEqual(20);
  });
  test("an injected invoice pays the attacker on the baseline and is denied by the live firewall", async () => {
    const out = await run("inj-note-redirect");
    expect(out.baseline.payouts.some((p) => /evil/.test(p.receiver))).toBe(true);
    expect(out.baseline.score.unauthorizedAmount).toBe(45000);
    expect(out.firewalled).toMatchObject({ payouts: [], score: { denied: 1, unauthorizedPayouts: 0 } });
    const key = out.firewalled.calls[0]!.key;
    const rec = (await server.app.inject({ url: `/api/decisions/${key}` })).json() as { decision: { rule: string; alert: boolean } };
    expect(rec.decision).toMatchObject({ rule: "payee_change", alert: true });
  });
  test("a large legitimate invoice waits in the inbox and is paid when a person approves", async () => {
    const out = await run("legit-above-threshold");
    expect(out.firewalled).toMatchObject({ payouts: [], pendingApprovals: 1 });
    const pending = (await server.app.inject({ url: "/api/approvals?status=pending" })).json() as { approvals: { id: string }[] };
    expect(pending.approvals).toHaveLength(1);
    const res = await server.app.inject({ method: "POST", url: `/api/approvals/${pending.approvals[0]!.id}/approve`, payload: { approver: "dana@company.example" } });
    expect(res.json()).toMatchObject({ status: "executed", receipt: { amount: 80000 } });
    expect((await server.app.inject({ url: "/api/status" })).json()).toMatchObject({ pendingApprovals: 0, audit: { ok: true } });
  });
  test("running scenarios repeatedly does not collide, and reset clears history", async () => {
    await run("legit-po-match");
    await run("legit-po-match");
    expect(((await server.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toHaveLength(2);
    expect((await server.app.inject({ method: "POST", url: "/api/demo/reset" })).statusCode).toBe(200);
    expect(((await server.app.inject({ url: "/api/decisions" })).json() as { decisions: unknown[] }).decisions).toHaveLength(0);
    await run("legit-po-match"); // vendors and purchase orders are seeded again
  });
  test("a demo run never overwrites the operator's registry, so an account change makes the old invoice a payee swap", async () => {
    await run("legit-po-match");
    const change = await server.app.inject({
      method: "POST",
      url: "/api/registry/vendors",
      payload: { id: "acme", name: "Acme Supplies", account: "new-account@acme.example", category: "office_supplies", changedBy: "dana@company.example" },
    });
    expect(change.json()).toMatchObject({ accountChanged: true });
    const again = await run("legit-po-match");
    expect(again.firewalled.score).toMatchObject({ denied: 1, unauthorizedPayouts: 0 });
    const vendors = ((await server.app.inject({ url: "/api/registry" })).json() as { vendors: { id: string; account: string }[] }).vendors;
    expect(vendors.find((v) => v.id === "acme")?.account).toBe("new-account@acme.example");
    const changes = ((await server.app.inject({ url: "/api/audit" })).json() as { entries: { type: string }[] }).entries.filter((e) => e.type === "vendor_changed");
    expect(changes).toHaveLength(1);
  });
  test("unknown scenarios 404", async () => {
    expect((await server.app.inject({ method: "POST", url: "/api/demo/run", payload: { scenarioId: "nope" } })).statusCode).toBe(404);
  });
  test("outside demo mode there are no demo routes", async () => {
    const plain = buildServer({ ...server.config, demo: false });
    expect((await plain.app.inject({ url: "/api/demo/scenarios" })).statusCode).toBe(404);
  });
});
