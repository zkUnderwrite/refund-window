// Express mode: no contract. One classic CreateClaimableBalance per order with
// two claimants:
//   buyer    before_absolute_time(T)        (cancel / reclaim before T)
//   merchant not(before_absolute_time(T))   (claim at or after T)
// The buyer claimant is always the transaction source, the account that signs
// and pays. A separate refund address is refused: a classic claimant does not
// sign, so the checkout could not prove the buyer controls it.
// Semantics at exactly T and the reserve amount are verify-first item (b).

import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  getClaimableBalanceIdFromResult,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { formatAmount } from "./amount.ts";

export interface ExpressPayParams {
  /** The buyer's account (with its current sequence). */
  source: Account;
  merchant: string;
  asset: Asset;
  amount: bigint;
  /** T, unix seconds. */
  releaseAt: number;
  memoHash: string;
  networkPassphrase: string;
  /** Bounds from .env (MIN_WINDOW / MAX_WINDOW) and the current time. */
  now: number;
  minWindow: number;
  maxWindow: number;
  /** Refused whenever present and different from the buyer. */
  refundTo?: string;
  timeoutSecs?: number;
}

export class ExpressError extends Error {}

export function checkWindow(releaseAt: number, now: number, minWindow: number, maxWindow: number): void {
  const w = releaseAt - now;
  if (w < minWindow || w > maxWindow) {
    throw new ExpressError(`release time is ${w}s away; express windows must be within [${minWindow}s, ${maxWindow}s]`);
  }
}

export function expressClaimants(buyer: string, merchant: string, releaseAt: number): Claimant[] {
  const before = () => Claimant.predicateBeforeAbsoluteTime(String(releaseAt));
  return [new Claimant(buyer, before()), new Claimant(merchant, Claimant.predicateNot(before()))];
}

export function buildExpressPay(p: ExpressPayParams): Transaction {
  const buyer = p.source.accountId();
  if (p.refundTo !== undefined && p.refundTo !== buyer) {
    throw new ExpressError(
      "express mode cannot refund to a different address: a claimable-balance claimant does not sign, so it could not be proven. Use escrow mode for --refund-to",
    );
  }
  if (!StrKey.isValidEd25519PublicKey(p.merchant)) throw new ExpressError(`merchant ${p.merchant} is not a G… account`);
  if (p.merchant === buyer) throw new ExpressError("merchant and buyer must differ");
  if (p.amount <= 0n) throw new ExpressError("amount must be positive");
  if (p.asset.isNative()) throw new ExpressError("express mode is for stablecoins, not XLM");
  if (!/^[0-9a-f]{64}$/.test(p.memoHash)) throw new ExpressError("memo_hash must be 32 bytes hex");
  checkWindow(p.releaseAt, p.now, p.minWindow, p.maxWindow);
  return new TransactionBuilder(p.source, { fee: BASE_FEE, networkPassphrase: p.networkPassphrase })
    .addOperation(
      Operation.createClaimableBalance({
        asset: p.asset,
        amount: formatAmount(p.amount),
        claimants: expressClaimants(buyer, p.merchant, p.releaseAt),
      }),
    )
    .addMemo(Memo.hash(p.memoHash))
    .setTimeout(p.timeoutSecs ?? 300)
    .build();
}

function claimTx(source: Account, balanceId: string, networkPassphrase: string): Transaction {
  if (!/^[0-9a-f]{72}$/.test(balanceId)) throw new ExpressError("balance id must be 72 hex characters (type + hash)");
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(300)
    .build();
}

/** Buyer takes the balance back (succeeds only before T). */
export const buildReclaim = (balanceId: string, buyer: Account, networkPassphrase: string) => claimTx(buyer, balanceId, networkPassphrase);
/** Merchant takes the balance (succeeds only at or after T). */
export const buildClaim = (balanceId: string, merchant: Account, networkPassphrase: string) => claimTx(merchant, balanceId, networkPassphrase);

/** Balance id (72 hex) from a submitted transaction's result. */
export function balanceIdFromResult(result: xdr.TransactionResult | string, opIndex = 0): string {
  const r = typeof result === "string" ? xdr.TransactionResult.fromXDR(result, "base64") : result;
  return getClaimableBalanceIdFromResult(r, opIndex);
}

// ---------------------------------------------------------------------------
// Predicate decoding (tests, `express status`)
// ---------------------------------------------------------------------------

export type Pred =
  | { kind: "before"; t: number }
  | { kind: "not"; inner: Pred }
  | { kind: "unconditional" }
  | { kind: "other"; type: string };

export function decodePredicate(p: xdr.ClaimPredicate): Pred {
  const v = p as unknown as { type: string; absBefore?: bigint; notPredicate?: xdr.ClaimPredicate | null };
  switch (v.type) {
    case "claimPredicateBeforeAbsoluteTime":
      return { kind: "before", t: Number(v.absBefore) };
    case "claimPredicateNot":
      return { kind: "not", inner: decodePredicate(v.notPredicate!) };
    case "claimPredicateUnconditional":
      return { kind: "unconditional" };
    default:
      return { kind: "other", type: v.type };
  }
}

/** Who may claim at `closeTime` under the protocol rule (close time < T means "before T"). */
export function canClaim(p: Pred, closeTime: number): boolean {
  switch (p.kind) {
    case "before":
      return closeTime < p.t;
    case "not":
      return !canClaim(p.inner, closeTime);
    case "unconditional":
      return true;
    default:
      return false;
  }
}

export interface ExpressStatus {
  balanceId: string;
  exists: boolean;
  amount?: string;
  asset?: string;
  claimants?: { destination: string; predicate: Pred }[];
  releaseAt?: number;
  claimableBy?: "buyer" | "merchant";
}

function assetName(a: xdr.Asset): string {
  try {
    const x = Asset.fromOperation(a);
    return x.isNative() ? "XLM" : `${x.getCode()}:${x.getIssuer()}`;
  } catch {
    return "unknown";
  }
}

/** Interprets a claimable-balance ledger entry read via RPC getLedgerEntries. */
export function expressStatus(balanceId: string, entry: xdr.ClaimableBalanceEntry | undefined, now: number): ExpressStatus {
  if (!entry) return { balanceId, exists: false };
  const e = entry as unknown as {
    amount: bigint;
    asset: xdr.Asset;
    claimants: { v0: { destination: xdr.AccountId; predicate: xdr.ClaimPredicate } }[];
  };
  const claimants = e.claimants.map((c) => ({
    destination: StrKey.encodeEd25519PublicKey(
      (c.v0.destination as unknown as { ed25519: { value: Uint8Array } }).ed25519.value as Parameters<typeof StrKey.encodeEd25519PublicKey>[0],
    ),
    predicate: decodePredicate(c.v0.predicate),
  }));
  const before = claimants.find((c) => c.predicate.kind === "before");
  const releaseAt = before && before.predicate.kind === "before" ? before.predicate.t : undefined;
  return {
    balanceId,
    exists: true,
    amount: formatAmount(BigInt(e.amount)),
    asset: assetName(e.asset),
    claimants,
    ...(releaseAt !== undefined ? { releaseAt, claimableBy: now < releaseAt ? "buyer" : "merchant" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight (read through RPC by the CLI; pure here)
// ---------------------------------------------------------------------------

/** Base reserve on the public networks, in stroops (0.5 XLM). Verify-first item (b). */
export const BASE_RESERVE = 5_000_000n;

export interface Preflight {
  merchantHasTrustline: boolean;
  buyerXlm: bigint;
  buyerSubentries: number;
  buyerAssetBalance: bigint;
  amount: bigint;
  claimants?: number;
}

/**
 * A claimable balance locks one base reserve per claimant on the creator
 * (Assumption until item (b) is measured on testnet), on top of the account's
 * own minimum balance (2 + subentries) × base reserve, plus the fee.
 */
export function requiredXlm(subentries: number, claimants = 2): bigint {
  return BigInt(2 + subentries + claimants) * BASE_RESERVE + 100n;
}

export function checkPreflight(p: Preflight): string[] {
  const problems: string[] = [];
  if (!p.merchantHasTrustline) problems.push("the merchant has no trustline for this asset and could never claim");
  const need = requiredXlm(p.buyerSubentries, p.claimants ?? 2);
  if (p.buyerXlm < need) {
    problems.push(`the buyer needs at least ${formatAmount(need)} XLM for the claimable-balance reserve (has ${formatAmount(p.buyerXlm)})`);
  }
  if (p.buyerAssetBalance < p.amount) problems.push("the buyer's asset balance is below the amount");
  return problems;
}
