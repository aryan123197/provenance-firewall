import { mapPayPalStatus, parseMinorUnits } from "@pfw/adapter";
import { ReconInputError, type BankLine } from "./types";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x !== "" ? x : undefined);

/**
 * Turns PayPal's payout batch details (`GET /v1/payments/payouts/{payout_batch_id}`) into settlement lines, one per item.
 *
 * The field names are the ones PayPal's sandbox actually returned (a recorded response is a test fixture), not guesses:
 *   id         payout_item_id
 *   reference  the item's payout_batch_id: what the firewall stores as the payment's reference
 *   senderRef  payout_item.sender_item_id: the PayPal-Request-Id the adapter sent, stored as the payment's requestId
 *   amount     payout_item.amount.value ("1.00", decimal text), read with integer math
 *   fee        payout_item_fee.value
 *   date       time_processed, else the batch's time_completed, else time_created
 *   receiver   payout_item.receiver
 *   memo       payout_item.note (free text: shown to a person, never matched on)
 *   status     transaction_status, in the adapter's words; only success and unclaimed settle
 * What it has not seen yet (a SUCCESS item for a registered receiver, PENDING items, pagination of large batches) is
 * written down in docs/PAYPAL_ASSUMPTIONS.md. Anything malformed throws, naming the item, rather than being guessed at.
 */
export function bankLinesFromPayoutBatch(raw: unknown): BankLine[] {
  if (!isObj(raw)) throw new ReconInputError("a payout batch must be an object (PayPal's payout batch details)");
  if (!Array.isArray(raw.items)) throw new ReconInputError("the payout batch has no items array");
  const header = isObj(raw.batch_header) ? raw.batch_header : {};

  return raw.items.map((item: unknown, n: number): BankLine => {
    if (!isObj(item)) throw new ReconInputError(`item ${n} of the payout batch is not an object`);
    const id = str(item.payout_item_id);
    if (!id) throw new ReconInputError(`item ${n} of the payout batch has no payout_item_id`);
    const sent = isObj(item.payout_item) ? item.payout_item : {};
    const amount = isObj(sent.amount) ? sent.amount : {};
    const cents = parseMinorUnits(amount.value);
    if (cents === undefined || cents <= 0) throw new ReconInputError(`item ${id}: the amount ${JSON.stringify(amount.value)} is not a positive decimal with at most two places`);
    const currency = str(amount.currency);
    if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new ReconInputError(`item ${id}: the currency ${JSON.stringify(amount.currency)} is not a 3-letter code`);
    const date = str(item.time_processed) ?? str(header.time_completed) ?? str(header.time_created);
    if (!date) throw new ReconInputError(`item ${id} has no date (no time_processed, and the batch has no time_completed or time_created)`);

    const fee = isObj(item.payout_item_fee) ? parseMinorUnits(item.payout_item_fee.value) : undefined;
    if (isObj(item.payout_item_fee) && fee === undefined) throw new ReconInputError(`item ${id}: the fee ${JSON.stringify(item.payout_item_fee.value)} is not a decimal with at most two places`);

    const reference = str(item.payout_batch_id) ?? str(header.payout_batch_id);
    const senderRef = str(sent.sender_item_id);
    const receiver = str(sent.receiver);
    const memo = str(sent.note);
    return {
      id,
      ...(reference ? { reference } : {}),
      ...(senderRef ? { senderRef } : {}),
      amount: cents,
      currency,
      date,
      ...(receiver ? { receiver } : {}),
      ...(fee ? { fee } : {}),
      ...(memo ? { memo: memo.slice(0, 1000) } : {}),
      status: mapPayPalStatus(str(item.transaction_status)),
    };
  });
}
