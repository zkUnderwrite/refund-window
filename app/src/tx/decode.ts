// Decoding contract return values (`order()`, `config()`, `merchant()`) into
// the plain shapes the receipt builder and keeper use.

import { scValToNative, type xdr } from "@stellar/stellar-sdk";
import type { OrderView } from "../receipt.ts";

const hexOrNull = (v: unknown): string | null => (v == null ? null : Buffer.from(v as Uint8Array).toString("hex"));
const num = (v: unknown): number => Number(v as bigint | number);
const big = (v: unknown): bigint => BigInt(v as bigint | number);

/** `#[contracttype] enum` unit variants decode as `["Held"]`. */
export function enumName(v: unknown): string {
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  if (typeof v === "string") return v;
  throw new Error(`cannot decode enum value ${JSON.stringify(v)}`);
}

export function orderFromNative(o: Record<string, unknown>): OrderView {
  return {
    merchant: String(o.merchant),
    payout: String(o.payout),
    buyer: String(o.buyer),
    refund_to: String(o.refund_to),
    token: String(o.token),
    amount: big(o.amount),
    held: big(o.held),
    refunded: big(o.refunded),
    refund_owed: big(o.refund_owed),
    released: big(o.released),
    fee: big(o.fee),
    fee_bps: num(o.fee_bps),
    arbiter: String(o.arbiter),
    arbiter_timeout: num(o.arbiter_timeout),
    paid_at: num(o.paid_at),
    release_at: num(o.release_at),
    disputed_at: num(o.disputed_at),
    resolve_by: num(o.resolve_by),
    closed_at: num(o.closed_at),
    reason: num(o.reason),
    buyer_evidence: hexOrNull(o.buyer_evidence),
    merchant_evidence: hexOrNull(o.merchant_evidence),
    ruling: hexOrNull(o.ruling),
    state: enumName(o.state),
  };
}

/** `Option<Order>`: void is `undefined`. */
export function decodeOrder(v: xdr.ScVal): OrderView | undefined {
  const n = scValToNative(v) as Record<string, unknown> | null | undefined;
  return n == null ? undefined : orderFromNative(n);
}

/** Maps `Error(Contract, #8)` in a simulation or result string to the code. */
export function contractErrorCode(message: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m ? Number(m[1]) : undefined;
}
