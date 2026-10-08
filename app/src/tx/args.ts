// ScVal arguments for every refund_escrow call, in the contract's parameter
// order. Shared by the CLI (RPC path), the web checkout and the offline tests.
// Nothing here talks to the network.

import { Address, Operation, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { hexToBytes } from "../ref.ts";

const HEX32 = /^[0-9a-f]{64}$/;

export const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();
export const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
export const u32 = (v: number): xdr.ScVal => nativeToScVal(v, { type: "u32" });
export const u64 = (v: number | bigint): xdr.ScVal => nativeToScVal(BigInt(v), { type: "u64" });
export const bool = (v: boolean): xdr.ScVal => xdr.ScVal.scvBool(v);
export const none = (): xdr.ScVal => xdr.ScVal.scvVoid();

export function bytes32(hex: string): xdr.ScVal {
  const h = hex.toLowerCase();
  if (!HEX32.test(h)) throw new Error(`expected 32 bytes as 64 hex characters, got "${hex}"`);
  return xdr.ScVal.scvBytes(hexToBytes(h) as Parameters<typeof xdr.ScVal.scvBytes>[0]);
}

/** Soroban `Option<T>`: `None` is void, `Some(x)` is `x` itself. */
export function option<T>(v: T | null | undefined, enc: (x: T) => xdr.ScVal): xdr.ScVal {
  return v === null || v === undefined ? none() : enc(v);
}

export interface PayParams {
  buyer: string;
  merchant: string;
  orderId: string;
  token: string;
  amount: bigint;
  refundTo?: string | null;
  window?: number | null;
  memoHash: string;
}

/** `pay(buyer, merchant, order_id, token, amount, refund_to, window, memo_hash)`. */
export function payArgs(p: PayParams): xdr.ScVal[] {
  return [
    addr(p.buyer),
    addr(p.merchant),
    bytes32(p.orderId),
    addr(p.token),
    i128(p.amount),
    option(p.refundTo, addr),
    option(p.window, u64),
    bytes32(p.memoHash),
  ];
}

export const refundArgs = (orderId: string, amount: bigint) => [bytes32(orderId), i128(amount)];
export const orderIdArgs = (orderId: string) => [bytes32(orderId)];
export const disputeArgs = (orderId: string, reason: number, evidence: string) => [bytes32(orderId), u32(reason), bytes32(evidence)];
export const respondArgs = (orderId: string, evidence: string) => [bytes32(orderId), bytes32(evidence)];
export const resolveArgs = (orderId: string, refundAmount: bigint, ruling: string) => [bytes32(orderId), i128(refundAmount), bytes32(ruling)];
export const releaseManyArgs = (ids: string[]) => [xdr.ScVal.scvVec(ids.map(bytes32))];
export const setTokenArgs = (token: string, enabled: boolean) => [addr(token), bool(enabled)];
export const addMerchantArgs = (merchant: string, payout: string, feeBps: number, window: number) => [
  addr(merchant),
  addr(payout),
  u32(feeBps),
  u64(window),
];
export const constructorArgs = (c: {
  admin: string;
  arbiter: string;
  feeTo: string;
  arbiterTimeout: number;
  minWindow: number;
  maxWindow: number;
}) => [addr(c.admin), addr(c.arbiter), addr(c.feeTo), u64(c.arbiterTimeout), u64(c.minWindow), u64(c.maxWindow)];

export function invokeOp(contractId: string, fn: string, args: xdr.ScVal[], auth: xdr.SorobanAuthorizationEntry[] = []): xdr.Operation {
  return Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth });
}
