// Writes test/fixtures/express-result.json: a CreateClaimableBalance
// transaction envelope built with the SDK and a TransactionResult encoded by
// hand in the exact XDR layout stellar-core returns (txSUCCESS, one opINNER
// CREATE_CLAIMABLE_BALANCE_SUCCESS carrying the balance id). It is constructed
// offline, not captured from testnet; the balance id inside is the one the SDK
// derives for that envelope, so the fixture is self-consistent.
// Usage: node scripts/make-fixtures.ts
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Account, Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { buildExpressPay } from "../src/express.ts";

const kp = (label: string) => Keypair.fromRawEd25519Seed(createHash("sha256").update(`refund-window/fixture/${label}`).digest());
const buyer = kp("buyer");
const merchant = kp("merchant");
const issuer = kp("issuer");
const now = 1_790_000_000;
const releaseAt = now + 14 * 86_400;
const tx = buildExpressPay({
  source: new Account(buyer.publicKey(), "4294967296"),
  merchant: merchant.publicKey(),
  asset: new Asset("USDC", issuer.publicKey()),
  amount: 324_000_000n,
  releaseAt,
  memoHash: createHash("sha256").update("ORD1049").digest("hex"),
  networkPassphrase: Networks.TESTNET,
  now,
  minWindow: 3_600,
  maxWindow: 60 * 86_400,
  timeoutSecs: 0,
});
const balanceId = tx.getClaimableBalanceId(0); // 72 hex: 4-byte type (0) + 32-byte hash

const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(v); return b; };
const result = Buffer.concat([
  i64(100n), // feeCharged
  i32(0), // txSUCCESS
  u32(1), // one operation result
  i32(0), // opINNER
  i32(14), // CREATE_CLAIMABLE_BALANCE
  i32(0), // CREATE_CLAIMABLE_BALANCE_SUCCESS
  Buffer.from(balanceId, "hex"), // ClaimableBalanceID (type v0 + hash)
  i32(0), // ext v0
]);
const out = {
  _note: "Constructed offline (see scripts/make-fixtures.ts) in the XDR layout of a network TransactionResult; not captured from testnet.",
  buyer: buyer.publicKey(),
  merchant: merchant.publicKey(),
  release_at: releaseAt,
  envelope_xdr: tx.toXDR(),
  result_xdr: result.toString("base64"),
  balance_id: balanceId,
};
writeFileSync(new URL("../test/fixtures/express-result.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`balance id ${balanceId}`);
