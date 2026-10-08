import { test } from "node:test";
import assert from "node:assert/strict";
import { feeFor, splitMerchantShare } from "../src/fee.ts";
import { MAX_AMOUNT } from "../src/amount.ts";
import { seedJson } from "./helpers.ts";

test("shared fee vectors (compiled into the Rust test fee_rounding_vectors)", () => {
  const vecs = seedJson<{ amount: string; fee_bps: number; fee: string }[]>("fee-vectors.json");
  assert.ok(vecs.length >= 10);
  for (const v of vecs) assert.equal(feeFor(BigInt(v.amount), v.fee_bps), BigInt(v.fee), JSON.stringify(v));
});

test("the specification's rounding cases", () => {
  assert.equal(feeFor(1n, 150), 0n);
  assert.equal(feeFor(10_000_000n, 150), 150_000n);
  assert.equal(feeFor(33_333_333n, 125), 416_666n);
  assert.equal(feeFor(50n, 150), 0n); // 0.0000050 USDC
  assert.equal(feeFor(1n, 1_000), 0n); // a split whose merchant share is 1 stroop
  assert.equal(feeFor(MAX_AMOUNT, 1_000), MAX_AMOUNT / 10n);
});

test("fee is floored and never exceeds the share", () => {
  for (let a = 0n; a < 2_000n; a += 7n) {
    const [net, fee] = splitMerchantShare(a, 150);
    assert.equal(net + fee, a);
    assert.ok(fee * 10_000n <= a * 150n);
  }
});

test("rejects fee_bps above 1000 and negative amounts", () => {
  assert.throws(() => feeFor(1n, 1_001));
  assert.throws(() => feeFor(-1n, 100));
});
