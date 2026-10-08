// The PSP keeper: releases due orders in batches, triggers timeout refunds for
// silent arbiters and retries pending refunds. It is a convenience only: every
// call it makes is open to anyone. Selection is pure and unit-tested; the
// executor is either the offline model or the RPC client.

export const MAX_BATCH = 25;

export interface IndexedOrder {
  id: string;
  state: string;
  held: bigint;
  refund_owed: bigint;
  release_at: number;
  resolve_by: number;
}

/** Held orders with funds, at or past release_at, oldest deadline first. */
export function dueReleases(orders: IndexedOrder[], now: number): string[] {
  return orders
    .filter((o) => o.state === "Held" && o.held > 0n && now >= o.release_at)
    .sort((a, b) => a.release_at - b.release_at || a.id.localeCompare(b.id))
    .map((o) => o.id);
}

/** Disputed orders whose arbiter window has closed (now >= resolve_by). */
export function dueTimeouts(orders: IndexedOrder[], now: number): string[] {
  return orders
    .filter((o) => o.state === "Disputed" && now >= o.resolve_by)
    .sort((a, b) => a.resolve_by - b.resolve_by || a.id.localeCompare(b.id))
    .map((o) => o.id);
}

export function pendingRefunds(orders: IndexedOrder[]): string[] {
  return orders.filter((o) => o.refund_owed > 0n).map((o) => o.id);
}

export function batches<T>(items: T[], size = MAX_BATCH): T[][] {
  if (size < 1) throw new Error("batch size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface KeeperExecutor {
  releaseMany(ids: string[]): Promise<number>;
  timeoutRefund(id: string): Promise<void>;
  settleRefund(id: string): Promise<bigint>;
}

export interface KeeperReport {
  now: number;
  released: number;
  batches: string[][];
  timedOut: string[];
  settled: string[];
  settleFailures: { id: string; error: string }[];
}

export interface KeeperOptions {
  /** Retry pending refunds on this run (the sim retries hourly). */
  retryPending?: boolean;
}

/** One keeper pass over a local index of orders. */
export async function runKeeperOnce(
  orders: IndexedOrder[],
  now: number,
  exec: KeeperExecutor,
  opts: KeeperOptions = {},
): Promise<KeeperReport> {
  const report: KeeperReport = { now, released: 0, batches: [], timedOut: [], settled: [], settleFailures: [] };
  for (const batch of batches(dueReleases(orders, now))) {
    report.batches.push(batch);
    report.released += await exec.releaseMany(batch);
  }
  for (const id of dueTimeouts(orders, now)) {
    await exec.timeoutRefund(id);
    report.timedOut.push(id);
  }
  if (opts.retryPending ?? true) {
    for (const id of pendingRefunds(orders)) {
      try {
        await exec.settleRefund(id);
        report.settled.push(id);
      } catch (e) {
        report.settleFailures.push({ id, error: (e as Error).message });
      }
    }
  }
  return report;
}
