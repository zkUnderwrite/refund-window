import { test } from "node:test";
import assert from "node:assert/strict";
import { batches, dueReleases, dueTimeouts, pendingRefunds, runKeeperOnce, MAX_BATCH, type IndexedOrder, type KeeperExecutor } from "../src/keeper.ts";

const T = 1_790_000_000;
const o = (id: string, p: Partial<IndexedOrder> = {}): IndexedOrder => ({ id, state: "Held", held: 10n, refund_owed: 0n, release_at: T, resolve_by: 0, ...p });

test("due selection at the T boundary", () => {
  const list = [o("a"), o("b", { release_at: T + 1 })];
  assert.deepEqual(dueReleases(list, T - 1), []);
  assert.deepEqual(dueReleases(list, T), ["a"]);
  assert.deepEqual(dueReleases(list, T + 1), ["a", "b"]);
});

test("disputed, closed and empty orders are skipped; timeouts at resolve_by", () => {
  const list = [
    o("held"),
    o("disputed", { state: "Disputed", resolve_by: T + 100 }),
    o("released", { state: "Released", held: 0n }),
    o("refunded", { state: "Refunded", held: 0n, refund_owed: 5n }),
  ];
  assert.deepEqual(dueReleases(list, T + 10_000), ["held"]);
  assert.deepEqual(dueTimeouts(list, T + 99), []);
  assert.deepEqual(dueTimeouts(list, T + 100), ["disputed"]);
  assert.deepEqual(pendingRefunds(list), ["refunded"]);
});

test("batching at 25", () => {
  assert.equal(MAX_BATCH, 25);
  const ids = Array.from({ length: 61 }, (_, i) => `o${i}`);
  assert.deepEqual(batches(ids).map((b) => b.length), [25, 25, 11]);
  assert.deepEqual(batches([]), []);
  assert.throws(() => batches(ids, 0));
});

test("one pass: releases in batches, times out, retries pending refunds and survives a failure", async () => {
  const calls: string[] = [];
  let failNext = true;
  const exec: KeeperExecutor = {
    async releaseMany(ids) {
      calls.push(`release_many:${ids.length}`);
      return ids.length;
    },
    async timeoutRefund(id) {
      calls.push(`timeout:${id}`);
    },
    async settleRefund(id) {
      calls.push(`settle:${id}`);
      if (failNext) {
        failNext = false;
        throw new Error("TransferFailed");
      }
      return 5n;
    },
  };
  const list = [
    ...Array.from({ length: 30 }, (_, i) => o(`r${String(i).padStart(2, "0")}`)),
    o("d", { state: "Disputed", resolve_by: T }),
    o("p1", { state: "Refunded", held: 0n, refund_owed: 5n }),
    o("p2", { state: "Held", release_at: T + 999, refund_owed: 3n }),
  ];
  const rep = await runKeeperOnce(list, T, exec);
  assert.equal(rep.released, 30);
  assert.deepEqual(rep.batches.map((b) => b.length), [25, 5]);
  assert.deepEqual(rep.timedOut, ["d"]);
  assert.deepEqual(rep.settled, ["p2"]);
  assert.deepEqual(rep.settleFailures, [{ id: "p1", error: "TransferFailed" }]);
  assert.deepEqual(calls, ["release_many:25", "release_many:5", "timeout:d", "settle:p1", "settle:p2"]);
  const noRetry = await runKeeperOnce(list, T, exec, { retryPending: false });
  assert.deepEqual(noRetry.settled, []);
});
