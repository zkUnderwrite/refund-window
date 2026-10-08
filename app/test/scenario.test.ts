import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/canonical.ts";
import { parseAmount } from "../src/amount.ts";
import { loadSeed, runSimulation } from "../src/sim/simulate.ts";
import { generateSeed } from "../src/seed/generate.ts";
import { ROOT, SEED_DIR, seedJson } from "./helpers.ts";
import type { Expected } from "../src/seed/types.ts";

const seed = loadSeed(SEED_DIR);
const expected = seedJson<Expected>("expected.json");
const sim = await runSimulation(seed);

test("simulate: outcome counts equal expected.json", () => {
  assert.equal(canonicalJson(sim.expected), canonicalJson(expected));
  assert.deepEqual(expected.states, { Released: 38, Refunded: 4, Resolved: 1, TimedOut: 1 });
  assert.equal(expected.refunded_outside_dispute, 3);
  assert.equal(expected.refunded_in_dispute, 1);
  assert.deepEqual(expected.rejected, { DuplicateOrder: 1, WindowClosed: 1 });
  assert.equal(expected.late_releases, 4);
  assert.equal(expected.untouched_releases, 35);
  assert.equal(expected.refund_pending, 1);
});

test("per token: payouts + refunds + fees == paid, and the contract ends empty", () => {
  for (const [code, t] of Object.entries(expected.totals)) {
    const payouts = Object.values(t.payout).reduce((a, v) => a + parseAmount(v), 0n);
    assert.equal(payouts + parseAmount(t.refunded) + parseAmount(t.fees), parseAmount(t.paid), code);
    assert.equal(t.contract_after, "0.0000000", code);
    assert.equal(sim.model.balance(code, sim.model.contract), 0n, code);
  }
});

test("express: 5 merchant claims after T and 1 buyer reclaim before T", () => {
  assert.equal(expected.express.claimed, 5);
  assert.equal(expected.express.reclaimed, 1);
  for (const b of sim.express.balances.values()) {
    assert.ok(b.claimedBy !== null);
    if (b.claimedBy === "merchant") assert.ok(b.claimedAt >= b.releaseAt);
    else assert.ok(b.claimedAt < b.releaseAt);
  }
});

test("refunds only reach refund_to; payouts only the snapshot payout; nothing else gains", () => {
  const allowed = new Set<string>([seed.psp.accounts.fee_to, sim.model.contract]);
  for (const o of sim.model.orders.values()) {
    allowed.add(o.refund_to);
    allowed.add(o.payout);
  }
  const buyersWithSeparateRefund = seed.orders.filter((o) => o.refund_to).map((o) => o.buyer_address);
  for (const [key, bal] of sim.model.balances) {
    const [, who] = key.split("|") as [string, string];
    if (bal > 0n && !allowed.has(who)) {
      // a buyer may keep tokens it never spent (it was minted exactly its orders, so none)
      assert.fail(`unexpected balance ${bal} at ${who}`);
    }
  }
  for (const b of buyersWithSeparateRefund) for (const t of ["USDC", "EURC", "PYUSD"]) assert.equal(sim.model.balance(t, b), 0n);
  assert.equal(sim.model.balance("USDC", seed.psp.accounts.arbiter), 0n);
  assert.equal(sim.model.balance("USDC", seed.psp.accounts.admin), 0n);
});

test("every dispute ends by resolve_by (time to finality <= arbiter_timeout)", () => {
  for (const o of sim.model.orders.values()) {
    if (o.dispute_used && o.state !== "Held") assert.ok(o.closed_at <= o.resolve_by, `closed ${o.closed_at} > ${o.resolve_by}`);
  }
});

test("the committed seed and Rust fixture are exactly what the generator produces", async () => {
  const g = await generateSeed({ root: ROOT, write: false });
  const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
  assert.equal(jsonl(g.orders), readFileSync(join(SEED_DIR, "orders.jsonl"), "utf8"));
  assert.equal(jsonl(g.events), readFileSync(join(SEED_DIR, "events.jsonl"), "utf8"));
  assert.equal(canonicalJson(g.expected), canonicalJson(expected));
  assert.equal(g.schedule.length, sim.schedule.length);
  const rs = readFileSync(join(ROOT, "contracts", "refund_escrow", "src", "test_seed.rs"), "utf8");
  assert.equal((rs.match(/SeedCall \{/g) ?? []).length - 1, g.schedule.length); // minus the struct definition
});

test("seed data is messy on purpose", () => {
  const amounts = seed.orders.map((o) => o.amount);
  for (const a of ["49.99", "12.5", "7.3333333", "120", "0.0000050", "1999.00"]) assert.ok(amounts.includes(a), a);
  const refs = seed.orders.map((o) => o.ref);
  assert.ok(refs.some((r) => r.startsWith("#")) && refs.some((r) => / $/.test(r)) && refs.some((r) => /^ord /.test(r)));
  assert.equal(new Set(seed.orders.map((o) => o.buyer)).size, 41);
  assert.equal(seed.orders.filter((o) => o.refund_to).length, 1);
});
