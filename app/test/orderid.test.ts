import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseRef, orderIdHex } from "../src/orderid.ts";
import { seedJson } from "./helpers.ts";

interface Vec { merchant: string; ref: string; normalised: string; order_id: string }

test("shared vectors (also checked by the Rust test order_id_vectors_match_typescript)", () => {
  const vecs = seedJson<Vec[]>("orderid-vectors.json");
  assert.ok(vecs.length >= 10);
  for (const v of vecs) {
    assert.equal(normaliseRef(v.ref), v.normalised, v.ref);
    assert.equal(orderIdHex(v.merchant, v.ref), v.order_id, v.ref);
  }
});

test("formatting variants of one reference map to one id", () => {
  const m = "GABC";
  const ids = ["ord 1044", "ORD-1044", "#ORD1044", "  ORD1044 ", "Ord\t1044", "ord-10-44"].map((r) => orderIdHex(m, r));
  assert.equal(new Set(ids).size, 1);
});

test("the merchant is part of the id", () => {
  assert.notEqual(orderIdHex("GAAA", "ORD-1"), orderIdHex("GBBB", "ORD-1"));
});

test("different references stay different", () => {
  assert.notEqual(orderIdHex("GAAA", "ORD-1044"), orderIdHex("GAAA", "ORD-1045"));
  assert.notEqual(normaliseRef("#1045"), normaliseRef("ORD1045"));
});

test("an empty reference is rejected", () => {
  assert.throws(() => normaliseRef(" #- "), /empty/);
});
