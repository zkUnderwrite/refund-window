// Shapes of the files in data/seed/. All values are Simulated.

export interface TokenSeed {
  code: string;
  issuer: string;
  decimals: number;
  note: string;
}

export interface PspSeed {
  label: string;
  t0_s: number;
  arbiter_timeout_s: number;
  min_window_s: number;
  max_window_s: number;
  keeper_interval_s: number;
  pending_retry_s: number;
  sim_end_s: number;
  accounts: { admin: string; arbiter: string; fee_to: string };
  tokens: TokenSeed[];
  /** label (B07, M1, M1_PAYOUT, R01, ...) -> G address */
  addresses: Record<string, string>;
}

export interface MerchantSeed {
  id: string;
  name: string;
  address: string;
  payout: string;
  fee_bps: number;
  window_s: number;
  tokens: string[];
  express: boolean;
  tz: string;
  country: string;
  goods: string;
  return_policy: string;
  ships_within_days: number | null;
}

export interface LineItem {
  sku: string;
  name: string;
  qty: number;
  price: string;
}

export interface OrderSeed {
  n: number;
  tag?: string;
  merchant: string;
  mode: "escrow" | "express";
  ref: string;
  order_id: string;
  buyer: string;
  buyer_address: string;
  refund_to?: string;
  refund_to_address?: string;
  token: string;
  amount: string;
  window_s?: number;
  paid_at: string;
  paid_at_s: number;
  memo_hash: string;
  items: LineItem[];
}

export type EventType =
  | "pay_duplicate"
  | "refund"
  | "remove_trustline"
  | "restore_trustline"
  | "dispute"
  | "respond"
  | "resolve"
  | "withdraw_dispute"
  | "keeper_down"
  | "express_reclaim"
  | "express_claim"
  | "withdraw_fees";

export interface EventSeed {
  seq: number;
  at: string;
  at_s: number;
  type: EventType;
  actor: string;
  order_n?: number;
  ref?: string;
  /** pay_duplicate: the id computed from the re-typed reference */
  order_id?: string;
  /** "all" or a decimal amount */
  amount?: string;
  reason?: string;
  dispute?: string;
  evidence_hash?: string;
  ruling_hash?: string;
  who?: string;
  token?: string;
  until_s?: number;
  expect: string;
  note: string;
}

export interface TokenTotals {
  paid: string;
  payout: Record<string, string>;
  refunded: string;
  fees: string;
  contract_after: string;
}

export interface Expected {
  orders: number;
  escrow_orders: number;
  express_orders: number;
  states: Record<string, number>;
  refunded_outside_dispute: number;
  refunded_in_dispute: number;
  rejected: Record<string, number>;
  late_releases: number;
  untouched_releases: number;
  refund_pending: number;
  refund_settled: number;
  express: { claimed: number; reclaimed: number; claimed_amount: string; reclaimed_amount: string };
  totals: Record<string, TokenTotals>;
}
