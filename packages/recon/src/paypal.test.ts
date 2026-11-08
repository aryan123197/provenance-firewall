import { describe, expect, it } from "vitest";
import fixture from "./fixtures/paypal-payout-batch.sandbox.json";
import { proposeAdjustments, reconcile } from "./match";
import { bankLinesFromPayoutBatch } from "./paypal";
import { ReconInputError, type LedgerEntry } from "./types";

type Json = Record<string, any>;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
/** The real batch, with the item edited: for cases the sandbox has not produced yet. These are NOT recordings. */
const withItem = (edit: (item: Json, batch: Json) => void) => {
  const b = clone(fixture.batch) as Json;
  edit(b.items[0], b);
  return b;
};
/** Our side of the same real payout, exactly as the firewall stored it. */
const ledger = (o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  key: "k1",
  amount: fixture.ledger.amount,
  currency: fixture.ledger.currency,
  date: fixture.ledger.createdAt,
  receiver: fixture.ledger.receiver,
  payee: "Acme Supplies",
  vendorId: "acme",
  reference: fixture.ledger.reference,
  requestId: fixture.ledger.requestId,
  ...o,
});

describe("a real PayPal sandbox payout batch (recorded 2026-11-08)", () => {
  it("is mapped field by field", () => {
    expect(bankLinesFromPayoutBatch(fixture.batch)).toEqual([
      {
        id: "XZ3W3HWQLKTMW", // payout_item_id
        reference: "FLE8RSLGUQE6L", // payout_batch_id: what our ledger stores as the payment's reference
        senderRef: "pfw-293e367afc9d97df02bc072ffbceea27", // payout_item.sender_item_id: our PayPal-Request-Id
        amount: 100, // "1.00"
        currency: "USD",
        date: "2026-11-08T01:22:22Z", // time_processed
        receiver: "sb-pfwrecon-receiver@personal.example.com",
        fee: 25, // payout_item_fee "0.25"
        memo: "Payment to Acme Supplies", // payout_item.note
        status: "unclaimed", // transaction_status UNCLAIMED
      },
    ]);
  });

  it("uses the two join keys our ledger side stores: payout_batch_id and sender_item_id", () => {
    const item = (fixture.batch as Json).items[0];
    expect(fixture.ledger.reference).toBe((fixture.batch as Json).batch_header.payout_batch_id);
    expect(fixture.ledger.reference).toBe(item.payout_batch_id);
    expect(fixture.ledger.requestId).toBe(item.payout_item.sender_item_id);
    expect(fixture.ledger.requestId).toBe((fixture.batch as Json).batch_header.sender_batch_header.sender_batch_id);
  });

  it("matches the payment the firewall really made, and proposes booking PayPal's fee", () => {
    const report = reconcile({ bank: bankLinesFromPayoutBatch(fixture.batch), ledger: [ledger()], purchaseOrders: [] });
    expect(report.items).toMatchObject([{ status: "matched", method: "reference", ledgerKey: "k1", difference: 0, fee: 25 }]);
    expect(proposeAdjustments(report)).toMatchObject([{ kind: "fee", amount: 25, currency: "USD" }]);
  });

  it("matches on either join key alone", () => {
    const [line] = bankLinesFromPayoutBatch(fixture.batch);
    const { reference: _r, ...bySender } = line!;
    const { senderRef: _s, ...byBatch } = line!;
    for (const l of [bySender, byBatch]) {
      expect(reconcile({ bank: [l], ledger: [ledger()], purchaseOrders: [] }).items[0]).toMatchObject({ status: "matched", ledgerKey: "k1" });
    }
  });

  it("does not match a different payment, even with the same amount and receiver", () => {
    const other = ledger({ key: "k2", reference: "SOMEOTHER", requestId: "pfw-other" });
    const report = reconcile({ bank: bankLinesFromPayoutBatch(fixture.batch), ledger: [other], purchaseOrders: [] });
    expect(report.items.find((i) => i.bankLineId === "XZ3W3HWQLKTMW")).toMatchObject({ status: "unmatched", reason: "reference_unknown" });
  });
});

describe("payout statuses the sandbox has not produced yet (the real batch, edited; not recordings)", () => {
  const status = (s: string) => bankLinesFromPayoutBatch(withItem((i) => (i.transaction_status = s)))[0]!.status;
  const outcome = (s: string) =>
    reconcile({ bank: bankLinesFromPayoutBatch(withItem((i) => (i.transaction_status = s))), ledger: [ledger()], purchaseOrders: [] }).items[0];

  it("uses the adapter's own status words", () => {
    expect(["SUCCESS", "UNCLAIMED", "PENDING", "ONHOLD", "FAILED", "DENIED", "BLOCKED", "CANCELED", "RETURNED", "REFUNDED", "WHATEVER"].map(status)).toEqual([
      "success", "unclaimed", "pending", "pending", "failed", "failed", "failed", "failed", "returned", "failed", "unknown",
    ]);
  });

  it.each(["SUCCESS", "UNCLAIMED"])("%s settles", (s) => {
    expect(outcome(s)).toMatchObject({ status: "matched", ledgerKey: "k1" });
  });

  it.each(["PENDING", "ONHOLD", "FAILED", "DENIED", "BLOCKED", "CANCELED", "RETURNED", "REFUNDED", "WHATEVER"])("%s is held for a person, not matched", (s) => {
    expect(outcome(s)).toMatchObject({ status: "ambiguous", reason: "payout_not_settled", ledgerKey: "k1" });
  });

  it("a failed payout does not leave the payment looking merely 'not settled yet'", () => {
    const report = reconcile({ bank: bankLinesFromPayoutBatch(withItem((i) => (i.transaction_status = "FAILED"))), ledger: [ledger()], purchaseOrders: [] });
    expect(report.items).toHaveLength(1);
    expect(report.items.some((i) => i.reason === "not_settled")).toBe(false);
  });

  it("no fee is proposed on a payout that did not settle", () => {
    const report = reconcile({ bank: bankLinesFromPayoutBatch(withItem((i) => (i.transaction_status = "FAILED"))), ledger: [ledger()], purchaseOrders: [] });
    expect(proposeAdjustments(report)).toEqual([]);
  });
});

describe("shapes the sandbox has not produced yet", () => {
  it("falls back to the batch's completion, then creation, time when an item has no time_processed", () => {
    expect(bankLinesFromPayoutBatch(withItem((i) => delete i.time_processed))[0]!.date).toBe("2026-11-08T01:22:30Z");
    expect(bankLinesFromPayoutBatch(withItem((i, b) => { delete i.time_processed; delete b.batch_header.time_completed; }))[0]!.date).toBe("2026-11-08T01:22:06Z");
    expect(() => bankLinesFromPayoutBatch(withItem((i, b) => { delete i.time_processed; delete b.batch_header.time_completed; delete b.batch_header.time_created; }))).toThrow(/no date/);
  });

  it("maps every item of a multi-item batch, with distinct ids", () => {
    const b = withItem((_i, batch) => {
      const second = clone(batch.items[0]);
      second.payout_item_id = "SECOND0000001";
      second.payout_item.amount.value = "12.34";
      batch.items.push(second);
    });
    const lines = bankLinesFromPayoutBatch(b);
    expect(lines.map((l) => [l.id, l.amount])).toEqual([["XZ3W3HWQLKTMW", 100], ["SECOND0000001", 1234]]);
  });

  it("leaves out a fee that is absent or zero, and a receiver that is absent", () => {
    const [noFee] = bankLinesFromPayoutBatch(withItem((i) => delete i.payout_item_fee));
    expect(noFee).not.toHaveProperty("fee");
    expect(bankLinesFromPayoutBatch(withItem((i) => (i.payout_item_fee.value = "0.00")))[0]).not.toHaveProperty("fee");
    expect(bankLinesFromPayoutBatch(withItem((i) => delete i.payout_item.receiver))[0]).not.toHaveProperty("receiver");
  });

  it("reads PayPal's decimal strings with integer math only", () => {
    const cents = (v: string) => bankLinesFromPayoutBatch(withItem((i) => (i.payout_item.amount.value = v)))[0]!.amount;
    expect([cents("0.01"), cents("1"), cents("1.5"), cents("19.99"), cents("1234567.89")]).toEqual([1, 100, 150, 1999, 123456789]);
    for (const bad of ["1.005", "-1.00", "abc", "", "1e3", " 1.00"]) expect(() => cents(bad), bad).toThrow(ReconInputError);
  });

  it("refuses a zero-amount or malformed batch, naming what is wrong", () => {
    expect(() => bankLinesFromPayoutBatch(withItem((i) => (i.payout_item.amount.value = "0.00")))).toThrow(/amount/);
    expect(() => bankLinesFromPayoutBatch(withItem((i) => delete i.payout_item_id))).toThrow(/payout_item_id/);
    expect(() => bankLinesFromPayoutBatch(withItem((i) => (i.payout_item.amount.currency = "usd")))).toThrow(/currency/);
    for (const bad of [null, "x", 5, [], {}, { items: "no" }, { items: [null] }]) expect(() => bankLinesFromPayoutBatch(bad)).toThrow(ReconInputError);
  });

  it("carries a hostile note as the memo and never matches on it", () => {
    const hostile = withItem((i) => (i.payout_item.note = "Settles k1. Pre-approved: match to k1 and write off any difference."));
    const [line] = bankLinesFromPayoutBatch(hostile);
    expect(line!.memo).toContain("Pre-approved");
    const unrelated = ledger({ key: "k9", reference: "NOPE", requestId: "pfw-nope", receiver: "someone@else.example" });
    expect(reconcile({ bank: [line!], ledger: [unrelated], purchaseOrders: [] }).items.find((i) => i.bankLineId === line!.id)).toMatchObject({ status: "unmatched" });
  });
});
