// The CLI's local index, .refundwin.json in REFUNDWIN_DIR (default: the
// working directory). It holds the contract id, enabled tokens and every order
// this installation has seen, so `release --due`, `timeout --due` and the
// keeper know which ids to look at, and `--ref` can be resolved to an id.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceItem } from "./evidence.ts";
import { normaliseRef, orderIdHex } from "./orderid.ts";

export interface IndexedOrderMeta {
  ref: string;
  merchant: string;
  token: string;
  asset: string;
  items?: unknown;
}

export interface DisputeRecord {
  reason: string;
  buyer?: { statement: string; items: EvidenceItem[]; hash: string };
  merchant?: { statement: string; items: EvidenceItem[]; hash: string };
}

export interface ExpressRecord {
  ref: string;
  buyer: string;
  merchant: string;
  asset: string;
  amount: string;
  releaseAt: number;
  createdAt: number;
  tx?: string;
  /** local-sim only */
  claimedBy?: "buyer" | "merchant";
  claimedAt?: number;
}

export interface LocalIndex {
  network: "testnet" | "local-sim";
  contractId: string;
  admin?: string;
  tokens: Record<string, { issuer?: string; id: string }>;
  merchants: Record<string, { payout: string; feeBps: number; window: number }>;
  orders: Record<string, IndexedOrderMeta>;
  disputes: Record<string, DisputeRecord>;
  express: Record<string, ExpressRecord>;
}

export function indexPath(dir: string): string {
  return join(dir, ".refundwin.json");
}

export function emptyIndex(network: "testnet" | "local-sim", contractId: string): LocalIndex {
  return { network, contractId, tokens: {}, merchants: {}, orders: {}, disputes: {}, express: {} };
}

export function loadIndex(dir: string): LocalIndex | undefined {
  const p = indexPath(dir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as LocalIndex) : undefined;
}

export function saveIndex(dir: string, idx: LocalIndex): void {
  writeFileSync(indexPath(dir), JSON.stringify(idx, null, 2) + "\n");
}

/**
 * Resolves a merchant reference to an order id. With a merchant address the id
 * is computed directly; without one, every indexed merchant is tried and the
 * match must be unique.
 */
export function findOrderId(idx: LocalIndex, ref: string, merchant?: string): string {
  if (merchant) return orderIdHex(merchant, ref);
  const n = normaliseRef(ref);
  const hits = Object.entries(idx.orders).filter(([, o]) => normaliseRef(o.ref) === n);
  if (hits.length === 1) return hits[0]![0];
  if (hits.length === 0) throw new Error(`no indexed order with reference "${ref}" (normalised ${n}); pass --merchant <G…>`);
  throw new Error(`reference "${ref}" matches ${hits.length} merchants' orders; pass --merchant <G…>`);
}
