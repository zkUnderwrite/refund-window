import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, digestOf } from "../src/canonical.ts";
import { appendTx, buildReceipt, receiptDigest, verifyReceipt, type OrderView } from "../src/receipt.ts";
import { orderIdHex } from "../src/orderid.ts";

const MERCHANT = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
const order: OrderView = {
  merchant: MERCHANT,
  payout: "GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR",
  buyer: "GAYTTZCP4ULHSNMYCBJ6KZGUDDGSNLUJJXPPTFWTC52DZXWEADXYVE7Y",
  refund_to: "GAYTTZCP4ULHSNMYCBJ6KZGUDDGSNLUJJXPPTFWTC52DZXWEADXYVE7Y",
  token: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  amount: 499_900_000n,
  held: 0n,
  refunded: 150_000_000n,
  refund_owed: 0n,
  released: 344_651_500n,
  fee: 5_248_500n,
  fee_bps: 150,
  arbiter: "GDPV7HBF3E4CXAZHTHSMCI2PMXBDNDTLAAQHVP4FCEHWXHAGSJXHTBSS",
  arbiter_timeout: 604_800,
  paid_at: 1_790_000_000,
  release_at: 1_791_209_600,
  disputed_at: 0,
  resolve_by: 0,
  closed_at: 1_791_210_000,
  reason: 0,
  buyer_evidence: null,
  merchant_evidence: null,
  ruling: null,
  state: "Released",
};
const ctx = {
  contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  networkPassphrase: "Test SDF Network ; September 2015",
  orderId: orderIdHex(MERCHANT, "ORD-1044"),
  asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  merchantRef: "ord 1044",
  events: [
    { type: "release", ledger: 812, tx_hash: "cc".repeat(32), amounts: { merchant_net: "34.4651500", fee: "0.5248500" } },
    { type: "pay", ledger: 100, tx_hash: "aa".repeat(32), amounts: { amount: "49.9900000" } },
    { type: "refund", ledger: 300, tx_hash: "bb".repeat(32), amounts: { amount: "15.0000000", refunded: "15.0000000" } },
  ],
};

test("canonical JSON is stable across key order and drops undefined", () => {
  const a = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined }, e: 5n };
  const b = { e: 5n, a: { d: [3, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1,"e":"5"}');
  assert.equal(digestOf(a), digestOf(b));
});

test("receipt fields: 7-decimal amounts, ISO times, events by ledger, optional fields omitted", () => {
  const { receipt, json } = buildReceipt(order, ctx);
  assert.equal(receipt.amount, "49.9900000");
  assert.equal(receipt.released, "34.4651500");
  assert.equal(receipt.paid_at, "2026-09-21T14:13:20Z");
  assert.equal(receipt.window_s, 1_209_600);
  assert.equal(receipt.merchant_ref, "ord 1044");
  assert.equal("disputed_at" in receipt, false);
  assert.equal("reason" in receipt, false);
  assert.deepEqual((receipt.events as { type: string }[]).map((e) => e.type), ["pay", "refund", "release"]);
  const keys = Object.keys(JSON.parse(json));
  assert.deepEqual(keys, [...keys].sort());
});

test("digest vector", () => {
  const { digest, receipt } = buildReceipt(order, ctx);
  assert.equal(digest, "7a5870450f42225f5afa726b308c717c53ee6d13c95787c7de74bbbf8154ab3e");
  assert.equal(receiptDigest(receipt), digest);
});

test("a merchant_ref that does not hash to the order id is refused", () => {
  assert.throws(() => buildReceipt(order, { ...ctx, merchantRef: "ORD-1045" }), /does not hash/);
});

test("--verify: MATCH against the same state, differing fields otherwise", async () => {
  const { receipt } = buildReceipt(order, ctx);
  const same = await verifyReceipt(receipt, { readOrder: async () => order, lookupTx: async () => "found" });
  assert.equal(same.status, "MATCH");
  const changed = await verifyReceipt(receipt, {
    readOrder: async () => ({ ...order, refunded: 0n, released: 492_401_500n, fee: 7_498_500n }),
    lookupTx: async () => "found",
  });
  assert.equal(changed.status, "MISMATCH");
  assert.deepEqual(changed.differences.map((d) => d.field).sort(), ["fee", "refunded", "released"]);
  assert.deepEqual(changed.differences.find((d) => d.field === "refunded"), { field: "refunded", receipt: "15.0000000", chain: "0.0000000" });
});

test("--verify: a tampered receipt fails the digest; old tx hashes are marked not re-checkable", async () => {
  const { receipt } = buildReceipt(order, ctx);
  const tampered = { ...receipt, refunded: "49.9900000" };
  const r = await verifyReceipt(tampered, { readOrder: async () => order, lookupTx: async () => "found", oldestLedger: 200 });
  assert.equal(r.digestOk, false);
  assert.equal(r.status, "MISMATCH");
  assert.equal(r.txChecks[0]!.result, "not re-checkable via RPC; use an archive provider");
  assert.equal(r.txChecks[1]!.result, "found");
  const gone = await verifyReceipt(receipt, { readOrder: async () => undefined });
  assert.equal(gone.status, "MISMATCH");
});

test("local cache appends one line per action", () => {
  process.env.REFUNDWIN_HOME = mkdtempSync(join(tmpdir(), "rw-cache-"));
  appendTx("ab", { type: "pay", tx_hash: "aa" });
  appendTx("ab", { type: "refund", tx_hash: "bb", amounts: { amount: "1.0000000" } });
  const c = JSON.parse(readFileSync(join(process.env.REFUNDWIN_HOME, "receipts", "ab.json"), "utf8"));
  assert.equal(c.txs.length, 2);
  delete process.env.REFUNDWIN_HOME;
});
