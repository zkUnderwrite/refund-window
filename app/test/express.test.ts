import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Asset, Keypair, Networks, xdr } from "@stellar/stellar-sdk";
import {
  balanceIdFromResult,
  buildClaim,
  buildExpressPay,
  buildReclaim,
  canClaim,
  checkPreflight,
  decodePredicate,
  expressStatus,
  requiredXlm,
} from "../src/express.ts";
import { readJson, ROOT } from "./helpers.ts";
import { join } from "node:path";

const buyer = Keypair.random();
const merchant = Keypair.random();
const issuer = Keypair.random();
const NOW = 1_790_000_000;
const T = NOW + 14 * 86_400;
const base = () => ({
  source: new Account(buyer.publicKey(), "100"),
  merchant: merchant.publicKey(),
  asset: new Asset("USDC", issuer.publicKey()),
  amount: 324_000_000n,
  releaseAt: T,
  memoHash: "ab".repeat(32),
  networkPassphrase: Networks.TESTNET,
  now: NOW,
  minWindow: 3_600,
  maxWindow: 60 * 86_400,
});

function claimantsOf(txXdr: string) {
  const env = xdr.TransactionEnvelope.fromXDR(txXdr, "base64") as unknown as {
    v1: { tx: { memo: unknown; operations: { sourceAccount: unknown; body: { type: string; createClaimableBalanceOp: { amount: bigint; claimants: { v0: { destination: { ed25519: unknown }; predicate: xdr.ClaimPredicate } }[] } } }[] } };
  };
  return env.v1.tx;
}

test("the operation has exactly two claimants with the right predicates (decoded from XDR)", () => {
  const tx = buildExpressPay(base());
  const t = claimantsOf(tx.toXDR());
  assert.equal(t.operations.length, 1);
  const op = t.operations[0]!;
  assert.equal(op.body.type, "createClaimableBalance");
  assert.equal(op.sourceAccount, null); // source = the transaction source = the buyer
  const cl = op.body.createClaimableBalanceOp.claimants;
  assert.equal(cl.length, 2);
  assert.deepEqual(decodePredicate(cl[0]!.v0.predicate), { kind: "before", t: T });
  assert.deepEqual(decodePredicate(cl[1]!.v0.predicate), { kind: "not", inner: { kind: "before", t: T } });
  assert.equal(op.body.createClaimableBalanceOp.amount, 324_000_000n);
  // decoded, friendly view: the buyer claimant is the source account
  const friendly = tx.operations[0] as unknown as { claimants: { destination: string }[] };
  assert.equal(tx.source, buyer.publicKey());
  assert.equal(friendly.claimants[0]!.destination, tx.source);
  assert.equal(friendly.claimants[1]!.destination, merchant.publicKey());
  assert.equal((tx.memo as unknown as { type: string }).type, "hash");
});

test("predicates: buyer iff close < T, merchant iff close >= T", () => {
  const b = { kind: "before", t: T } as const;
  const m = { kind: "not", inner: b } as const;
  assert.equal(canClaim(b, T - 1), true);
  assert.equal(canClaim(m, T - 1), false);
  assert.equal(canClaim(b, T), false);
  assert.equal(canClaim(m, T), true);
});

test("--refund-to is refused (a claimant cannot be proven)", () => {
  assert.throws(() => buildExpressPay({ ...base(), refundTo: Keypair.random().publicKey() }), /cannot refund to a different address/);
  // the buyer itself is fine
  assert.doesNotThrow(() => buildExpressPay({ ...base(), refundTo: buyer.publicKey() }));
});

test("a window outside bounds is refused", () => {
  assert.throws(() => buildExpressPay({ ...base(), releaseAt: NOW + 60 }), /within/);
  assert.throws(() => buildExpressPay({ ...base(), releaseAt: NOW + 61 * 86_400 }), /within/);
  assert.throws(() => buildExpressPay({ ...base(), asset: Asset.native() }), /stablecoins/);
  assert.throws(() => buildExpressPay({ ...base(), merchant: buyer.publicKey() }), /differ/);
});

test("claim and reclaim builders produce ClaimClaimableBalance for the right source", () => {
  const id = "00000000" + "7f".repeat(32);
  const r = buildReclaim(id, new Account(buyer.publicKey(), "5"), Networks.TESTNET);
  const c = buildClaim(id, new Account(merchant.publicKey(), "9"), Networks.TESTNET);
  for (const [tx, who] of [[r, buyer], [c, merchant]] as const) {
    assert.equal(tx.source, who.publicKey());
    const op = tx.operations[0] as unknown as { type: string; balanceId: string };
    assert.equal(op.type, "claimClaimableBalance");
    assert.equal(op.balanceId, id);
  }
  assert.throws(() => buildClaim("abc", new Account(merchant.publicKey(), "9"), Networks.TESTNET), /72 hex/);
});

test("balance id extraction from the result XDR fixture", () => {
  const f = readJson<{ result_xdr: string; balance_id: string; envelope_xdr: string }>(join(ROOT, "app", "test", "fixtures", "express-result.json"));
  assert.equal(balanceIdFromResult(f.result_xdr), f.balance_id);
  assert.equal(balanceIdFromResult(xdr.TransactionResult.fromXDR(f.result_xdr, "base64")), f.balance_id);
  assert.match(f.balance_id, /^00000000[0-9a-f]{64}$/);
  assert.throws(() => balanceIdFromResult(f.result_xdr, 1), /index/);
});

test("status of a claimable-balance entry", () => {
  const t = claimantsOf(buildExpressPay(base()).toXDR());
  const op = t.operations[0]!.body.createClaimableBalanceOp as unknown as { claimants: xdr.Claimant[]; asset: xdr.Asset; amount: bigint };
  const entry = { claimants: op.claimants, asset: op.asset, amount: op.amount } as unknown as xdr.ClaimableBalanceEntry;
  const s = expressStatus("00", entry, T - 10);
  assert.equal(s.exists, true);
  assert.equal(s.amount, "32.4000000");
  assert.equal(s.releaseAt, T);
  assert.equal(s.claimableBy, "buyer");
  assert.equal(s.asset, `USDC:${issuer.publicKey()}`);
  assert.equal(s.claimants![0]!.destination, buyer.publicKey());
  assert.equal(expressStatus("00", entry, T).claimableBy, "merchant");
  assert.equal(expressStatus("00", undefined, T).exists, false);
});

test("pre-flight: merchant trustline, reserve and balance", () => {
  const ok = { merchantHasTrustline: true, buyerXlm: requiredXlm(1), buyerSubentries: 1, buyerAssetBalance: 324_000_000n, amount: 324_000_000n };
  assert.deepEqual(checkPreflight(ok), []);
  assert.equal(requiredXlm(1), 25_000_100n); // (2 + 1 + 2 claimants) × 0.5 XLM + fee
  const bad = checkPreflight({ ...ok, merchantHasTrustline: false, buyerXlm: 1n, buyerAssetBalance: 0n });
  assert.equal(bad.length, 3);
});
