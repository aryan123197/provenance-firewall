const TWO_DECIMALS = new Set(["USD", "EUR", "GBP", "CAD", "AUD"]);

/** Integer minor units to the decimal string PayPal expects, using integer math only. */
export function formatAmount(minor: number, currency: string): string {
  if (!TWO_DECIMALS.has(currency)) throw new Error(`unsupported currency: ${currency}`);
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("amount must be a non-negative integer");
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
