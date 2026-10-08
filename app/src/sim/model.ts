// A TypeScript model of the refund_escrow state machine, used by `simulate`,
// by the `local-sim` network of the CLI and by the seed generator. It follows
// contracts/refund_escrow/src/lib.rs rule for rule, including error codes and
// the order in which checks run. The Rust scenario test replays the schedule
// this model produces and must reach the same states and amounts, so any
// divergence between model and contract fails `cargo test`.
//
// Token balances are modelled per (token, address). A "removed trustline" is
// modelled as a deauthorised balance: it can neither receive nor send.

import { ERRORS } from "../errors.ts";
import { feeFor, MAX_FEE_BPS } from "../fee.ts";
import { MAX_AMOUNT } from "../amount.ts";
import { REASONS } from "../reasons.ts";

export const MAX_BATCH = 25;
export const MAX_ARBITER_TIMEOUT = 30 * 86_400;

export type OrderState = "Held" | "Disputed" | "Refunded" | "Released" | "Resolved" | "TimedOut";
export const TERMINAL: ReadonlySet<OrderState> = new Set(["Refunded", "Released", "Resolved", "TimedOut"]);

export interface Config {
  admin: string;
  arbiter: string;
  fee_to: string;
  arbiter_timeout: number;
  min_window: number;
  max_window: number;
  paused: boolean;
}

export interface MerchantCfg {
  payout: string;
  fee_bps: number;
  default_window: number;
  active: boolean;
}

export interface Order {
  merchant: string;
  payout: string;
  buyer: string;
  refund_to: string;
  token: string;
  amount: bigint;
  held: bigint;
  refunded: bigint;
  refund_owed: bigint;
  released: bigint;
  fee: bigint;
  fee_bps: number;
  arbiter: string;
  arbiter_timeout: number;
  paid_at: number;
  release_at: number;
  disputed_at: number;
  resolve_by: number;
  closed_at: number;
  dispute_used: boolean;
  reason: number;
  buyer_evidence: string | null;
  merchant_evidence: string | null;
  ruling: string | null;
  memo_hash: string;
  state: OrderState;
}

export interface ChainEvent {
  type: string;
  order_id?: string;
  at: number;
  ledger: number;
  tx_hash: string;
  amounts: Record<string, string>;
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: number };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (name: keyof typeof ERRORS): Result<never> => ({ ok: false, code: ERRORS[name] });

const VALID_REASONS: ReadonlySet<number> = new Set(Object.values(REASONS));

export interface ModelSnapshot {
  now: number;
  ledger: number;
  cfg: Config;
  tokens: Record<string, boolean>;
  merchants: Record<string, MerchantCfg>;
  orders: Record<string, Order>;
  fees: Record<string, string>;
  balances: Record<string, string>;
  deauth: string[];
  events: ChainEvent[];
  txCounter: number;
}

export class RefundEscrowModel {
  /** Ledger close time (unix seconds). */
  now: number;
  /** A ledger sequence that advances with time (~5 s per ledger). */
  ledger: number;
  readonly contract = "CONTRACT";
  cfg: Config;
  tokens = new Map<string, boolean>();
  merchants = new Map<string, MerchantCfg>();
  orders = new Map<string, Order>();
  fees = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  deauth = new Set<string>();
  events: ChainEvent[] = [];
  private txCounter = 0;
  /** Set by the caller before each call so events carry a tx hash. */
  currentTx = "";

  constructor(
    cfg: Omit<Config, "paused">,
    now: number,
  ) {
    if (
      cfg.min_window <= 0 ||
      cfg.min_window > cfg.max_window ||
      cfg.arbiter_timeout <= 0 ||
      cfg.arbiter_timeout > MAX_ARBITER_TIMEOUT
    ) {
      throw new Error("BadConfig");
    }
    this.cfg = { ...cfg, paused: false };
    this.now = now;
    this.ledger = 1_000_000;
  }

  // -- time and tokens ---------------------------------------------------

  advanceTo(t: number): void {
    if (t < this.now) throw new Error(`time cannot go backwards (${t} < ${this.now})`);
    this.ledger += Math.floor((t - this.now) / 5);
    this.now = t;
  }

  /** Starts a new simulated transaction; returns its synthetic hash. */
  beginTx(label: string): string {
    this.txCounter += 1;
    this.ledger += 1;
    this.currentTx = `sim-${String(this.txCounter).padStart(6, "0")}-${label}`;
    return this.currentTx;
  }

  balance(token: string, who: string): bigint {
    return this.balances.get(`${token}|${who}`) ?? 0n;
  }

  mint(token: string, who: string, amount: bigint): void {
    this.balances.set(`${token}|${who}`, this.balance(token, who) + amount);
  }

  setAuthorized(token: string, who: string, authorized: boolean): void {
    if (authorized) this.deauth.delete(`${token}|${who}`);
    else this.deauth.add(`${token}|${who}`);
  }

  isAuthorized(token: string, who: string): boolean {
    return !this.deauth.has(`${token}|${who}`);
  }

  /** SEP-41 transfer semantics that matter here: both sides authorised, enough balance. */
  private transfer(token: string, from: string, to: string, amount: bigint): boolean {
    if (!this.isAuthorized(token, from) || !this.isAuthorized(token, to)) return false;
    if (this.balance(token, from) < amount) return false;
    this.balances.set(`${token}|${from}`, this.balance(token, from) - amount);
    this.balances.set(`${token}|${to}`, this.balance(token, to) + amount);
    return true;
  }

  private emit(type: string, orderId: string | undefined, amounts: Record<string, bigint | number>): void {
    const a: Record<string, string> = {};
    for (const [k, v] of Object.entries(amounts)) a[k] = v.toString();
    this.events.push({
      type,
      ...(orderId ? { order_id: orderId } : {}),
      at: this.now,
      ledger: this.ledger,
      tx_hash: this.currentTx,
      amounts: a,
    });
  }

  private addFees(token: string, fee: bigint): void {
    if (fee === 0n) return;
    this.fees.set(token, (this.fees.get(token) ?? 0n) + fee);
  }

  feesOf(token: string): bigint {
    return this.fees.get(token) ?? 0n;
  }

  /** Pushes refund_owed to refund_to; on failure it stays owed. Returns amount sent. */
  private pushOwed(id: string, o: Order): bigint {
    const owed = o.refund_owed;
    if (owed === 0n) return 0n;
    if (this.transfer(o.token, this.contract, o.refund_to, owed)) {
      o.refund_owed = 0n;
      return owed;
    }
    this.emit("refund_pending", id, { refund_owed: owed });
    return 0n;
  }

  // -- admin -------------------------------------------------------------

  setToken(token: string, enabled: boolean): Result<void> {
    this.tokens.set(token, enabled);
    return ok(undefined);
  }

  addMerchant(merchant: string, payout: string, feeBps: number, defaultWindow: number): Result<void> {
    if (this.cfg.paused) return err("Paused");
    if (feeBps > MAX_FEE_BPS) return err("FeeTooHigh");
    if (defaultWindow < this.cfg.min_window || defaultWindow > this.cfg.max_window) return err("WindowOutOfRange");
    if (this.merchants.has(merchant)) return err("MerchantExists");
    this.merchants.set(merchant, { payout, fee_bps: feeBps, default_window: defaultWindow, active: true });
    this.emit("merchant_added", undefined, { fee_bps: feeBps, default_window: defaultWindow });
    return ok(undefined);
  }

  setMerchantActive(merchant: string, active: boolean): Result<void> {
    const m = this.merchants.get(merchant);
    if (!m) return err("UnknownMerchant");
    m.active = active;
    return ok(undefined);
  }

  setPayout(merchant: string, payout: string): Result<void> {
    const m = this.merchants.get(merchant);
    if (!m) return err("UnknownMerchant");
    m.payout = payout;
    return ok(undefined);
  }

  setArbiter(arbiter: string): Result<void> {
    this.cfg.arbiter = arbiter;
    return ok(undefined);
  }

  setPaused(paused: boolean): Result<void> {
    this.cfg.paused = paused;
    return ok(undefined);
  }

  withdrawFees(token: string): Result<bigint> {
    const amount = this.feesOf(token);
    if (amount === 0n) return ok(0n);
    if (!this.transfer(token, this.contract, this.cfg.fee_to, amount)) return err("TransferFailed");
    this.fees.set(token, 0n);
    this.emit("fees_withdrawn", undefined, { amount });
    return ok(amount);
  }

  // -- checkout ----------------------------------------------------------

  pay(
    buyer: string,
    merchant: string,
    orderId: string,
    token: string,
    amount: bigint,
    refundTo: string | null,
    window: number | null,
    memoHash: string,
  ): Result<void> {
    if (this.cfg.paused) return err("Paused");
    const m = this.merchants.get(merchant);
    if (!m) return err("UnknownMerchant");
    if (!m.active) return err("MerchantInactive");
    if (!this.tokens.get(token)) return err("TokenNotEnabled");
    if (amount <= 0n || amount > MAX_AMOUNT) return err("InvalidAmount");
    if (this.orders.has(orderId)) return err("DuplicateOrder");
    const w = window ?? m.default_window;
    if (w < this.cfg.min_window || w > this.cfg.max_window) return err("WindowOutOfRange");
    const rt = refundTo ?? buyer; // a different refund_to must also sign (auth is not modelled)
    if (!this.transfer(token, buyer, this.contract, amount)) return err("TransferFailed");
    const o: Order = {
      merchant,
      payout: m.payout,
      buyer,
      refund_to: rt,
      token,
      amount,
      held: amount,
      refunded: 0n,
      refund_owed: 0n,
      released: 0n,
      fee: 0n,
      fee_bps: m.fee_bps,
      arbiter: this.cfg.arbiter,
      arbiter_timeout: this.cfg.arbiter_timeout,
      paid_at: this.now,
      release_at: this.now + w,
      disputed_at: 0,
      resolve_by: 0,
      closed_at: 0,
      dispute_used: false,
      reason: 0,
      buyer_evidence: null,
      merchant_evidence: null,
      ruling: null,
      memo_hash: memoHash,
      state: "Held",
    };
    this.orders.set(orderId, o);
    this.emit("pay", orderId, { amount, release_at: o.release_at });
    return ok(undefined);
  }

  // -- merchant ----------------------------------------------------------

  refund(orderId: string, amount: bigint): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    if (o.state !== "Held" && o.state !== "Disputed") return err("BadState");
    if (amount <= 0n || amount > o.held) return err("InvalidAmount");
    o.held -= amount;
    o.refunded += amount;
    o.refund_owed += amount;
    if (o.held === 0n) {
      o.state = "Refunded";
      o.closed_at = this.now;
    }
    const sent = this.pushOwed(orderId, o);
    if (sent > 0n) this.emit("refund", orderId, { amount, refunded: o.refunded });
    return ok(undefined);
  }

  settleRefund(orderId: string): Result<bigint> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    const owed = o.refund_owed;
    if (owed === 0n) return err("NothingOwed");
    if (!this.transfer(o.token, this.contract, o.refund_to, owed)) return err("TransferFailed");
    o.refund_owed = 0n;
    this.emit("refund_settled", orderId, { amount: owed });
    return ok(owed);
  }

  // -- disputes ----------------------------------------------------------

  dispute(orderId: string, reason: number, evidenceHash: string): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    if (o.state !== "Held") return err("BadState");
    if (this.now >= o.release_at) return err("WindowClosed");
    if (o.dispute_used) return err("DisputeUsed");
    if (o.held <= 0n) return err("BadState");
    if (!VALID_REASONS.has(reason)) return err("BadReason");
    o.state = "Disputed";
    o.disputed_at = this.now;
    o.resolve_by = this.now + o.arbiter_timeout;
    o.dispute_used = true;
    o.reason = reason;
    o.buyer_evidence = evidenceHash;
    this.emit("dispute", orderId, { reason, resolve_by: o.resolve_by });
    return ok(undefined);
  }

  respond(orderId: string, evidenceHash: string): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    if (o.state !== "Disputed") return err("BadState");
    o.merchant_evidence = evidenceHash;
    this.emit("respond", orderId, {});
    return ok(undefined);
  }

  withdrawDispute(orderId: string): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    if (o.state !== "Disputed") return err("BadState");
    o.state = "Held";
    this.emit("dispute_withdrawn", orderId, {});
    return ok(undefined);
  }

  resolve(orderId: string, refundAmount: bigint, rulingHash: string, signer?: string): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    // Auth: only the order's snapshot arbiter. The contract fails with a host
    // auth error; the model reports NotAuthorised when a signer is given.
    if (signer !== undefined && signer !== o.arbiter) return err("NotAuthorised");
    if (o.state !== "Disputed") return err("BadState");
    if (this.now >= o.resolve_by) return err("ArbiterExpired");
    if (refundAmount < 0n || refundAmount > o.held) return err("InvalidAmount");
    const share = o.held - refundAmount;
    const fee = feeFor(share, o.fee_bps);
    const net = share - fee;
    if (net > 0n && !this.isAuthorized(o.token, o.payout)) return err("TransferFailed");
    o.refunded += refundAmount;
    o.refund_owed += refundAmount;
    o.released += net;
    o.fee += fee;
    o.held = 0n;
    o.state = "Resolved";
    o.closed_at = this.now;
    o.ruling = rulingHash;
    this.addFees(o.token, fee);
    if (net > 0n) this.transfer(o.token, this.contract, o.payout, net);
    this.pushOwed(orderId, o);
    this.emit("resolve", orderId, { refund_amount: refundAmount, merchant_net: net, fee });
    return ok(undefined);
  }

  timeoutRefund(orderId: string): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    if (o.state !== "Disputed") return err("BadState");
    if (this.now < o.resolve_by) return err("ArbiterWindowOpen");
    const r = o.held;
    o.refunded += r;
    o.refund_owed += r;
    o.held = 0n;
    o.state = "TimedOut";
    o.closed_at = this.now;
    this.pushOwed(orderId, o);
    this.emit("timeout", orderId, { refund_amount: r });
    return ok(undefined);
  }

  // -- release -----------------------------------------------------------

  private releasable(o: Order): boolean {
    return o.state === "Held" && this.now >= o.release_at && o.held > 0n;
  }

  private bookRelease(o: Order): [bigint, bigint] {
    const fee = feeFor(o.held, o.fee_bps);
    const net = o.held - fee;
    o.released += net;
    o.fee += fee;
    o.held = 0n;
    o.state = "Released";
    o.closed_at = this.now;
    this.addFees(o.token, fee);
    return [net, fee];
  }

  release(orderId: string): Result<void> {
    const o = this.orders.get(orderId);
    if (!o) return err("OrderNotFound");
    if (o.state !== "Held" || o.held <= 0n) return err("BadState");
    if (this.now < o.release_at) return err("WindowOpen");
    const net0 = o.held - feeFor(o.held, o.fee_bps);
    if (net0 > 0n && !this.isAuthorized(o.token, o.payout)) return err("TransferFailed");
    const [net, fee] = this.bookRelease(o);
    if (net > 0n) this.transfer(o.token, this.contract, o.payout, net);
    this.emit("release", orderId, { merchant_net: net, fee });
    return ok(undefined);
  }

  releaseMany(orderIds: string[]): Result<number> {
    if (orderIds.length > MAX_BATCH) return err("BatchTooLarge");
    let count = 0;
    for (const id of orderIds) {
      const o = this.orders.get(id);
      if (!o || !this.releasable(o)) continue;
      const net0 = o.held - feeFor(o.held, o.fee_bps);
      if (net0 > 0n && !this.transfer(o.token, this.contract, o.payout, net0)) continue;
      const [net, fee] = this.bookRelease(o);
      this.emit("release", id, { merchant_net: net, fee });
      count += 1;
    }
    return ok(count);
  }

  // -- views and persistence -------------------------------------------------

  order(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  eventsFor(orderId: string): ChainEvent[] {
    return this.events.filter((e) => e.order_id === orderId);
  }

  snapshot(): ModelSnapshot {
    const big = (m: Map<string, bigint>) => Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));
    return {
      now: this.now,
      ledger: this.ledger,
      cfg: { ...this.cfg },
      tokens: Object.fromEntries(this.tokens),
      merchants: Object.fromEntries(this.merchants),
      orders: Object.fromEntries(
        [...this.orders].map(([k, o]) => [k, JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))]),
      ),
      fees: big(this.fees),
      balances: big(this.balances),
      deauth: [...this.deauth],
      events: this.events,
      txCounter: this.txCounter,
    };
  }

  static restore(s: ModelSnapshot): RefundEscrowModel {
    const { paused, ...cfg } = s.cfg;
    const m = new RefundEscrowModel(cfg, s.now);
    m.cfg.paused = paused;
    m.ledger = s.ledger;
    m.tokens = new Map(Object.entries(s.tokens));
    m.merchants = new Map(Object.entries(s.merchants));
    const BIG = ["amount", "held", "refunded", "refund_owed", "released", "fee"] as const;
    m.orders = new Map(
      Object.entries(s.orders).map(([k, raw]) => {
        const o = { ...(raw as unknown as Record<string, unknown>) };
        for (const f of BIG) o[f] = BigInt(o[f] as string);
        return [k, o as unknown as Order];
      }),
    );
    m.fees = new Map(Object.entries(s.fees).map(([k, v]) => [k, BigInt(v)]));
    m.balances = new Map(Object.entries(s.balances).map(([k, v]) => [k, BigInt(v)]));
    m.deauth = new Set(s.deauth);
    m.events = s.events;
    m.txCounter = s.txCounter;
    return m;
  }
}

/** Per-order invariants of ARCHITECTURE.md §6; throws on violation. */
export function checkOrderInvariants(id: string, o: Order): void {
  if (o.amount !== o.held + o.refunded + o.released + o.fee) {
    throw new Error(`order ${id}: amount != held + refunded + released + fee`);
  }
  if (o.refund_owed < 0n || o.refund_owed > o.refunded) throw new Error(`order ${id}: refund_owed out of bounds`);
  if (o.fee > feeFor(o.amount - o.refunded, o.fee_bps)) throw new Error(`order ${id}: fee charged on refunded value`);
}

/** Per-token invariant: contract balance == Σ held + Σ refund_owed + fees. */
export function checkTokenInvariant(m: RefundEscrowModel, token: string): void {
  let due = 0n;
  for (const o of m.orders.values()) if (o.token === token) due += o.held + o.refund_owed;
  const bal = m.balance(token, m.contract);
  if (bal !== due + m.feesOf(token)) {
    throw new Error(`token ${token}: contract balance ${bal} != held+owed+fees ${due + m.feesOf(token)}`);
  }
}
