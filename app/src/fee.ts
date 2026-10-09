// PSP fee arithmetic, identical to the contract's `fee_for`:
// floor(amount * fee_bps / 10_000). Shared vectors live in
// data/seed/fee-vectors.json and are also compiled into the Rust tests.

export const BPS = 10_000n;
export const MAX_FEE_BPS = 1_000;

/** Calculates fee based on amount and basis points. */
export function feeFor(amount: bigint, feeBps: number): bigint {
  if (amount < 0n) throw new Error("amount must be non-negative");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
    throw new Error(`fee_bps must be an integer in [0, ${MAX_FEE_BPS}]`);
  }
  return (amount * BigInt(feeBps)) / BPS;
}

/** Splits a merchant share into [net to payout, fee]. */
export function splitMerchantShare(share: bigint, feeBps: number): [bigint, bigint] {
  const fee = feeFor(share, feeBps);
  return [share - fee, fee];
}
