import { describe, expect, test } from "vitest";
import { ProvenanceContext, derive, isTrusted, parseHandle, resolveIntent, tag, TRUST } from "./index";

describe("trust propagation", () => {
  const user = tag("acme", { kind: "user", ref: "user:msg1" });
  const reg = tag(100, { kind: "vendor", ref: "vendor:acme#limit" });
  const inv = tag(45000, { kind: "invoice", ref: "invoice:inv_204#total" });

  test("origin kind fixes trust", () => {
    expect(user.trust).toBe(TRUST.T0);
    expect(reg.trust).toBe(TRUST.T1);
    expect(inv.trust).toBe(TRUST.T3);
  });
  test("derived from T0/T1 only is T2 and still trusted", () => {
    const d = derive(1, [user, reg]);
    expect(d.trust).toBe(TRUST.T2);
    expect(isTrusted(d.trust)).toBe(true);
  });
  test("any T3 input makes the result T3", () => {
    const d = derive(1, [user, reg, inv]);
    expect(d.trust).toBe(TRUST.T3);
    expect(isTrusted(d.trust)).toBe(false);
  });
  test("origins are merged without duplicates", () => {
    expect(derive(1, [user, user, inv]).origins).toHaveLength(2);
  });
  test("derive needs inputs", () => {
    expect(() => derive(1, [])).toThrow();
  });
});

describe("handles", () => {
  test("parses valid handles", () => {
    expect(parseHandle("vendor:acme")).toEqual({ kind: "vendor", id: "acme" });
    expect(parseHandle("invoice:inv_204#total")).toEqual({ kind: "invoice", id: "inv_204", field: "total" });
  });
  test("rejects malformed, unknown and literal-kind handles", () => {
    for (const s of ["", "acme", "bank:x", "literal:x", "vendor:", "vendor:a b", "vendor:a#"]) {
      expect(parseHandle(s)).toBeNull();
    }
  });
});

describe("resolveIntent", () => {
  const ctx = new ProvenanceContext();
  ctx.register("vendor:acme#name", "Acme Supplies");
  ctx.register("vendor:acme#account", "acct_real");
  ctx.register("invoice:inv_204#payee", "vendor-support@evil.example");
  ctx.register("invoice:inv_204#total", 45000);
  ctx.register("po:po_7#amount", 4500);
  ctx.register("user:req1#currency", "USD");
  ctx.register("vendor:acme#category", "office_supplies");

  const base = {
    agentId: "agent-1",
    idempotencyKey: "k1",
    payee: { handle: "vendor:acme#name" },
    account: { handle: "vendor:acme#account" },
    amount: { handle: "po:po_7#amount" },
    currency: { handle: "user:req1#currency" },
    category: { handle: "vendor:acme#category" },
  };

  test("handles resolve with source-determined trust", () => {
    const r = resolveIntent(base, ctx);
    expect(r.ok && r.intent.payee.trust).toBe(TRUST.T1);
    expect(r.ok && r.intent.currency.trust).toBe(TRUST.T0);
  });
  test("invoice-sourced fields are T3 with the origin recorded", () => {
    const r = resolveIntent({ ...base, payee: { handle: "invoice:inv_204#payee" } }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.intent.payee.trust).toBe(TRUST.T3);
      expect(r.intent.payee.origins[0]?.ref).toBe("invoice:inv_204#payee");
    }
  });
  test("raw literals are untrusted even when they equal a trusted value", () => {
    const r = resolveIntent({ ...base, account: { literal: "acct_real" } }, ctx);
    expect(r.ok && r.intent.account.trust).toBe(TRUST.T3);
    expect(r.ok && r.intent.account.origins[0]?.kind).toBe("literal");
  });
  test("agent cannot claim trust: extra fields and fake handle kinds are rejected", () => {
    expect(resolveIntent({ ...base, payee: { handle: "vendor:acme#name", trust: "T0" } }, ctx).ok).toBe(false);
    expect(resolveIntent({ ...base, payee: { handle: "literal:payee" } }, ctx).ok).toBe(false);
  });
  test("unknown handles and invalid values are reported", () => {
    const r = resolveIntent(
      { ...base, payee: { handle: "vendor:ghost#name" }, amount: { literal: 12.5 }, currency: { literal: "usd" } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
  });
  test("amount must be a non-negative integer of minor units", () => {
    for (const bad of [-1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
      expect(resolveIntent({ ...base, amount: { literal: bad } }, ctx).ok).toBe(false);
    }
  });
});
