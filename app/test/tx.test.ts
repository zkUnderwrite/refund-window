import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, Networks, StrKey, scValToNative, xdr, Transaction, TransactionBuilder, Account, BASE_FEE, hash } from "@stellar/stellar-sdk";
import { invokeOp, payArgs, releaseManyArgs, bytes32 } from "../src/tx/args.ts";
import { describeInvocation, entrySigner, payAuthEntries, signEntry } from "../src/tx/auth.ts";
import { decodeOrder, contractErrorCode } from "../src/tx/decode.ts";

// Fixture: fixed keys and ids, no RPC.
const kp = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const buyer = kp(1);
const refundTo = kp(2);
const merchant = kp(3).publicKey();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 0xc1));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 0x70));
const P = {
  buyer: buyer.publicKey(),
  merchant,
  orderId: "5f".repeat(32),
  token: TOKEN,
  amount: 499_900_000n,
  refundTo: refundTo.publicKey(),
  window: 259_200,
  memoHash: "0d".repeat(32),
};

test("pay args: order and types", () => {
  const args = payArgs(P);
  assert.equal(args.length, 8);
  const n = args.map((a) => scValToNative(a));
  assert.equal(n[0], P.buyer);
  assert.equal(n[1], merchant);
  assert.equal(Buffer.from(n[2] as Uint8Array).toString("hex"), P.orderId);
  assert.equal(n[3], TOKEN);
  assert.equal(n[4], 499_900_000n);
  assert.equal(n[5], refundTo.publicKey());
  assert.equal(n[6], 259_200n);
  assert.equal(args[4]!.constructor.name, "ScValI128");
  assert.equal(args[6]!.constructor.name, "ScValU64");
  // None encodes as void
  const none = payArgs({ ...P, refundTo: null, window: null });
  assert.equal(none[5]!.constructor.name, "ScValVoid");
  assert.equal(none[6]!.constructor.name, "ScValVoid");
  assert.throws(() => bytes32("abc"), /32 bytes/);
});

test("two-signer refund_to: two address-credential entries with the right trees", () => {
  const a = payAuthEntries(CONTRACT, P, { buyer: 11n, refundTo: 12n });
  assert.ok(a.refundTo);
  assert.equal(entrySigner(a.buyer), buyer.publicKey());
  assert.equal(entrySigner(a.refundTo!), refundTo.publicKey());
  const b = describeInvocation(a.buyer.rootInvocation);
  assert.equal(b.contract, CONTRACT);
  assert.equal(b.fn, "pay");
  assert.equal(b.sub.length, 1);
  assert.equal(b.sub[0]!.contract, TOKEN);
  assert.equal(b.sub[0]!.fn, "transfer");
  assert.deepEqual(b.sub[0]!.args.map((x) => scValToNative(x)), [buyer.publicKey(), CONTRACT, 499_900_000n]);
  const r = describeInvocation(a.refundTo!.rootInvocation);
  assert.equal(r.fn, "pay");
  assert.equal(r.sub.length, 0, "refund_to authorises pay only, it moves no funds");
  assert.deepEqual(r.args.map((x) => x.toXDR("base64")), payArgs(P).map((x) => x.toXDR("base64")));
});

test("refund_to equal to the buyer needs a single entry", () => {
  assert.equal(payAuthEntries(CONTRACT, { ...P, refundTo: P.buyer }, { buyer: 1n }).refundTo, undefined);
  assert.equal(payAuthEntries(CONTRACT, { ...P, refundTo: null }, { buyer: 1n }).refundTo, undefined);
});

test("each wallet signs only its own entry; signatures verify against the Soroban preimage", async () => {
  const a = payAuthEntries(CONTRACT, P, { buyer: 11n, refundTo: 12n });
  const until = 5_000;
  const signed = await signEntry(a.refundTo!, refundTo, until, Networks.TESTNET);
  const creds = (signed.credentials as unknown as { address: xdr.SorobanAddressCredentials }).address;
  assert.equal(creds.signatureExpirationLedger, until);
  const sig = scValToNative(creds.signature) as { public_key: Uint8Array; signature: Uint8Array }[];
  assert.equal(sig.length, 1);
  assert.equal(StrKey.encodeEd25519PublicKey(Buffer.from(sig[0]!.public_key)), refundTo.publicKey());
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: 12n,
      signatureExpirationLedger: until,
      invocation: signed.rootInvocation,
    }),
  );
  assert.ok(refundTo.verify(hash(preimage.toXDR()), Buffer.from(sig[0]!.signature)));
  // the buyer's key cannot sign the refund_to entry
  await assert.rejects(signEntry(a.refundTo!, buyer, until, Networks.TESTNET));
});

test("invokeOp builds a host-function op that round-trips through an envelope", () => {
  const a = payAuthEntries(CONTRACT, P, { buyer: 1n, refundTo: 2n });
  const tx = new TransactionBuilder(new Account(buyer.publicKey(), "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(invokeOp(CONTRACT, "pay", payArgs(P), [a.buyer, a.refundTo!]))
    .setTimeout(30)
    .build();
  const back = new Transaction(tx.toXDR(), Networks.TESTNET);
  const op = back.operations[0] as unknown as { type: string; func: unknown; auth: xdr.SorobanAuthorizationEntry[] };
  assert.equal(op.type, "invokeHostFunction");
  assert.equal(op.auth.length, 2);
  assert.deepEqual(op.auth.map(entrySigner), [buyer.publicKey(), refundTo.publicKey()]);
  assert.equal(releaseManyArgs(["aa".repeat(32), "bb".repeat(32)])[0]!.constructor.name, "ScValVec");
  void Address;
});

test("order decoding and contract error codes", () => {
  const n = {
    merchant, payout: merchant, buyer: P.buyer, refund_to: P.refundTo, token: TOKEN,
    amount: 10n, held: 4n, refunded: 6n, refund_owed: 0n, released: 0n, fee: 0n, fee_bps: 150,
    arbiter: P.buyer, arbiter_timeout: 604_800n, paid_at: 1n, release_at: 2n, disputed_at: 0n, resolve_by: 0n, closed_at: 0n,
    dispute_used: false, reason: 0, buyer_evidence: null, merchant_evidence: Buffer.alloc(32, 1), ruling: null,
    memo_hash: Buffer.alloc(32), state: ["Held"],
  };
  const map = xdr.ScVal.scvMap(
    Object.entries(n)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => {
        let val: xdr.ScVal;
        if (v === null) val = xdr.ScVal.scvVoid();
        else if (Array.isArray(v)) val = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(v[0] as string)]);
        else if (typeof v === "string") val = Address.fromString(v).toScVal();
        else if (Buffer.isBuffer(v)) val = xdr.ScVal.scvBytes(v);
        else if (typeof v === "boolean") val = xdr.ScVal.scvBool(v);
        else if (typeof v === "number") val = xdr.ScVal.scvU32(v);
        else val = ["arbiter_timeout", "paid_at", "release_at", "disputed_at", "resolve_by", "closed_at"].includes(k)
          ? xdr.ScVal.scvU64(v as bigint)
          : (payArgs({ ...P, amount: v as bigint })[4] as xdr.ScVal);
        return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val });
      }),
  );
  const o = decodeOrder(map)!;
  assert.equal(o.state, "Held");
  assert.equal(o.held, 4n);
  assert.equal(o.refund_to, P.refundTo);
  assert.equal(o.merchant_evidence, "01".repeat(32));
  assert.equal(o.buyer_evidence, null);
  assert.equal(o.arbiter_timeout, 604_800);
  assert.equal(decodeOrder(xdr.ScVal.scvVoid()), undefined);
  assert.equal(contractErrorCode("HostError: Error(Contract, #8)"), 8);
  assert.equal(contractErrorCode("HostError: Error(Auth, InvalidAction)"), undefined);
});
