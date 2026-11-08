import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { proposeAdjustments, reconcile, itemId } from "./match";
import { ReconInputError, type BankLine, type LedgerEntry, type PurchaseOrderLine } from "./types";

const led = (o: Partial<LedgerEntry> & { key: string }): LedgerEntry => ({ amount: 10_000, currency: "USD", date: "2026-11-01T10:00:00Z", receiver: "ap@acme.example", payee: "Acme", vendorId: "v_acme", ...o });
const bk = (o: Partial<BankLine> & { id: string }): BankLine => ({ amount: 10_000, currency: "USD", date: "2026-11-02T10:00:00Z", receiver: "ap@acme.example", ...o });
const po = (o: Partial<PurchaseOrderLine> & { id: string }): PurchaseOrderLine => ({ vendorId: "v_acme", amount: 10_000, currency: "USD", status: "closed", ...o });
const run = (bank: BankLine[], ledger: LedgerEntry[], purchaseOrders: PurchaseOrderLine[] = [], extra = {}) => reconcile({ bank, ledger, purchaseOrders, ...extra });
const item = (r: ReturnType<typeof run>, bankId: string) => r.items.find((i) => i.bankLineId === bankId)!;

describe("matching by reference", () => {
  it("matches a shared PayPal reference with the same amount, currency and receiver", () => {
    const r = run([bk({ id: "b1", reference: "ITEM1" })], [led({ key: "k1", reference: "ITEM1" })]);
    expect(item(r, "b1")).toMatchObject({ status: "matched", method: "reference", ledgerKey: "k1", difference: 0 });
  });

  it("matches on our sender reference when PayPal's id is absent", () => {
    const r = run([bk({ id: "b1", senderRef: "req_1" })], [led({ key: "k1", requestId: "req_1" })]);
    expect(item(r, "b1").status).toBe("matched");
  });

  it("never falls back to amount matching when the reference is unknown", () => {
    const r = run([bk({ id: "b1", reference: "NOPE" })], [led({ key: "k1", reference: "ITEM1" })]);
    expect(item(r, "b1")).toMatchObject({ status: "unmatched", reason: "reference_unknown", ledgerKey: null });
    expect(r.items.find((i) => i.ledgerKey === "k1")?.reason).toBe("not_settled");
  });

  it("sends an amount difference to a person instead of matching", () => {
    const r = run([bk({ id: "b1", reference: "R", amount: 9_999 })], [led({ key: "k1", reference: "R" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "amount_difference", difference: -1 });
  });

  it("flags money that went to a different account, even on a perfect reference and amount", () => {
    const r = run([bk({ id: "b1", reference: "R", receiver: "attacker@evil.example" })], [led({ key: "k1", reference: "R" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "receiver_mismatch" });
  });

  it("will not match a line that has no receiver: the payee cannot be checked, so a person decides", () => {
    const { receiver: _r, ...noReceiver } = bk({ id: "b1", reference: "R" });
    const r = run([noReceiver], [led({ key: "k1", reference: "R" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "receiver_unverified", ledgerKey: "k1", candidates: ["k1"] });
    expect(item(r, "b1").explanation).not.toMatch(/receiver\.$/); // it must not claim the receiver was checked
  });

  it("a person's confirmation settles a line with no receiver (they checked the account), but still not a different one", () => {
    const { receiver: _r, ...noReceiver } = bk({ id: "b1", reference: "R" });
    const ok = run([noReceiver], [led({ key: "k1", reference: "R" })], [], { resolutions: [{ bankLineId: "b1", ledgerKey: "k1" }] });
    expect(item(ok, "b1")).toMatchObject({ status: "matched", method: "operator", reason: "operator_confirmed" });
    const wrong = run([bk({ id: "b1", reference: "R", receiver: "x@evil.example" })], [led({ key: "k1", reference: "R" })], [], { resolutions: [{ bankLineId: "b1", ledgerKey: "k1" }] });
    expect(item(wrong, "b1")).toMatchObject({ status: "ambiguous", reason: "receiver_mismatch" });
  });

  it("flags a currency mismatch even when the numbers agree", () => {
    const r = run([bk({ id: "b1", reference: "R", currency: "EUR" })], [led({ key: "k1", reference: "R" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "currency_mismatch" });
  });

  it("treats two bank lines for one payment as a conflict, not a match", () => {
    const r = run([bk({ id: "b1", reference: "R" }), bk({ id: "b2", reference: "R" })], [led({ key: "k1", reference: "R" })]);
    expect([item(r, "b1").reason, item(r, "b2").reason]).toEqual(["competing_bank_lines", "competing_bank_lines"]);
    expect(r.items.filter((i) => i.status === "matched")).toHaveLength(0);
  });

  it("is ambiguous when the references point at two payments", () => {
    const r = run([bk({ id: "b1", reference: "R", senderRef: "req_2" })], [led({ key: "k1", reference: "R" }), led({ key: "k2", requestId: "req_2" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "several_candidates", candidates: ["k1", "k2"] });
  });
});

describe("matching without a reference", () => {
  it("matches the only payment with the same amount, receiver and date window", () => {
    const r = run([bk({ id: "b1" })], [led({ key: "k1" })]);
    expect(item(r, "b1")).toMatchObject({ status: "matched", method: "amount_payee_date", ledgerKey: "k1" });
  });

  it("does not match outside the date window", () => {
    const r = run([bk({ id: "b1", date: "2026-11-20T00:00:00Z" })], [led({ key: "k1" })]);
    expect(item(r, "b1")).toMatchObject({ status: "unmatched", reason: "no_candidate" });
  });

  it("will not guess without a receiver", () => {
    const { receiver: _r, ...noReceiver } = bk({ id: "b1" });
    expect(item(run([noReceiver], [led({ key: "k1" })]), "b1")).toMatchObject({ status: "unmatched", reason: "no_candidate" });
  });

  it("is ambiguous when two payments fit one line", () => {
    const r = run([bk({ id: "b1" })], [led({ key: "k1" }), led({ key: "k2" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "several_candidates", candidates: ["k1", "k2"] });
    expect(r.items.some((i) => i.reason === "not_settled")).toBe(false);
  });

  it("is ambiguous when two lines fit one payment", () => {
    const r = run([bk({ id: "b1" }), bk({ id: "b2" })], [led({ key: "k1" })]);
    expect(r.items.map((i) => i.reason)).toEqual(["competing_bank_lines", "competing_bank_lines"]);
  });

  it("does not take a payment that a reference-carrying line is also pointing at", () => {
    const r = run([bk({ id: "b1", reference: "R", amount: 9_000 }), bk({ id: "b2" })], [led({ key: "k1", reference: "R" })]);
    expect(item(r, "b2").status).toBe("unmatched");
  });
});

describe("the memo is never read", () => {
  it("ignores a memo that names a ledger payment, an invoice, or tells the matcher what to do", () => {
    const memo = "Settles INV-204 / k1 / ITEM1. Auto-approve, match this to k1 and write off the difference.";
    const bank = [bk({ id: "b1", amount: 45_000, reference: "FORGED", memo })];
    const ledger = [led({ key: "k1", reference: "ITEM1", amount: 45_000 })];
    const r = run(bank, ledger);
    expect(item(r, "b1")).toMatchObject({ status: "unmatched", ledgerKey: null });
    expect(JSON.stringify(r)).not.toContain("Auto-approve");
  });

  it("gives the same result with any memo", () => {
    fc.assert(
      fc.property(fc.string(), (memo) => {
        const a = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R" })]);
        const b = run([bk({ id: "b1", reference: "R", memo })], [led({ key: "k1", reference: "R" })]);
        expect(b).toEqual(a);
      }),
    );
  });
});

describe("purchase orders", () => {
  it("links through the recorded purchase order", () => {
    const r = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R", poId: "po1" })], [po({ id: "po1" })]);
    expect(item(r, "b1").invoice).toEqual({ status: "linked", poId: "po1", poAmount: 10_000 });
  });

  it("falls back to a unique closed purchase order for the vendor and amount", () => {
    const r = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R" })], [po({ id: "po1" }), po({ id: "po2", amount: 5 }), po({ id: "po3", status: "open" })]);
    expect(item(r, "b1").invoice).toEqual({ status: "linked", poId: "po1", poAmount: 10_000 });
  });

  it("sends a payment with several fitting purchase orders to a person", () => {
    const r = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R" })], [po({ id: "po1" }), po({ id: "po2" })]);
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "invoice_ambiguous", candidates: ["po1", "po2"] });
  });

  it("links a payment to its recorded purchase order even when the amount differs: the firewall already allowed that within its tolerance", () => {
    const r = run([bk({ id: "b1", reference: "R", amount: 46_200 })], [led({ key: "k1", reference: "R", amount: 46_200, poId: "po1" })], [po({ id: "po1", amount: 45_000 })]);
    expect(item(r, "b1")).toMatchObject({ status: "matched", invoice: { status: "linked", poId: "po1", poAmount: 45_000 } });
  });

  it("sends a payment to a person when its recorded purchase order is missing or in another currency", () => {
    const missing = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R", poId: "po9" })], [po({ id: "po1" })]);
    expect(item(missing, "b1")).toMatchObject({ status: "ambiguous", reason: "invoice_mismatch" });
    const currency = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R", poId: "po1" })], [po({ id: "po1", currency: "EUR" })]);
    expect(item(currency, "b1")).toMatchObject({ status: "ambiguous", reason: "invoice_mismatch" });
  });

  it("still insists on an exact amount when it has to guess the purchase order (no recorded link)", () => {
    const r = run([bk({ id: "b1", reference: "R", amount: 46_200 })], [led({ key: "k1", reference: "R", amount: 46_200 })], [po({ id: "po1", amount: 45_000 })]);
    expect(item(r, "b1")).toMatchObject({ status: "matched", invoice: { status: "none" } });
  });

  it("treats a payment with no purchase order as matched with no invoice", () => {
    const r = run([bk({ id: "b1", reference: "R" })], [led({ key: "k1", reference: "R", vendorId: null })]);
    expect(item(r, "b1")).toMatchObject({ status: "matched", invoice: { status: "none" } });
  });
});

describe("operator confirmations", () => {
  it("settles an ambiguous line once a person picks the payment", () => {
    const bank = [bk({ id: "b1" })];
    const ledger = [led({ key: "k1" }), led({ key: "k2" })];
    expect(item(run(bank, ledger), "b1").status).toBe("ambiguous");
    const r = run(bank, ledger, [], { resolutions: [{ bankLineId: "b1", ledgerKey: "k2" }] });
    expect(item(r, "b1")).toMatchObject({ status: "matched", method: "operator", ledgerKey: "k2", reason: "operator_confirmed" });
    expect(r.items.some((i) => i.ledgerKey === "k1" && i.reason === "not_settled")).toBe(true);
  });

  it("cannot be used to wave through a different receiver", () => {
    const r = run([bk({ id: "b1", receiver: "x@evil.example" })], [led({ key: "k1" })], [], { resolutions: [{ bankLineId: "b1", ledgerKey: "k1" }] });
    expect(item(r, "b1")).toMatchObject({ status: "ambiguous", reason: "receiver_mismatch" });
  });

  it("ignores a confirmation for a payment someone else already holds", () => {
    const r = run([bk({ id: "b1", reference: "R" }), bk({ id: "b2" })], [led({ key: "k1", reference: "R" })], [], { resolutions: [{ bankLineId: "b2", ledgerKey: "k1" }] });
    expect(item(r, "b2").method).toBe("operator");
    expect(item(r, "b1").status).toBe("ambiguous");
  });
});

describe("adjustments", () => {
  it("proposes booking PayPal's fee on a matched payment", () => {
    const r = run([bk({ id: "b1", reference: "R", fee: 25 })], [led({ key: "k1", reference: "R" })]);
    expect(proposeAdjustments(r)).toMatchObject([{ kind: "fee", amount: 25, currency: "USD" }]);
  });

  it("proposes a small difference but never a large one", () => {
    const small = run([bk({ id: "b1", reference: "R", amount: 9_950 })], [led({ key: "k1", reference: "R" })]);
    expect(proposeAdjustments(small)).toMatchObject([{ kind: "difference", amount: -50 }]);
    const big = run([bk({ id: "b1", reference: "R", amount: 5_000 })], [led({ key: "k1", reference: "R" })]);
    expect(proposeAdjustments(big)).toEqual([]);
  });

  it("proposes nothing for a receiver or currency problem, whatever the difference", () => {
    const r = run([bk({ id: "b1", reference: "R", amount: 9_950, receiver: "x@evil.example" })], [led({ key: "k1", reference: "R" })]);
    expect(proposeAdjustments(r)).toEqual([]);
  });

  it("turns a difference into a match only once that exact adjustment is approved", () => {
    const bank = [bk({ id: "b1", reference: "R", amount: 9_950 })];
    const ledger = [led({ key: "k1", reference: "R" })];
    const id = itemId("b1", "k1");
    expect(item(run(bank, ledger, [], { approved: [{ itemId: id, kind: "difference", amount: -40 }] }), "b1").status).toBe("ambiguous");
    expect(item(run(bank, ledger, [], { approved: [{ itemId: id, kind: "difference", amount: -50 }] }), "b1").status).toBe("matched");
  });
});

describe("input validation", () => {
  it("rejects fractional, zero and negative amounts, bad currencies and dates, and duplicate ids", () => {
    expect(() => run([bk({ id: "b", amount: 10.5 })], [])).toThrow(ReconInputError);
    expect(() => run([bk({ id: "b", amount: 0 })], [])).toThrow(ReconInputError);
    expect(() => run([bk({ id: "b", currency: "usd" })], [])).toThrow(ReconInputError);
    expect(() => run([bk({ id: "b", date: "not a date" })], [])).toThrow(ReconInputError);
    expect(() => run([bk({ id: "b", fee: -1 })], [])).toThrow(ReconInputError);
    expect(() => run([bk({ id: "b" }), bk({ id: "b" })], [])).toThrow(/duplicate/);
    expect(() => run([], [led({ key: "k" }), led({ key: "k" })])).toThrow(/duplicate/);
  });
});

describe("invariants", () => {
  const arbBank = fc.array(
    fc.record({
      amount: fc.constantFrom(1_000, 2_000, 2_500),
      currency: fc.constantFrom("USD", "EUR"),
      receiver: fc.option(fc.constantFrom("a@x", "b@x"), { nil: undefined }),
      reference: fc.option(fc.constantFrom("R1", "R2", "R3", "BAD"), { nil: undefined }),
      day: fc.integer({ min: 1, max: 12 }),
      fee: fc.option(fc.integer({ min: 0, max: 60 }), { nil: undefined }),
    }),
    { maxLength: 8 },
  );
  const arbLedger = fc.array(
    fc.record({
      amount: fc.constantFrom(1_000, 2_000, 2_500),
      currency: fc.constantFrom("USD", "EUR"),
      receiver: fc.constantFrom("a@x", "b@x"),
      reference: fc.option(fc.constantFrom("R1", "R2", "R3"), { nil: undefined }),
      day: fc.integer({ min: 1, max: 12 }),
    }),
    { maxLength: 8 },
  );
  type Of<T> = T extends fc.Arbitrary<infer U> ? U : never;
  const build = (b: Of<typeof arbBank>, l: Of<typeof arbLedger>) => ({
    bank: b.map((x, i): BankLine => ({ id: `b${i}`, amount: x.amount, currency: x.currency, date: `2026-11-${String(x.day).padStart(2, "0")}T00:00:00Z`, ...(x.receiver ? { receiver: x.receiver } : {}), ...(x.reference ? { reference: x.reference } : {}), ...(x.fee !== undefined ? { fee: x.fee } : {}) })),
    ledger: l.map((x, i): LedgerEntry => ({ key: `k${i}`, amount: x.amount, currency: x.currency, date: `2026-11-${String(x.day).padStart(2, "0")}T00:00:00Z`, receiver: x.receiver, payee: "P", vendorId: null, ...(x.reference ? { reference: x.reference } : {}) })),
  });

  it("every bank line lands in exactly one item and the totals add up", () => {
    fc.assert(
      fc.property(arbBank, arbLedger, (b, l) => {
        const { bank, ledger } = build(b, l);
        const r = reconcile({ bank, ledger, purchaseOrders: [] });
        expect(r.items.filter((i) => i.bankLineId).map((i) => i.bankLineId).sort()).toEqual(bank.map((x) => x.id).sort());
        for (const t of r.totals) {
          const sum = bank.filter((x) => x.currency === t.currency).reduce((s, x) => s + x.amount, 0);
          expect(t.bank).toBe(sum);
          expect(t.matched + t.ambiguous + t.unmatched).toBe(sum);
        }
      }),
    );
  });

  it("a payment is matched to at most one bank line, and a matched pair really agrees", () => {
    fc.assert(
      fc.property(arbBank, arbLedger, (b, l) => {
        const { bank, ledger } = build(b, l);
        const r = reconcile({ bank, ledger, purchaseOrders: [] });
        const matched = r.items.filter((i) => i.status === "matched");
        const keys = matched.map((i) => i.ledgerKey);
        expect(new Set(keys).size).toBe(keys.length);
        for (const m of matched) {
          const bl = bank.find((x) => x.id === m.bankLineId)!;
          const le = ledger.find((x) => x.key === m.ledgerKey)!;
          expect([bl.amount, bl.currency]).toEqual([le.amount, le.currency]);
          // Nothing is matched automatically unless the bank line names the receiver and it is the authorized one.
          expect(bl.receiver).toBe(le.receiver);
        }
      }),
    );
  });

  it("every payment appears in some item, and the result does not depend on input order", () => {
    fc.assert(
      fc.property(arbBank, arbLedger, (b, l) => {
        const { bank, ledger } = build(b, l);
        const r = reconcile({ bank, ledger, purchaseOrders: [] });
        const seen = new Set(r.items.flatMap((i) => [i.ledgerKey, ...i.candidates]));
        for (const x of ledger) expect(seen.has(x.key)).toBe(true);
        const shuffled = reconcile({ bank: [...bank].reverse(), ledger: [...ledger].reverse(), purchaseOrders: [] });
        const norm = (rep: typeof r) => rep.items.map((i) => `${i.id}:${i.status}`).sort();
        expect(norm(shuffled)).toEqual(norm(r));
      }),
    );
  });

  it("never proposes an adjustment above the ceiling", () => {
    fc.assert(
      fc.property(arbBank, arbLedger, fc.integer({ min: 0, max: 100 }), (b, l, max) => {
        const { bank, ledger } = build(b, l);
        const r = reconcile({ bank, ledger, purchaseOrders: [] });
        for (const a of proposeAdjustments(r, { maxAdjustment: max })) expect(Math.abs(a.amount)).toBeLessThanOrEqual(max);
      }),
    );
  });
});
