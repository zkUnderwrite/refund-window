// One interface for the CLI's two networks.
//   local-sim: the TypeScript contract model, persisted to .refundwin-sim.json,
//              with the contract's auth roles enforced here (the model itself
//              does not model signatures). Nothing touches a network.
//   testnet:   Stellar RPC through tx/rpc.ts (backend-rpc.ts).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Keypair } from "@stellar/stellar-sdk";
import { ContractError, ERRORS } from "./errors.ts";
import type { IndexedOrder } from "./keeper.ts";
import type { OrderView, ReceiptEvent } from "./receipt.ts";
import { RefundEscrowModel, type ModelSnapshot, type Result } from "./sim/model.ts";
import { modelReceiptEvents, orderView, SIM_PASSPHRASE } from "./sim/model-receipt.ts";
import { isoUtc } from "./duration.ts";
import type { PayParams } from "./tx/args.ts";

export interface TxRef {
  hash: string;
  ledger: number;
  at: number;
}

export interface CallResult<T = unknown> {
  tx: TxRef;
  value: T;
}

export interface InitParams {
  admin: Keypair;
  arbiter: string;
  feeTo: string;
  arbiterTimeout: number;
  minWindow: number;
  maxWindow: number;
}

export interface Backend {
  readonly network: "testnet" | "local-sim";
  readonly networkPassphrase: string;
  readonly contractId: string;
  now(): Promise<number>;
  tokenId(code: string, issuer?: string): string;
  setToken(token: string, enabled: boolean, admin: Keypair): Promise<TxRef>;
  addMerchant(merchant: Keypair, payout: string, feeBps: number, window: number, admin: Keypair): Promise<TxRef>;
  pay(buyer: Keypair, p: PayParams, refundTo?: Keypair): Promise<TxRef>;
  refund(id: string, amount: bigint, merchant: Keypair): Promise<TxRef>;
  settleRefund(id: string, caller: Keypair): Promise<CallResult<bigint>>;
  dispute(id: string, reason: number, evidence: string, buyer: Keypair): Promise<TxRef>;
  respond(id: string, evidence: string, merchant: Keypair): Promise<TxRef>;
  withdrawDispute(id: string, buyer: Keypair): Promise<TxRef>;
  resolve(id: string, refundAmount: bigint, ruling: string, arbiter: Keypair): Promise<TxRef>;
  release(id: string, caller: Keypair): Promise<TxRef>;
  releaseMany(ids: string[], caller: Keypair): Promise<CallResult<number>>;
  timeoutRefund(id: string, caller: Keypair): Promise<TxRef>;
  withdrawFees(token: string, admin: Keypair): Promise<CallResult<bigint>>;
  order(id: string): Promise<OrderView | undefined>;
  fees(token: string): Promise<bigint>;
  /** Chain events for the receipt (sim: all; RPC: within retention). */
  events(id: string): Promise<ReceiptEvent[]>;
}

export async function indexOrders(b: Backend, ids: string[]): Promise<IndexedOrder[]> {
  const out: IndexedOrder[] = [];
  for (const id of ids) {
    const o = await b.order(id);
    if (o) out.push({ id, state: o.state, held: o.held, refund_owed: o.refund_owed, release_at: o.release_at, resolve_by: o.resolve_by });
  }
  return out;
}

// ---------------------------------------------------------------------------
// local-sim
// ---------------------------------------------------------------------------

export interface SimState {
  admin: string;
  snapshot: ModelSnapshot;
}

export class AuthError extends Error {}

export class SimBackend implements Backend {
  readonly network = "local-sim" as const;
  readonly networkPassphrase = SIM_PASSPHRASE;
  readonly contractId = "local-sim";
  private readonly file: string;
  model: RefundEscrowModel;
  admin: string;
  private constructor(file: string, model: RefundEscrowModel, admin: string) {
    this.file = file;
    this.model = model;
    this.admin = admin;
  }

  static path(dir: string): string {
    return join(dir, ".refundwin-sim.json");
  }

  static exists(dir: string): boolean {
    return existsSync(SimBackend.path(dir));
  }

  static create(dir: string, p: InitParams, now = Math.floor(Date.now() / 1000)): SimBackend {
    const model = new RefundEscrowModel(
      { admin: p.admin.publicKey(), arbiter: p.arbiter, fee_to: p.feeTo, arbiter_timeout: p.arbiterTimeout, min_window: p.minWindow, max_window: p.maxWindow },
      now,
    );
    const b = new SimBackend(SimBackend.path(dir), model, p.admin.publicKey());
    b.save();
    return b;
  }

  static load(dir: string): SimBackend {
    const file = SimBackend.path(dir);
    if (!existsSync(file)) throw new Error("no local-sim contract here: run `refundwin init --network local-sim …` first");
    const s = JSON.parse(readFileSync(file, "utf8")) as SimState;
    return new SimBackend(file, RefundEscrowModel.restore(s.snapshot), s.admin);
  }

  save(): void {
    const s: SimState = { admin: this.admin, snapshot: this.model.snapshot() };
    writeFileSync(this.file, JSON.stringify(s, null, 1) + "\n");
  }

  /** local-sim only: move the ledger clock forward. */
  advance(secs: number): number {
    this.model.advanceTo(this.model.now + secs);
    this.save();
    return this.model.now;
  }

  /** local-sim only: credit test tokens (the issuer's mint). */
  fund(token: string, who: string, amount: bigint): void {
    this.model.mint(token, who, amount);
    this.save();
  }

  /** local-sim only: the issuer deauthorises or restores a holder (a removed trustline). */
  authorize(token: string, who: string, ok: boolean): void {
    this.model.setAuthorized(token, who, ok);
    this.save();
  }

  balance(token: string, who: string): bigint {
    return this.model.balance(token, who);
  }

  async now(): Promise<number> {
    return this.model.now;
  }

  tokenId(code: string): string {
    return code.toUpperCase();
  }

  private run<T>(label: string, f: () => Result<T>): CallResult<T> {
    const hash = this.model.beginTx(label);
    const r = f();
    if (!r.ok) throw new ContractError(r.code);
    this.save();
    return { tx: { hash, ledger: this.model.ledger, at: this.model.now }, value: r.value };
  }

  private need(signer: Keypair, expected: string, role: string): void {
    if (signer.publicKey() !== expected) {
      throw new AuthError(`auth failed: this call must be signed by the ${role} (${expected}), not ${signer.publicKey()}`);
    }
  }

  private orderOr(id: string) {
    const o = this.model.order(id);
    if (!o) throw new ContractError(ERRORS.OrderNotFound);
    return o;
  }

  async setToken(token: string, enabled: boolean, admin: Keypair): Promise<TxRef> {
    this.need(admin, this.model.cfg.admin, "admin");
    return this.run("set_token", () => this.model.setToken(token, enabled)).tx;
  }

  async addMerchant(merchant: Keypair, payout: string, feeBps: number, window: number, admin: Keypair): Promise<TxRef> {
    this.need(admin, this.model.cfg.admin, "admin");
    return this.run("add_merchant", () => this.model.addMerchant(merchant.publicKey(), payout, feeBps, window)).tx;
  }

  async pay(buyer: Keypair, p: PayParams, refundTo?: Keypair): Promise<TxRef> {
    this.need(buyer, p.buyer, "buyer");
    if (p.refundTo && p.refundTo !== p.buyer) {
      if (!refundTo) throw new AuthError(`auth failed: refund_to ${p.refundTo} must also sign pay`);
      this.need(refundTo, p.refundTo, "refund address");
    }
    return this.run("pay", () =>
      this.model.pay(p.buyer, p.merchant, p.orderId, p.token, p.amount, p.refundTo ?? null, p.window ?? null, p.memoHash),
    ).tx;
  }

  async refund(id: string, amount: bigint, merchant: Keypair): Promise<TxRef> {
    this.need(merchant, this.orderOr(id).merchant, "merchant");
    return this.run("refund", () => this.model.refund(id, amount)).tx;
  }

  async settleRefund(id: string): Promise<CallResult<bigint>> {
    return this.run("settle_refund", () => this.model.settleRefund(id));
  }

  async dispute(id: string, reason: number, evidence: string, buyer: Keypair): Promise<TxRef> {
    this.need(buyer, this.orderOr(id).buyer, "buyer");
    return this.run("dispute", () => this.model.dispute(id, reason, evidence)).tx;
  }

  async respond(id: string, evidence: string, merchant: Keypair): Promise<TxRef> {
    this.need(merchant, this.orderOr(id).merchant, "merchant");
    return this.run("respond", () => this.model.respond(id, evidence)).tx;
  }

  async withdrawDispute(id: string, buyer: Keypair): Promise<TxRef> {
    this.need(buyer, this.orderOr(id).buyer, "buyer");
    return this.run("withdraw_dispute", () => this.model.withdrawDispute(id)).tx;
  }

  async resolve(id: string, refundAmount: bigint, ruling: string, arbiter: Keypair): Promise<TxRef> {
    this.need(arbiter, this.orderOr(id).arbiter, "order's snapshot arbiter");
    return this.run("resolve", () => this.model.resolve(id, refundAmount, ruling)).tx;
  }

  async release(id: string): Promise<TxRef> {
    return this.run("release", () => this.model.release(id)).tx;
  }

  async releaseMany(ids: string[]): Promise<CallResult<number>> {
    return this.run("release_many", () => this.model.releaseMany(ids));
  }

  async timeoutRefund(id: string): Promise<TxRef> {
    return this.run("timeout_refund", () => this.model.timeoutRefund(id)).tx;
  }

  async withdrawFees(token: string, admin: Keypair): Promise<CallResult<bigint>> {
    this.need(admin, this.model.cfg.admin, "admin");
    return this.run("withdraw_fees", () => this.model.withdrawFees(token));
  }

  async order(id: string): Promise<OrderView | undefined> {
    const o = this.model.order(id);
    return o ? orderView(o) : undefined;
  }

  async fees(token: string): Promise<bigint> {
    return this.model.feesOf(token);
  }

  async events(id: string): Promise<ReceiptEvent[]> {
    return modelReceiptEvents(this.model, id);
  }

  nowIso(): string {
    return isoUtc(this.model.now);
  }
}
