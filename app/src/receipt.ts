// Receipts both sides can show a regulator: canonical JSON (sorted keys,
// amounts as 7-decimal strings, times as ISO-8601 UTC) built from on-chain
// order state plus the captured transaction hashes, and a sha256 digest.
// `verifyReceipt` re-reads the order and reports MATCH or the differing fields.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, digestOf } from "./canonical.ts";
import { formatAmount } from "./amount.ts";
import { isoUtc } from "./duration.ts";
import { orderIdHex } from "./orderid.ts";
import { reasonName } from "./reasons.ts";

/** Order fields as read from `order()` (bigint amounts, unix-second times). */
export interface OrderView {
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
  reason: number;
  buyer_evidence: string | null;
  merchant_evidence: string | null;
  ruling: string | null;
  state: string;
}

export interface ReceiptEvent {
  type: string;
  ledger: number;
  tx_hash: string;
  /** ISO time of the ledger, when known */
  at?: string;
  amounts: Record<string, string>;
}

export interface ReceiptContext {
  contract: string;
  networkPassphrase: string;
  orderId: string;
  asset: { code: string; issuer: string };
  merchantRef?: string;
  events: ReceiptEvent[];
}

export type Receipt = Record<string, unknown> & { digest?: string };

export function buildReceipt(o: OrderView, ctx: ReceiptContext): { receipt: Receipt; json: string; digest: string } {
  if (ctx.merchantRef !== undefined && orderIdHex(o.merchant, ctx.merchantRef) !== ctx.orderId) {
    throw new Error(`merchant_ref "${ctx.merchantRef}" does not hash to order ${ctx.orderId}`);
  }
  const t = (s: number) => (s > 0 ? isoUtc(s) : undefined);
  const body: Receipt = {
    contract: ctx.contract,
    network_passphrase: ctx.networkPassphrase,
    order_id: ctx.orderId,
    merchant_ref: ctx.merchantRef,
    merchant: o.merchant,
    payout: o.payout,
    buyer: o.buyer,
    refund_to: o.refund_to,
    asset_code: ctx.asset.code,
    asset_issuer: ctx.asset.issuer,
    amount: formatAmount(o.amount),
    fee_bps: o.fee_bps,
    window_s: o.release_at - o.paid_at,
    arbiter: o.arbiter,
    arbiter_timeout_s: o.arbiter_timeout,
    state: o.state,
    held: formatAmount(o.held),
    refunded: formatAmount(o.refunded),
    refund_owed: formatAmount(o.refund_owed),
    released: formatAmount(o.released),
    fee: formatAmount(o.fee),
    paid_at: isoUtc(o.paid_at),
    release_at: isoUtc(o.release_at),
    disputed_at: t(o.disputed_at),
    resolve_by: t(o.resolve_by),
    closed_at: t(o.closed_at),
    reason: o.reason ? reasonName(o.reason) : undefined,
    buyer_evidence: o.buyer_evidence ?? undefined,
    merchant_evidence: o.merchant_evidence ?? undefined,
    ruling: o.ruling ?? undefined,
    events: [...ctx.events].sort((a, b) => a.ledger - b.ledger),
  };
  const json = canonicalJson(body);
  const digest = digestOf(body);
  return { receipt: { ...(JSON.parse(json) as Receipt), digest }, json, digest };
}

/** Recomputes the digest of a stored receipt (the `digest` field excluded). */
export function receiptDigest(r: Receipt): string {
  const { digest: _d, ...body } = r;
  void _d;
  return digestOf(body);
}

export interface VerifyReport {
  status: "MATCH" | "MISMATCH";
  digestOk: boolean;
  differences: { field: string; receipt: unknown; chain: unknown }[];
  txChecks: { tx_hash: string; result: "found" | "missing" | "not re-checkable via RPC; use an archive provider" }[];
}

export interface VerifyDeps {
  /** Re-reads the order through RPC (or the model). */
  readOrder: () => Promise<OrderView | undefined>;
  /** Looks a tx hash up; returns undefined when outside RPC retention. */
  lookupTx?: (hash: string) => Promise<"found" | "missing" | undefined>;
  /** Oldest ledger RPC still serves (7 days of history, 01-§3). */
  oldestLedger?: number;
}

const COMPARED = [
  "merchant", "payout", "buyer", "refund_to", "amount", "fee_bps", "window_s", "arbiter", "arbiter_timeout_s", "state",
  "held", "refunded", "refund_owed", "released", "fee", "paid_at", "release_at", "disputed_at", "resolve_by", "closed_at",
  "reason", "buyer_evidence", "merchant_evidence", "ruling",
] as const;

export async function verifyReceipt(stored: Receipt, deps: VerifyDeps): Promise<VerifyReport> {
  const digestOk = stored.digest === undefined || receiptDigest(stored) === stored.digest;
  const o = await deps.readOrder();
  const differences: VerifyReport["differences"] = [];
  if (!o) {
    differences.push({ field: "order", receipt: stored.order_id, chain: null });
  } else {
    const fresh = buildReceipt(o, {
      contract: String(stored.contract),
      networkPassphrase: String(stored.network_passphrase),
      orderId: String(stored.order_id),
      asset: { code: String(stored.asset_code), issuer: String(stored.asset_issuer) },
      events: (stored.events as ReceiptEvent[]) ?? [],
    }).receipt;
    for (const f of COMPARED) {
      if (JSON.stringify(stored[f]) !== JSON.stringify(fresh[f])) {
        differences.push({ field: f, receipt: stored[f], chain: fresh[f] });
      }
    }
  }
  const txChecks: VerifyReport["txChecks"] = [];
  for (const ev of (stored.events as ReceiptEvent[]) ?? []) {
    if (deps.oldestLedger !== undefined && ev.ledger < deps.oldestLedger) {
      txChecks.push({ tx_hash: ev.tx_hash, result: "not re-checkable via RPC; use an archive provider" });
      continue;
    }
    const r = deps.lookupTx ? await deps.lookupTx(ev.tx_hash) : undefined;
    txChecks.push({ tx_hash: ev.tx_hash, result: r ?? "not re-checkable via RPC; use an archive provider" });
  }
  const status = digestOk && differences.length === 0 && txChecks.every((t) => t.result !== "missing") ? "MATCH" : "MISMATCH";
  return { status, digestOk, differences, txChecks };
}

// ---------------------------------------------------------------------------
// Local receipt cache: ~/.refundwin/receipts/<order_id>.json (REFUNDWIN_HOME
// overrides the base directory). Each CLI action appends its tx hash so a
// receipt outlives RPC's 7-day retention.
// ---------------------------------------------------------------------------

export function cacheDir(): string {
  return join(process.env.REFUNDWIN_HOME ?? join(homedir(), ".refundwin"), "receipts");
}

export function appendTx(
  orderId: string,
  entry: { type: string; tx_hash: string; ledger?: number; at?: string; amounts?: Record<string, string> },
): void {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${orderId}.json`);
  const cur = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { txs: unknown[] }) : { txs: [] };
  cur.txs.push(entry);
  writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

export function canonicalReceiptJson(r: Receipt): string {
  return canonicalJson(r);
}
