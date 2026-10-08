// Offline simulator: replays data/seed/ (orders.jsonl + events.jsonl) against
// the TypeScript contract model and the express-mode model, with a keeper that
// ticks every `keeper_interval_s` except during the planned outage. It returns
// the per-order outcomes, the counts compared with expected.json, and the exact
// call schedule that the Rust scenario test replays against the real contract.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAmount, formatAmount } from "../amount.ts";
import { isoUtc } from "../duration.ts";
import { errorName } from "../errors.ts";
import { reasonCode } from "../reasons.ts";
import { runKeeperOnce, type IndexedOrder, type KeeperExecutor } from "../keeper.ts";
import { RefundEscrowModel, checkOrderInvariants, checkTokenInvariant, type Result } from "./model.ts";
import { ExpressModel } from "./express-model.ts";
import type { EventSeed, Expected, MerchantSeed, OrderSeed, PspSeed, TokenTotals } from "../seed/types.ts";

export interface SeedBundle {
  psp: PspSeed;
  merchants: MerchantSeed[];
  orders: OrderSeed[];
  events: EventSeed[];
}

export function loadSeed(dir: string): SeedBundle {
  const json = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), "utf8")) as T;
  const jsonl = <T>(f: string): T[] =>
    readFileSync(join(dir, f), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as T);
  return {
    psp: json<PspSeed>("psp.json"),
    merchants: json<MerchantSeed[]>("merchants.json"),
    orders: jsonl<OrderSeed>("orders.jsonl"),
    events: jsonl<EventSeed>("events.jsonl"),
  };
}

export type CallKind =
  | "pay"
  | "pay_dup"
  | "refund"
  | "deauth"
  | "reauth"
  | "dispute"
  | "respond"
  | "resolve"
  | "withdraw_dispute"
  | "release_many"
  | "timeout"
  | "settle"
  | "withdraw_fees";

/** One contract call (or token-admin action) in time order, with its outcome. */
export interface ScheduledCall {
  at: number;
  kind: CallKind;
  order?: number;
  ids?: number[];
  id_hex?: string;
  token?: string;
  amount?: string;
  reason?: number;
  hash?: string;
  who?: string;
  expect: string;
  ret?: string;
}

export interface OrderOutcome {
  n: number;
  tag?: string;
  merchant: string;
  token: string;
  state: string;
  amount: string;
  held: string;
  refunded: string;
  refund_owed: string;
  released: string;
  fee: string;
  paid_at: number;
  release_at: number;
  closed_at: number;
  released_late: boolean;
}

export interface SimResult {
  model: RefundEscrowModel;
  express: ExpressModel;
  schedule: ScheduledCall[];
  outcomes: OrderOutcome[];
  expected: Expected;
  keeper: { ticks: number; skippedTicks: number; releaseCalls: number; timeouts: number; settleFailures: number };
  log: string[];
}

interface Action {
  at: number;
  seq: number;
  run: () => void;
}


export interface SimOptions {
  /** Stop after this time (unix seconds): used by `brief --seed` to see a dispute mid-way. */
  until?: number;
}

export async function runSimulation(seed: SeedBundle, opts: SimOptions = {}): Promise<SimResult> {
  const { psp, merchants, orders, events } = seed;
  const model = new RefundEscrowModel(
    {
      admin: psp.accounts.admin,
      arbiter: psp.accounts.arbiter,
      fee_to: psp.accounts.fee_to,
      arbiter_timeout: psp.arbiter_timeout_s,
      min_window: psp.min_window_s,
      max_window: psp.max_window_s,
    },
    psp.t0_s,
  );
  const express = new ExpressModel();
  const schedule: ScheduledCall[] = [];
  const log: string[] = [];
  const byN = new Map(orders.map((o) => [o.n, o]));
  const nById = new Map(orders.map((o) => [o.order_id, o.n]));
  const merchantById = new Map(merchants.map((m) => [m.id, m]));
  const touched = new Set<number>(); // orders with any human action after pay
  const rejected: Record<string, number> = {};
  let refundPending = 0;
  let refundSettled = 0;

  const record = (call: Omit<ScheduledCall, "at" | "expect" | "ret">, r: Result<unknown>): Result<unknown> => {
    const entry: ScheduledCall = { at: model.now, ...call, expect: r.ok ? "ok" : errorName(r.code) };
    if (r.ok && (typeof r.value === "bigint" || typeof r.value === "number")) entry.ret = r.value.toString();
    schedule.push(entry);
    return r;
  };

  // setup (not part of the replayed schedule; the Rust test does its own setup)
  for (const t of psp.tokens) model.setToken(t.code, true);
  for (const m of merchants) {
    const r = model.addMerchant(m.address, m.payout, m.fee_bps, m.window_s);
    if (!r.ok) throw new Error(`add_merchant ${m.id}: ${errorName(r.code)}`);
  }
  for (const o of orders) {
    if (o.mode === "escrow") model.mint(o.token, o.buyer_address, parseAmount(o.amount));
  }

  // -- human actions ---------------------------------------------------------
  const actions: Action[] = [];
  let seq = 0;
  for (const o of orders) {
    const m = merchantById.get(o.merchant)!;
    actions.push({
      at: o.paid_at_s,
      seq: seq++,
      run: () => {
        if (o.mode === "express") {
          express.create({
            id: `cb-${o.order_id.slice(0, 16)}`,
            order_n: o.n,
            buyer: o.buyer_address,
            merchant: m.address,
            asset: o.token,
            amount: parseAmount(o.amount),
            releaseAt: o.paid_at_s + (o.window_s ?? m.window_s),
            createdAt: model.now,
          });
          return;
        }
        model.beginTx(`pay-${o.n}`);
        const r = record(
          {
            kind: "pay",
            order: o.n,
            id_hex: o.order_id,
            token: o.token,
            amount: parseAmount(o.amount).toString(),
            who: o.refund_to,
          },
          model.pay(
            o.buyer_address,
            m.address,
            o.order_id,
            o.token,
            parseAmount(o.amount),
            o.refund_to_address ?? null,
            o.window_s ?? null,
            o.memo_hash,
          ),
        );
        if (!r.ok) throw new Error(`pay #${o.n} failed: ${errorName(r.code)}`);
      },
    });
  }
  let outage: { from: number; to: number } | null = null;
  for (const e of events) {
    if (e.type === "keeper_down") {
      outage = { from: e.at_s, to: e.until_s! };
      continue;
    }
    actions.push({ at: e.at_s, seq: seq++, run: () => applyEvent(e) });
  }
  actions.sort((a, b) => a.at - b.at || a.seq - b.seq);

  function applyEvent(e: EventSeed): void {
    const o = e.order_n !== undefined ? byN.get(e.order_n) : undefined;
    const id = o?.order_id ?? "";
    model.beginTx(`${e.type}-${e.seq}`);
    let r: Result<unknown>;
    switch (e.type) {
      case "pay_duplicate": {
        const m = merchantById.get(o!.merchant)!;
        // The duplicate id comes from the re-typed reference (normalised to the same id).
        r = record(
          { kind: "pay_dup", order: o!.n, id_hex: e.order_id!, token: o!.token, amount: parseAmount(e.amount!).toString() },
          model.pay(o!.buyer_address, m.address, e.order_id!, o!.token, parseAmount(e.amount!), null, null, o!.memo_hash),
        );
        break;
      }
      case "refund": {
        const ord = model.order(id)!;
        const amt = e.amount === "all" ? ord.held : parseAmount(e.amount!);
        const before = model.events.length;
        r = record({ kind: "refund", order: o!.n, amount: amt.toString() }, model.refund(id, amt));
        if (model.events.slice(before).some((x) => x.type === "refund_pending")) {
          refundPending += 1;
        }
        touched.add(o!.n);
        break;
      }
      case "remove_trustline":
        model.setAuthorized(e.token!, psp.addresses[e.who!]!, false);
        r = record({ kind: "deauth", token: e.token!, who: e.who! }, { ok: true, value: undefined });
        break;
      case "restore_trustline":
        model.setAuthorized(e.token!, psp.addresses[e.who!]!, true);
        r = record({ kind: "reauth", token: e.token!, who: e.who! }, { ok: true, value: undefined });
        break;
      case "dispute":
        r = record(
          { kind: "dispute", order: o!.n, reason: reasonCode(e.reason!), hash: e.evidence_hash! },
          model.dispute(id, reasonCode(e.reason!), e.evidence_hash!),
        );
        touched.add(o!.n);
        break;
      case "respond":
        r = record({ kind: "respond", order: o!.n, hash: e.evidence_hash! }, model.respond(id, e.evidence_hash!));
        break;
      case "withdraw_dispute":
        r = record({ kind: "withdraw_dispute", order: o!.n }, model.withdrawDispute(id));
        break;
      case "resolve": {
        const amt = parseAmount(e.amount!);
        r = record(
          { kind: "resolve", order: o!.n, amount: amt.toString(), hash: e.ruling_hash! },
          model.resolve(id, amt, e.ruling_hash!),
        );
        break;
      }
      case "express_reclaim":
      case "express_claim": {
        const bid = `cb-${o!.order_id.slice(0, 16)}`;
        const who = e.type === "express_reclaim" ? o!.buyer_address : merchantById.get(o!.merchant)!.address;
        const res = express.claim(bid, who, model.now);
        if (res !== e.expect) throw new Error(`event ${e.seq}: express ${res}, expected ${e.expect}`);
        log.push(`${isoUtc(model.now)} ${e.type} #${o!.n}: ${res}`);
        return;
      }
      case "withdraw_fees":
        r = record({ kind: "withdraw_fees", token: e.token! }, model.withdrawFees(e.token!));
        break;
      default:
        throw new Error(`unknown event type ${e.type}`);
    }
    const got = r.ok ? "ok" : errorName(r.code);
    if (got !== e.expect) throw new Error(`event ${e.seq} (${e.type} #${e.order_n ?? "-"}): got ${got}, expected ${e.expect}`);
    if (!r.ok) rejected[got] = (rejected[got] ?? 0) + 1;
  }

  // -- keeper ----------------------------------------------------------------
  const exec: KeeperExecutor = {
    async releaseMany(ids) {
      model.beginTx("keeper-release_many");
      const r = record({ kind: "release_many", ids: ids.map((i) => nById.get(i)!) }, model.releaseMany(ids));
      if (!r.ok) throw new Error(`release_many: ${errorName(r.code)}`);
      return r.value as number;
    },
    async timeoutRefund(id) {
      model.beginTx("keeper-timeout");
      const r = record({ kind: "timeout", order: nById.get(id)! }, model.timeoutRefund(id));
      if (!r.ok) throw new Error(`timeout_refund: ${errorName(r.code)}`);
    },
    async settleRefund(id) {
      model.beginTx("keeper-settle");
      const r = record({ kind: "settle", order: nById.get(id)! }, model.settleRefund(id));
      if (!r.ok) throw new Error(errorName(r.code));
      refundSettled += 1;
      return r.value as bigint;
    },
  };
  const keeperStats = { ticks: 0, skippedTicks: 0, releaseCalls: 0, timeouts: 0, settleFailures: 0 };
  const releasedAt = new Map<number, number>();

  const index = (): IndexedOrder[] =>
    [...model.orders].map(([id, o]) => ({
      id,
      state: o.state,
      held: o.held,
      refund_owed: o.refund_owed,
      release_at: o.release_at,
      resolve_by: o.resolve_by,
    }));

  const interval = psp.keeper_interval_s;
  let ai = 0;
  const ticks: number[] = [];
  const end = Math.min(psp.sim_end_s, opts.until ?? Infinity);
  for (let t = psp.t0_s + interval; t <= end; t += interval) ticks.push(t);

  return await finish();

  async function finish(): Promise<SimResult> {
    for (const t of ticks) {
      while (ai < actions.length && actions[ai]!.at <= t) {
        const a = actions[ai++]!;
        model.advanceTo(a.at);
        a.run();
      }
      model.advanceTo(t);
      if (outage && t >= outage.from && t < outage.to) {
        keeperStats.skippedTicks += 1;
        continue;
      }
      await tick(t);
      checkAll();
    }
    while (ai < actions.length && actions[ai]!.at <= end) {
      const a = actions[ai++]!;
      model.advanceTo(a.at);
      a.run();
    }
    if (opts.until !== undefined && model.now < end) model.advanceTo(end);
    checkAll();
    return summarise();
  }

  async function tick(t: number): Promise<void> {
    keeperStats.ticks += 1;
    const retry = t % psp.pending_retry_s === 0;
    const idx = index();
    const before = new Map(idx.map((o) => [o.id, o.state]));
    const rep = await runKeeperOnce(idx, t, exec, { retryPending: retry });
    keeperStats.releaseCalls += rep.batches.length;
    keeperStats.timeouts += rep.timedOut.length;
    keeperStats.settleFailures += rep.settleFailures.length;
    for (const [id, o] of model.orders) {
      if (before.get(id) === "Held" && o.state === "Released") releasedAt.set(nById.get(id)!, t);
    }
  }

  function checkAll(): void {
    for (const [id, o] of model.orders) checkOrderInvariants(id, o);
    for (const t of psp.tokens) checkTokenInvariant(model, t.code);
  }

  function summarise(): SimResult {
    const outcomes: OrderOutcome[] = [];
    const states: Record<string, number> = {};
    let refundedOutside = 0;
    let refundedInDispute = 0;
    let late = 0;
    let untouched = 0;
    for (const o of orders.filter((x) => x.mode === "escrow")) {
      const s = model.order(o.order_id);
      if (!s) continue; // not paid yet (partial run)
      states[s.state] = (states[s.state] ?? 0) + 1;
      if (s.state === "Refunded") {
        if (s.dispute_used) refundedInDispute += 1;
        else refundedOutside += 1;
      }
      const relAt = releasedAt.get(o.n);
      const isLate = relAt !== undefined && relAt - s.release_at > psp.keeper_interval_s;
      if (isLate) late += 1;
      if (s.state === "Released" && !touched.has(o.n)) untouched += 1;
      outcomes.push({
        n: o.n,
        ...(o.tag ? { tag: o.tag } : {}),
        merchant: o.merchant,
        token: o.token,
        state: s.state,
        amount: s.amount.toString(),
        held: s.held.toString(),
        refunded: s.refunded.toString(),
        refund_owed: s.refund_owed.toString(),
        released: s.released.toString(),
        fee: s.fee.toString(),
        paid_at: s.paid_at,
        release_at: s.release_at,
        closed_at: s.closed_at,
        released_late: isLate,
      });
    }
    const totals: Record<string, TokenTotals> = {};
    for (const t of psp.tokens) {
      let paid = 0n;
      let refunded = 0n;
      const payout: Record<string, bigint> = {};
      for (const o of orders.filter((x) => x.mode === "escrow" && x.token === t.code)) {
        const s = model.order(o.order_id);
      if (!s) continue; // not paid yet (partial run)
        paid += s.amount;
        refunded += s.refunded - s.refund_owed;
        payout[o.merchant] = (payout[o.merchant] ?? 0n) + s.released;
      }
      totals[t.code] = {
        paid: formatAmount(paid),
        payout: Object.fromEntries(Object.entries(payout).map(([k, v]) => [k, formatAmount(v)])),
        refunded: formatAmount(refunded),
        fees: formatAmount(model.balance(t.code, psp.accounts.fee_to)),
        contract_after: formatAmount(model.balance(t.code, model.contract)),
      };
    }
    let claimed = 0;
    let reclaimed = 0;
    let claimedAmt = 0n;
    let reclaimedAmt = 0n;
    for (const b of express.balances.values()) {
      if (b.claimedBy === "merchant") {
        claimed += 1;
        claimedAmt += b.amount;
      } else if (b.claimedBy === "buyer") {
        reclaimed += 1;
        reclaimedAmt += b.amount;
      }
    }
    const expected: Expected = {
      orders: orders.length,
      escrow_orders: orders.filter((o) => o.mode === "escrow").length,
      express_orders: orders.filter((o) => o.mode === "express").length,
      states,
      refunded_outside_dispute: refundedOutside,
      refunded_in_dispute: refundedInDispute,
      rejected,
      late_releases: late,
      untouched_releases: untouched,
      refund_pending: refundPending,
      refund_settled: refundSettled,
      express: {
        claimed,
        reclaimed,
        claimed_amount: formatAmount(claimedAmt),
        reclaimed_amount: formatAmount(reclaimedAmt),
      },
      totals,
    };
    return { model, express, schedule, outcomes, expected, keeper: keeperStats, log };
  }
}
