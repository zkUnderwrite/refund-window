import { test } from "node:test";
import assert from "node:assert/strict";
import { displayAmount, formatAmount, parseAmount, MAX_AMOUNT } from "../src/amount.ts";

test("parses the seed's messy amounts at 7 decimals", () => {
  assert.equal(parseAmount("49.99"), 499_900_000n);
  assert.equal(parseAmount("12.5"), 125_000_000n);
  assert.equal(parseAmount("7.3333333"), 73_333_333n);
  assert.equal(parseAmount("120"), 1_200_000_000n);
  assert.equal(parseAmount("0.0000050"), 50n);
  assert.equal(parseAmount("1999.00"), 19_990_000_000n);
  assert.equal(parseAmount(" 34.50 "), 345_000_000n);
  assert.equal(parseAmount("100000000"), MAX_AMOUNT);
});

test("rejects 8 decimals, negatives and junk", () => {
  assert.throws(() => parseAmount("0.00000001"), /at most 7 decimals/);
  assert.throws(() => parseAmount("-1"), /invalid amount/);
  assert.throws(() => parseAmount("1e3"), /invalid amount/);
  assert.throws(() => parseAmount("1,000.00"), /invalid amount/);
  assert.throws(() => parseAmount(""), /invalid amount/);
  assert.throws(() => parseAmount("."), /invalid amount/);
});

test("formats back with 7 decimals and a short display form", () => {
  assert.equal(formatAmount(50n), "0.0000050");
  assert.equal(formatAmount(73_333_333n), "7.3333333");
  assert.equal(displayAmount(1_200_000_000n), "120.00");
  assert.equal(displayAmount(50n), "0.000005");
  for (const s of ["49.99", "0.0000050", "7.3333333"]) assert.equal(parseAmount(formatAmount(parseAmount(s))), parseAmount(s));
});
