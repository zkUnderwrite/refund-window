// Receipt building against the offline model (local-sim network and tests).
import { buildReceipt, type OrderView, type ReceiptEvent } from "../receipt.ts";
import { isoUtc } from "../duration.ts";
import { formatAmount } from "../amount.ts";
import type { Order, RefundEscrowModel } from "./model.ts";

export const SIM_PASSPHRASE = "refund-window local simulation (no network)";

export function orderView(o: Order): OrderView {
  return {
    merchant: o.merchant, payout: o.payout, buyer: o.buyer, refund_to: o.refund_to, token: o.token,
    amount: o.amount, held: o.held, refunded: o.refunded, refund_owed: o.refund_owed, released: o.released, fee: o.fee,
    fee_bps: o.fee_bps, arbiter: o.arbiter, arbiter_timeout: o.arbiter_timeout, paid_at: o.paid_at, release_at: o.release_at,
    disputed_at: o.disputed_at, resolve_by: o.resolve_by, closed_at: o.closed_at, reason: o.reason,
    buyer_evidence: o.buyer_evidence, merchant_evidence: o.merchant_evidence, ruling: o.ruling, state: o.state,
  };
}

const AMOUNT_KEYS = new Set(["amount", "refunded", "refund_owed", "refund_amount", "merchant_net", "fee"]);

/** Event data with token amounts as 7-decimal strings and times as ISO-8601. */
export function receiptAmounts(a: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (AMOUNT_KEYS.has(k)) out[k] = formatAmount(BigInt(v));
    else if (k === "resolve_by" || k === "release_at") out[k] = isoUtc(Number(v));
    else out[k] = v;
  }
  return out;
}

export function modelReceiptEvents(m: RefundEscrowModel, orderId: string): ReceiptEvent[] {
  return m
    .eventsFor(orderId)
    .map((e) => ({ type: e.type, ledger: e.ledger, tx_hash: e.tx_hash, at: isoUtc(e.at), amounts: receiptAmounts(e.amounts) }));
}

export function modelReceipt(
  m: RefundEscrowModel,
  orderId: string,
  asset: { code: string; issuer: string },
  merchantRef?: string,
) {
  const o = m.order(orderId);
  if (!o) throw new Error(`order ${orderId} not found`);
  return buildReceipt(orderView(o), {
    contract: "local-sim",
    networkPassphrase: SIM_PASSPHRASE,
    orderId,
    asset,
    ...(merchantRef !== undefined ? { merchantRef } : {}),
    events: modelReceiptEvents(m, orderId),
  });
}
