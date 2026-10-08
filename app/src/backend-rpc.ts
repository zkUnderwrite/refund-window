// testnet backend: every call goes through Stellar RPC (tx/rpc.ts). Not run
// in this environment (no testnet egress); scripts/e2e-testnet.sh drives it.

import { Asset, type Keypair } from "@stellar/stellar-sdk";
import type { Backend, CallResult, TxRef } from "./backend.ts";
import { formatAmount } from "./amount.ts";
import type { OrderView, ReceiptEvent } from "./receipt.ts";
import { isoUtc } from "./duration.ts";
import * as A from "./tx/args.ts";
import { decodeOrder } from "./tx/decode.ts";
import { ChainClient, type TxOutcome } from "./tx/rpc.ts";
import { scValToNative } from "@stellar/stellar-sdk";

const ref = (o: TxOutcome): TxRef => ({ hash: o.hash, ledger: o.ledger, at: o.createdAt });

export class RpcBackend implements Backend {
  readonly network = "testnet" as const;
  readonly client: ChainClient;
  constructor(client: ChainClient) {
    this.client = client;
  }

  get networkPassphrase(): string {
    return this.client.opts.networkPassphrase;
  }
  get contractId(): string {
    return this.client.contractId;
  }

  async now(): Promise<number> {
    return Math.floor(Date.now() / 1000);
  }

  tokenId(code: string, issuer?: string): string {
    if (!issuer) throw new Error(`asset ${code} needs an issuer on testnet (--asset ${code}:G…)`);
    return new Asset(code, issuer).contractId(this.networkPassphrase);
  }

  private async call(fn: string, args: ReturnType<typeof A.orderIdArgs>, signer: Keypair, cosigners: Keypair[] = []) {
    return this.client.invoke(fn, args, signer, cosigners);
  }

  async setToken(token: string, enabled: boolean, admin: Keypair) {
    return ref(await this.call("set_token", A.setTokenArgs(token, enabled), admin));
  }
  async addMerchant(merchant: Keypair, payout: string, feeBps: number, window: number, admin: Keypair) {
    // Needs admin and merchant auth: the admin submits, the merchant co-signs its entry.
    return ref(await this.call("add_merchant", A.addMerchantArgs(merchant.publicKey(), payout, feeBps, window), admin, [merchant]));
  }
  async pay(buyer: Keypair, p: A.PayParams, refundTo?: Keypair) {
    return ref(await this.call("pay", A.payArgs(p), buyer, refundTo ? [refundTo] : []));
  }
  async refund(id: string, amount: bigint, merchant: Keypair) {
    return ref(await this.call("refund", A.refundArgs(id, amount), merchant));
  }
  async settleRefund(id: string, caller: Keypair): Promise<CallResult<bigint>> {
    const o = await this.call("settle_refund", A.orderIdArgs(id), caller);
    return { tx: ref(o), value: BigInt(scValToNative(o.returnValue!) as bigint) };
  }
  async dispute(id: string, reason: number, evidence: string, buyer: Keypair) {
    return ref(await this.call("dispute", A.disputeArgs(id, reason, evidence), buyer));
  }
  async respond(id: string, evidence: string, merchant: Keypair) {
    return ref(await this.call("respond", A.respondArgs(id, evidence), merchant));
  }
  async withdrawDispute(id: string, buyer: Keypair) {
    return ref(await this.call("withdraw_dispute", A.orderIdArgs(id), buyer));
  }
  async resolve(id: string, refundAmount: bigint, ruling: string, arbiter: Keypair) {
    return ref(await this.call("resolve", A.resolveArgs(id, refundAmount, ruling), arbiter));
  }
  async release(id: string, caller: Keypair) {
    return ref(await this.call("release", A.orderIdArgs(id), caller));
  }
  async releaseMany(ids: string[], caller: Keypair): Promise<CallResult<number>> {
    const o = await this.call("release_many", A.releaseManyArgs(ids), caller);
    return { tx: ref(o), value: Number(scValToNative(o.returnValue!)) };
  }
  async timeoutRefund(id: string, caller: Keypair) {
    return ref(await this.call("timeout_refund", A.orderIdArgs(id), caller));
  }
  async withdrawFees(token: string, admin: Keypair): Promise<CallResult<bigint>> {
    const o = await this.call("withdraw_fees", [A.addr(token)], admin);
    return { tx: ref(o), value: BigInt(scValToNative(o.returnValue!) as bigint) };
  }
  async order(id: string): Promise<OrderView | undefined> {
    return decodeOrder(await this.client.read("order", A.orderIdArgs(id)));
  }
  async fees(token: string): Promise<bigint> {
    return BigInt(await this.client.readNative<bigint>("fees", [A.addr(token)]));
  }

  /** Events still inside RPC retention (~7 days); older ones come from the local receipt cache. */
  async events(id: string): Promise<ReceiptEvent[]> {
    const latest = await this.client.server.getLatestLedger();
    const start = Math.max(1, latest.sequence - 7 * 17_280 + 10);
    const evs = await this.client.orderEvents(id, start);
    return evs.map((e) => {
      const type = String(scValToNative(e.topic[0]!));
      const data = scValToNative(e.value) as unknown;
      const amounts: Record<string, string> = {};
      const vals = Array.isArray(data) ? data : [data];
      vals.forEach((v, i) => {
        if (typeof v === "bigint") amounts[`v${i}`] = formatAmount(v);
      });
      return { type, ledger: e.ledger, tx_hash: e.txHash, at: isoUtc(Math.floor(Date.parse(e.ledgerClosedAt) / 1000)), amounts };
    });
  }
}
