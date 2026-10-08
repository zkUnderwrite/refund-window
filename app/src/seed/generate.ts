// Deterministic seed generator. Writes data/seed/* and
// contracts/refund_escrow/src/test_seed.rs from a fixed PRNG seed, then runs
// the offline simulator to derive expected.json and the call schedule that the
// Rust scenario test replays. Everything here is Simulated data.
//
// Design targets (from the specification) are asserted before anything is
// written: 50 orders (M1: 24 escrow + 6 express, M2: 20 escrow), 41 buyers,
// 38 Released, 4 Refunded (1 inside a dispute), 1 Resolved, 1 TimedOut,
// 4 late releases during a 26 h keeper outage, 5 express claims, 1 reclaim.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Prng } from "./prng.ts";
import { parseAmount, formatAmount } from "../amount.ts";
import { feeFor } from "../fee.ts";
import { normaliseRef, orderIdHex, sha256Hex } from "../orderid.ts";
import { isoUtc } from "../duration.ts";
import { manifestHash, parseCarrierCsv, latestStatus, type EvidenceItem } from "../evidence.ts";
import { canonicalJson } from "../canonical.ts";
import { runSimulation, type ScheduledCall } from "../sim/simulate.ts";
import type { EventSeed, Expected, LineItem, MerchantSeed, OrderSeed, PspSeed } from "./types.ts";

export const SEED = 20_260_924;
export const T0 = 1_788_220_800; // 2026-09-01T00:00:00Z
const DAY = 86_400;
const HOUR = 3_600;

export const DESIGN = {
  orders: 50,
  escrow: 44,
  express: 6,
  states: { Released: 38, Refunded: 4, Resolved: 1, TimedOut: 1 },
  refunded_outside_dispute: 3,
  refunded_in_dispute: 1,
  rejected: { DuplicateOrder: 1, WindowClosed: 1 },
  late_releases: 4,
  untouched_releases: 35,
  refund_pending: 1,
  refund_settled: 1,
  express_claimed: 5,
  express_reclaimed: 1,
} as const;

function at(day: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return T0 + day * DAY + h * HOUR + m * 60;
}

/** Deterministic, clearly synthetic keypair per label. */
export function seedAddress(label: string): string {
  const raw = createHash("sha256").update(`refund-window/seed/v1/${label}`).digest();
  return Keypair.fromRawEd25519Seed(raw).publicKey();
}

const placeholder = (label: string) => sha256Hex(`placeholder evidence file (not included): ${label}`);

// ---------------------------------------------------------------------------
// Catalogues (Simulated). Spelling kept as merchants typed it.
// ---------------------------------------------------------------------------

const M1_ITEMS: [string, string, string][] = [
  ["ALB-JAG-M", "Alebrije jaguar (mediano)", "39.99"],
  ["ALB-COL-S", "Alebrije colibri (smal)", "18.50"],
  ["REB-SED", "Rebozo de seda", "54.10"],
  ["TAZ-BN6", "Juego de 6 tazas barro negro", "74.60"],
  ["HUI-M", "Huipil bordado talla M", "37.80"],
  ["SEP-BOR5", "Separador de libros bordado x5", "12.5"],
  ["CAT-TAL", "Catrina de talavera", "46.00"],
  ["MOL-OAX", "Mole negro oaxaqueño 500g ", "11.25"],
  ["TAP-60", "Tapete zapoteco 60x90", "120"],
  ["COP-MEZ", "Copitas mezcaleras (4)", "23.90"],
  ["BOL-PAL", "Bolsa de palma tejida", "27.00"],
];
const M1_SHIP: LineItem = { sku: "SHIP-INT", name: "Envio internacional", qty: 1, price: "9.90" };
const M2_ITEMS: [string, string, string][] = [
  ["TPL-BUD", "Notion budget template", "9.99"],
  ["TPL-WED", "Canva wedding invite pack", "14.50"],
  ["TPL-CV", "CV template bundle (3 designs)", "6.00"],
  ["CRS-AFB", "Intro to Afrobeats production - lifetime access", "19.99"],
  ["CRS-XLS", "Excel for small shops (course)", "24.00"],
  ["TPL-IG", "Instagram carousel templates x30", "12.00"],
  ["TPL-INV", "Invoice + quote template kit", "4.99"],
  ["CRS-PHO", "Phone photography mini-course", "29.00"],
];

interface Plan {
  tag?: string;
  merchant: "M1" | "M2";
  mode: "escrow" | "express";
  token: string;
  amount?: string;
  items?: LineItem[];
  paid_at: number;
  window_s?: number;
  refund_to?: string;
}

function itemsFor(merchant: "M1" | "M2", rng: Prng, token: string): { items: LineItem[]; amount: string } {
  const cat = merchant === "M1" ? M1_ITEMS : M2_ITEMS;
  const k = merchant === "M1" ? rng.int(1, 3) : rng.int(1, 2);
  const picked = rng.shuffle([...cat]).slice(0, k);
  const items: LineItem[] = picked.map(([sku, name, price]) => ({ sku, name, qty: rng.int(1, merchant === "M1" ? 2 : 1), price }));
  if (merchant === "M1" && rng.next() < 0.8) items.push({ ...M1_SHIP, price: token === "EURC" ? "8.90" : "9.90" });
  let total = 0n;
  for (const i of items) total += parseAmount(i.price) * BigInt(i.qty);
  // Messy formatting: sometimes "34.5", sometimes "34.50", sometimes "120".
  const s = formatAmount(total).replace(/0+$/, "").replace(/\.$/, "");
  const amount = rng.next() < 0.5 && s.includes(".") && s.split(".")[1]!.length === 1 ? `${s}0` : s;
  return { items, amount };
}

export interface GenerateOptions {
  /** project root (the directory holding data/ and contracts/) */
  root: string;
  write?: boolean;
}

export interface GenerateResult {
  psp: PspSeed;
  merchants: MerchantSeed[];
  orders: OrderSeed[];
  events: EventSeed[];
  expected: Expected;
  schedule: ScheduledCall[];
  files: string[];
}

export async function generateSeed(opts: GenerateOptions): Promise<GenerateResult> {
  const rng = new Prng(SEED);
  const A = (label: string) => seedAddress(label);

  // -- PSP and merchants ---------------------------------------------------
  const tokens = ["USDC", "EURC", "PYUSD"].map((code) => ({
    code,
    issuer: A(`ISSUER_${code}`),
    decimals: 7,
    note: `self-issued test asset named ${code}; NOT real ${code}`,
  }));
  const addresses: Record<string, string> = {};
  const label = (l: string) => (addresses[l] = A(l));
  for (const l of ["ADMIN", "ARBITER", "FEE_TO", "M1", "M1_PAYOUT", "M2", "M2_PAYOUT", "R01"]) label(l);
  for (let i = 1; i <= 41; i++) label(`B${String(i).padStart(2, "0")}`);

  const psp: PspSeed = {
    label: "Simulated PSP (not a real company)",
    t0_s: T0,
    arbiter_timeout_s: 7 * DAY,
    min_window_s: HOUR,
    max_window_s: 60 * DAY,
    keeper_interval_s: 600,
    pending_retry_s: HOUR,
    sim_end_s: T0 + 46 * DAY,
    accounts: { admin: addresses.ADMIN!, arbiter: addresses.ARBITER!, fee_to: addresses.FEE_TO! },
    tokens,
    addresses,
  };
  const merchants: MerchantSeed[] = [
    {
      id: "M1",
      name: "Simulated: handicraft exporter, Oaxaca (MX), ships to US and EU buyers",
      address: addresses.M1!,
      payout: addresses.M1_PAYOUT!,
      fee_bps: 150,
      window_s: 14 * DAY,
      tokens: ["USDC", "EURC"],
      express: true,
      tz: "-06:00",
      country: "MX",
      goods: "physical",
      return_policy: "Returns accepted within 14 days of delivery if the item is damaged or not as pictured. Buyer pays return shipping unless the item is damaged.",
      ships_within_days: 5,
    },
    {
      id: "M2",
      name: "Simulated: digital goods seller (templates, course access), Lagos (NG)",
      address: addresses.M2!,
      payout: addresses.M2_PAYOUT!,
      fee_bps: 125,
      window_s: 3 * DAY,
      tokens: ["USDC", "PYUSD"],
      express: false,
      tz: "+01:00",
      country: "NG",
      goods: "digital",
      return_policy: "Refund if you cannot access the download or course within 48 hours of purchase. No refunds after files are downloaded.",
      ships_within_days: null,
    },
  ];

  // -- order plans ------------------------------------------------------------
  const plans: Plan[] = [];
  const P = (p: Plan) => plans.push(p);
  // M1 escrow specials
  P({ tag: "A1", merchant: "M1", mode: "escrow", token: "USDC", amount: "49.99", paid_at: at(1, "14:23"), refund_to: "R01",
    items: [{ sku: "ALB-JAG-M", name: "Alebrije jaguar (mediano)", qty: 1, price: "39.99" }, { ...M1_SHIP, price: "10.00" }] });
  P({ tag: "D1", merchant: "M1", mode: "escrow", token: "USDC", amount: "64.00", paid_at: at(2, "19:07"),
    items: [{ sku: "REB-SED", name: "Rebozo de seda", qty: 1, price: "54.10" }, M1_SHIP] });
  P({ tag: "A2", merchant: "M1", mode: "escrow", token: "USDC", amount: "120", paid_at: at(3, "16:41"),
    items: [{ sku: "TAP-60", name: "Tapete zapoteco 60x90", qty: 1, price: "120" }] });
  P({ tag: "A3", merchant: "M1", mode: "escrow", token: "USDC", amount: "84.50", paid_at: at(4, "08:12"),
    items: [{ sku: "TAZ-BN6", name: "Juego de 6 tazas barro negro", qty: 1, price: "74.60" }, M1_SHIP] });
  P({ tag: "D3", merchant: "M1", mode: "escrow", token: "EURC", amount: "37.80", paid_at: at(5, "11:52"),
    items: [{ sku: "HUI-M", name: "Huipil bordado talla M", qty: 1, price: "37.80" }] });
  P({ tag: "DUP", merchant: "M1", mode: "escrow", token: "USDC", paid_at: at(8, "13:02") });
  P({ tag: "EURC12", merchant: "M1", mode: "escrow", token: "EURC", amount: "12.5", paid_at: at(9, "15:40"),
    items: [{ sku: "SEP-BOR5", name: "Separador de libros bordado x5", qty: 1, price: "12.5" }] });
  P({ tag: "OUTLIER", merchant: "M1", mode: "escrow", token: "USDC", amount: "1999.00", paid_at: at(17, "10:26"),
    items: [{ sku: "B2B-ALB40", name: "Wholesale lot: 40 alebrijes (B2B)", qty: 1, price: "1999.00" }] });
  P({ tag: "WIN7", merchant: "M1", mode: "escrow", token: "USDC", paid_at: at(21, "09:00"), window_s: 7 * DAY });
  // M1 plain escrow: 2 EURC + 13 USDC
  const m1Plain = ["EURC", "EURC", ...Array(13).fill("USDC")] as string[];
  for (const token of m1Plain) {
    P({ merchant: "M1", mode: "escrow", token, paid_at: at(rng.int(0, 29), `${rng.int(0, 23)}:${String(rng.int(0, 59)).padStart(2, "0")}`) });
  }
  // M1 express: 6 USDC pre-orders
  for (let i = 1; i <= 6; i++) {
    P({ tag: `E${i}`, merchant: "M1", mode: "express", token: "USDC", paid_at: at(rng.int(0, 29), `${rng.int(8, 22)}:${String(rng.int(0, 59)).padStart(2, "0")}`) });
  }
  // M2 specials
  P({ tag: "O1", merchant: "M2", mode: "escrow", token: "USDC", paid_at: at(6, "07:15") });
  P({ tag: "O2", merchant: "M2", mode: "escrow", token: "USDC", paid_at: at(6, "13:48") });
  P({ tag: "L1", merchant: "M2", mode: "escrow", token: "USDC", amount: "9.99", paid_at: at(6, "21:30"),
    items: [{ sku: "TPL-BUD", name: "Notion budget template", qty: 1, price: "9.99" }] });
  P({ tag: "O3", merchant: "M2", mode: "escrow", token: "USDC", paid_at: at(7, "02:05") });
  P({ tag: "B1", merchant: "M2", mode: "escrow", token: "USDC", amount: "15.00", paid_at: at(11, "07:30"),
    items: [{ sku: "TPL-WED", name: "Canva wedding invite pack", qty: 1, price: "14.50" }, { sku: "FX-ADJ", name: "rounding", qty: 1, price: "0.50" }] });
  P({ tag: "DUST", merchant: "M2", mode: "escrow", token: "USDC", amount: "0.0000050", paid_at: at(12, "03:17"),
    items: [{ sku: "TEST", name: "wallet test charge", qty: 1, price: "0.0000050" }] });
  P({ tag: "B2", merchant: "M2", mode: "escrow", token: "USDC", amount: "19.99", paid_at: at(13, "20:45"),
    items: [{ sku: "CRS-AFB", name: "Intro to Afrobeats production - lifetime access", qty: 1, price: "19.99" }] });
  P({ tag: "PY1", merchant: "M2", mode: "escrow", token: "PYUSD", amount: "7.3333333", paid_at: at(18, "22:02"),
    items: [{ sku: "TPL-IG", name: "Instagram carousel templates x30 (1/3 share of a split bundle)", qty: 1, price: "7.3333333" }] });
  P({ tag: "D2", merchant: "M2", mode: "escrow", token: "USDC", amount: "29.00", paid_at: at(20, "18:00"),
    items: [{ sku: "CRS-PHO", name: "Phone photography mini-course", qty: 1, price: "29.00" }] });
  P({ tag: "PY2", merchant: "M2", mode: "escrow", token: "PYUSD", amount: "22.5", paid_at: at(24, "11:11"),
    items: [{ sku: "CRS-XLS", name: "Excel for small shops (course)", qty: 1, price: "22.5" }] });
  // M2 plain: 10 USDC, never paid inside [day 6 06:00, day 7 08:00) so no
  // other release lands in the keeper outage
  for (let i = 0; i < 10; i++) {
    let t: number;
    do {
      t = at(rng.int(0, 29), `${rng.int(0, 23)}:${String(rng.int(0, 59)).padStart(2, "0")}`);
    } while (t >= at(6, "06:00") && t < at(7, "08:00"));
    P({ merchant: "M2", mode: "escrow", token: "USDC", paid_at: t });
  }

  // amounts and items for plain orders
  for (const p of plans) {
    if (!p.amount) {
      const { items, amount } = itemsFor(p.merchant, rng, p.token);
      p.items = items;
      p.amount = amount;
    }
  }
  // chronological, stable
  plans.sort((a, b) => a.paid_at - b.paid_at || (a.tag ?? "").localeCompare(b.tag ?? ""));

  // -- buyers: B01-B03 place 4 orders each, B04-B41 one each ---------------
  const slots: string[] = [];
  for (const b of ["B01", "B02", "B03"]) slots.push(b, b, b, b);
  for (let i = 4; i <= 41; i++) slots.push(`B${String(i).padStart(2, "0")}`);
  rng.shuffle(slots);
  const repeat = new Set(["B01", "B02", "B03"]);
  const a2 = plans.findIndex((p) => p.tag === "A2");
  if (repeat.has(slots[a2]!)) {
    const j = slots.findIndex((s, i) => !repeat.has(s) && i !== a2);
    [slots[a2], slots[j]] = [slots[j]!, slots[a2]!];
  }

  // -- refs ----------------------------------------------------------------
  const refFormats: Record<string, ((n: string) => string)[]> = {
    M1: [(n) => `ORD-${n}`, (n) => `ORD-${n}`, (n) => `ord ${n}`, (n) => `#${n}`, (n) => `ORD${n} `],
    M2: [(n) => `TPL-0${n}`, (n) => `tpl 0${n}`, (n) => `#TPL0${n}`, (n) => `TPL0${n} `],
  };
  const counters: Record<string, number> = { M1: 1031, M2: 301 };
  const orders: OrderSeed[] = plans.map((p, i) => {
    const m = merchants.find((x) => x.id === p.merchant)!;
    const num = String(counters[p.merchant]!++);
    const ref = p.tag === "DUP" ? `ORD-${num}` : rng.pick(refFormats[p.merchant]!)(num);
    const buyer = slots[i]!;
    const items = p.items!;
    const memo = sha256Hex(canonicalJson({ ref: normaliseRef(ref), items }));
    const o: OrderSeed = {
      n: i + 1,
      ...(p.tag ? { tag: p.tag } : {}),
      merchant: p.merchant,
      mode: p.mode,
      ref,
      order_id: orderIdHex(m.address, ref),
      buyer,
      buyer_address: addresses[buyer]!,
      ...(p.refund_to ? { refund_to: p.refund_to, refund_to_address: addresses[p.refund_to]! } : {}),
      token: p.token,
      amount: p.amount!,
      ...(p.window_s ? { window_s: p.window_s } : {}),
      paid_at: isoUtc(p.paid_at),
      paid_at_s: p.paid_at,
      memo_hash: memo,
      items,
    };
    return o;
  });
  const byTag = (t: string) => orders.find((o) => o.tag === t)!;

  // -- disputes (off-chain files) -------------------------------------------
  const disputes = buildDisputes(byTag, merchants);

  // -- events ----------------------------------------------------------------
  const raw: Omit<EventSeed, "seq" | "at">[] = [];
  const E = (e: Omit<EventSeed, "seq" | "at">) => raw.push(e);
  const dup = byTag("DUP");
  const dupRef = dup.ref.replace(/^ORD-/, "ord ");
  E({ at_s: dup.paid_at_s + 180, type: "pay_duplicate", actor: dup.buyer, order_n: dup.n, ref: dupRef,
    order_id: orderIdHex(addresses.M1!, dupRef), amount: dup.amount, expect: "DuplicateOrder",
    note: "checkout page reloaded; the buyer re-typed the reference in another format; same normalised id" });
  const a1 = byTag("A1");
  E({ at_s: at(3, "10:05"), type: "refund", actor: "M1", order_n: a1.n, amount: "all", expect: "ok",
    note: "buyer cancelled before shipping; refund can only reach the separate refund address R01 that signed pay" });
  const a2o = byTag("A2");
  E({ at_s: at(4, "09:00"), type: "remove_trustline", actor: a2o.buyer, who: a2o.buyer, token: "USDC", expect: "ok",
    note: "buyer removed the USDC trustline while cleaning up the wallet" });
  E({ at_s: at(4, "11:30"), type: "refund", actor: "M1", order_n: a2o.n, amount: "all", expect: "ok",
    note: "rug arrived with the wrong colour; full refund goes refund_pending (no trustline)" });
  E({ at_s: at(6, "11:30"), type: "restore_trustline", actor: a2o.buyer, who: a2o.buyer, token: "USDC", expect: "ok",
    note: "trustline restored on day +2; the keeper's next hourly retry settles the refund" });
  const a3 = byTag("A3");
  E({ at_s: at(8, "15:00"), type: "refund", actor: "M1", order_n: a3.n, amount: "25.35", expect: "ok",
    note: "30% partial refund: one of six cups arrived chipped; remainder released at T" });
  E({ at_s: at(9, "06:00"), type: "keeper_down", actor: "PSP", until_s: at(10, "08:00"), expect: "ok",
    note: "keeper host down for 26 h (disk full); releases are delayed, not lost" });
  const l1 = byTag("L1");
  E({ at_s: l1.paid_at_s + 3 * DAY + 2 * HOUR, type: "dispute", actor: l1.buyer, order_n: l1.n, reason: "DIGITAL_NOT_DELIVERED",
    evidence_hash: placeholder("L1 late dispute statement"), expect: "WindowClosed",
    note: "late dispute at T+2h: rejected by the contract; the order is released when the keeper returns" });
  const b1 = byTag("B1");
  E({ at_s: at(11, "09:10"), type: "refund", actor: "M2", order_n: b1.n, amount: "all", expect: "ok",
    note: "buyer bought the same invite pack twice (second tab)" });
  const d1 = byTag("D1");
  E({ at_s: at(12, "09:40"), type: "dispute", actor: d1.buyer, order_n: d1.n, reason: "NOT_RECEIVED", dispute: "D1",
    evidence_hash: disputes.D1.buyerHash, expect: "ok", note: "rebozo not received 10 days after payment" });
  E({ at_s: at(13, "16:20"), type: "respond", actor: "M1", order_n: d1.n, dispute: "D1",
    evidence_hash: disputes.D1.merchantHash, expect: "ok", note: "merchant uploads carrier tracking (shows in transit)" });
  const b2 = byTag("B2");
  E({ at_s: at(14, "10:00"), type: "refund", actor: "M2", order_n: b2.n, amount: "5.00", expect: "ok",
    note: "module 4 videos missing; merchant refunds 5.00 of 19.99, rest released at T" });
  const d3 = byTag("D3");
  E({ at_s: at(15, "10:00"), type: "dispute", actor: d3.buyer, order_n: d3.n, reason: "NOT_RECEIVED", dispute: "D3",
    evidence_hash: disputes.D3.buyerHash, expect: "ok", note: "huipil not received" });
  E({ at_s: at(16, "12:35"), type: "respond", actor: "M1", order_n: d3.n, dispute: "D3",
    evidence_hash: disputes.D3.merchantHash, expect: "ok", note: "merchant uploads a shipping receipt with the wrong tracking number" });
  E({ at_s: at(16, "09:40"), type: "resolve", actor: "ARBITER", order_n: d1.n, dispute: "D1", amount: "25.60",
    ruling_hash: disputes.D1.rulingHash, expect: "ok", note: "arbiter rules on day +4 of the dispute: 40% refund" });
  const d2 = byTag("D2");
  E({ at_s: at(21, "09:15"), type: "dispute", actor: d2.buyer, order_n: d2.n, reason: "DIGITAL_NOT_DELIVERED", dispute: "D2",
    evidence_hash: disputes.D2.buyerHash, expect: "ok", note: "course login link never worked" });
  E({ at_s: at(21, "16:05"), type: "respond", actor: "M2", order_n: d2.n, dispute: "D2",
    evidence_hash: disputes.D2.merchantHash, expect: "ok", note: "merchant exports its access log: no login for this buyer" });
  E({ at_s: at(21, "17:40"), type: "refund", actor: "M2", order_n: d2.n, amount: "all", expect: "ok",
    note: "merchant refunds in full during the dispute" });
  // express
  const exp = orders.filter((o) => o.mode === "express");
  const m1w = merchants[0]!.window_s;
  exp.forEach((o, i) => {
    const T = o.paid_at_s + (o.window_s ?? m1w);
    if (i === exp.length - 1) {
      E({ at_s: o.paid_at_s + 5 * DAY, type: "express_reclaim", actor: o.buyer, order_n: o.n, expect: "ok",
        note: "pre-order cancelled: buyer reclaims before T" });
    } else {
      if (i === 1) {
        E({ at_s: T - 6 * HOUR, type: "express_claim", actor: "M1", order_n: o.n, expect: "CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM",
          note: "merchant tries to claim 6 h early; the predicate refuses" });
      }
      E({ at_s: T + rng.int(2, 30) * HOUR, type: "express_claim", actor: "M1", order_n: o.n, expect: "ok",
        note: "merchant claims after T" });
    }
  });
  for (const token of ["USDC", "EURC", "PYUSD"]) {
    E({ at_s: T0 + 45 * DAY + 12 * HOUR, type: "withdraw_fees", actor: "ADMIN", token, expect: "ok",
      note: "PSP withdraws accrued fees at the end of the period" });
  }
  raw.sort((a, b) => a.at_s - b.at_s);
  const events: EventSeed[] = raw.map((e, i) => ({ seq: i + 1, at: isoUtc(e.at_s), ...e }));

  // -- simulate and check the design --------------------------------------
  const sim = await runSimulation({ psp, merchants, orders, events });
  const x = sim.expected;
  const want = DESIGN;
  const check = (name: string, got: unknown, exp: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(exp)) {
      throw new Error(`seed design check failed: ${name} = ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`);
    }
  };
  check("orders", x.orders, want.orders);
  check("escrow", x.escrow_orders, want.escrow);
  check("express", x.express_orders, want.express);
  check("states", sortObj(x.states), sortObj(want.states));
  check("refunded_outside_dispute", x.refunded_outside_dispute, want.refunded_outside_dispute);
  check("refunded_in_dispute", x.refunded_in_dispute, want.refunded_in_dispute);
  check("rejected", sortObj(x.rejected), sortObj(want.rejected));
  check("late_releases", x.late_releases, want.late_releases);
  check("untouched_releases", x.untouched_releases, want.untouched_releases);
  check("refund_pending", x.refund_pending, want.refund_pending);
  check("refund_settled", x.refund_settled, want.refund_settled);
  check("express claimed", x.express.claimed, want.express_claimed);
  check("express reclaimed", x.express.reclaimed, want.express_reclaimed);
  check("buyers", new Set(orders.map((o) => o.buyer)).size, 41);
  check("multi-order buyers", [...countBy(orders.map((o) => o.buyer)).values()].filter((c) => c > 1).length, 3);
  check("tokens", sortObj(Object.fromEntries(countBy(orders.map((o) => o.token)))), { EURC: 4, PYUSD: 2, USDC: 44 });
  for (const t of Object.values(x.totals)) check("contract drained", t.contract_after, "0.0000000");

  // -- write -------------------------------------------------------------
  const files: string[] = [];
  if (opts.write ?? true) {
    const dataDir = join(opts.root, "data", "seed");
    const w = (rel: string, content: string) => {
      const p = join(dataDir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      files.push(p);
    };
    const pretty = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
    w("psp.json", pretty(psp));
    w("merchants.json", pretty(merchants));
    w("orders.jsonl", orders.map((o) => JSON.stringify(o)).join("\n") + "\n");
    w("events.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    w("expected.json", pretty(x));
    w("fee-vectors.json", pretty(feeVectors()));
    w("orderid-vectors.json", pretty(orderIdVectors(addresses.M1!, addresses.M2!)));
    for (const [id, d] of Object.entries(disputes)) {
      for (const [name, content] of Object.entries(d.files)) w(`disputes/${id}/${name}`, content);
    }
    const rs = rustSeed(psp, merchants, orders, sim.outcomes, sim.schedule, x, addresses);
    const rsPath = join(opts.root, "contracts", "refund_escrow", "src", "test_seed.rs");
    writeFileSync(rsPath, rs);
    files.push(rsPath);
  }
  return { psp, merchants, orders, events, expected: x, schedule: sim.schedule, files };
}

function sortObj<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function countBy(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------------------
// Shared vectors
// ---------------------------------------------------------------------------

export function feeVectors(): { amount: string; fee_bps: number; fee: string; note: string }[] {
  const v: [bigint, number, string][] = [
    [1n, 150, "1 stroop at 150 bps"],
    [10_000_000n, 150, "1 unit at 150 bps"],
    [33_333_333n, 125, "3.3333333 at 125 bps (floor)"],
    [50n, 150, "0.0000050 dust order at 150 bps"],
    [50n, 125, "0.0000050 dust order at 125 bps"],
    [1n, 1_000, "merchant share of 1 stroop at the max fee"],
    [499_900_000n, 150, "49.99 at 150 bps"],
    [73_333_333n, 125, "7.3333333 at 125 bps"],
    [19_990_000_000n, 150, "1999.00 at 150 bps"],
    [1_000_000_000_000_000n, 1_000, "MAX_AMOUNT at 1000 bps (no overflow)"],
    [66n, 150, "66 stroops: 0.99 floors to 0"],
    [67n, 150, "67 stroops: 1.005 floors to 1"],
  ];
  return v.map(([amount, bps, note]) => ({ amount: amount.toString(), fee_bps: bps, fee: feeFor(amount, bps).toString(), note }));
}

export function orderIdVectors(m1: string, m2: string): { merchant: string; ref: string; normalised: string; order_id: string }[] {
  const refs: [string, string][] = [
    [m1, "ORD-1044"],
    [m1, "ord 1044"],
    [m1, "#ORD1044"],
    [m1, "  ORD1044 "],
    [m1, "#1045"],
    [m1, "ORD1046 "],
    [m2, "TPL-0301"],
    [m2, "tpl 0301"],
    [m2, "#tpl-0301"],
    [m2, "Tpl\t0302"],
  ];
  return refs.map(([merchant, ref]) => ({ merchant, ref, normalised: normaliseRef(ref), order_id: orderIdHex(merchant, ref) }));
}

// ---------------------------------------------------------------------------
// Dispute folders
// ---------------------------------------------------------------------------

interface DisputeFiles {
  buyerHash: string;
  merchantHash: string;
  rulingHash: string;
  files: Record<string, string>;
}

function llmMessage(text: string, id: string): string {
  return (
    JSON.stringify(
      {
        _note: "Recorded-format fixture written for offline tests (Anthropic Messages API response shape). Not a live model output.",
        id,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1800, output_tokens: 420 },
      },
      null,
      2,
    ) + "\n"
  );
}

function buildDisputes(byTag: (t: string) => OrderSeed, merchants: MerchantSeed[]): Record<"D1" | "D2" | "D3", DisputeFiles> {
  void merchants;
  const out = {} as Record<"D1" | "D2" | "D3", DisputeFiles>;

  // D1: NOT_RECEIVED, buyer writes in Spanish, merchant tracking shows "in transit".
  {
    const o = byTag("D1");
    const buyerStatement =
      "Hola, pagué el rebozo de seda el 3 de septiembre y hasta hoy no ha llegado. " +
      "El vendedor me dijo por WhatsApp que ya lo había enviado, pero el número de guía no muestra movimiento desde hace una semana. " +
      "Pido el reembolso completo de 64.00 USDC. Mi dirección de entrega es la misma del pedido.\n";
    const merchantStatement =
      "The rebozo shipped on 2026-09-04 with Estafeta international. Customs in Memphis held it for inspection; " +
      "tracking shows it in transit. We think it will arrive within a week and ask the arbiter to wait for delivery.\n";
    const csv =
      "tracking_no,carrier,status,date,time,location\n" +
      "EST7734410298MX,Estafeta,label created,2026-09-04,10:12,Oaxaca MX\n" +
      "EST7734410298MX,Estafeta,picked up,04/09/2026,17:40,Oaxaca MX\n" +
      "EST7734410298MX,Estafeta,in transit,2026-09-06,03:15,Ciudad de Mexico MX\n" +
      "EST7734410298MX,Estafeta,held by customs,08/09/2026,22:05,Memphis TN US\n" +
      "EST7734410298MX,Estafeta,in transit,2026-09-11,14:30,Memphis TN US\n";
    const status = latestStatus(parseCarrierCsv(csv));
    const buyerEv: EvidenceItem[] = [
      { name: "buyer-statement.txt", kind: "statement", sha256: sha256Hex(buyerStatement), submittedAt: isoUtc(at(12, "09:40")) },
      { name: "whatsapp-2026-09-10.png", kind: "chat", sha256: placeholder("D1 whatsapp screenshot"), note: "chat where the merchant says it shipped", submittedAt: isoUtc(at(12, "09:40")) },
    ];
    const merchantEv: EvidenceItem[] = [
      { name: "merchant-statement.txt", kind: "statement", sha256: sha256Hex(merchantStatement), submittedAt: isoUtc(at(13, "16:20")) },
      { name: "carrier-status.csv", kind: "tracking", sha256: sha256Hex(csv), submittedAt: isoUtc(at(13, "16:20")), extracted: { ...status, deliveryAddressMatches: true } },
      { name: "factura-1033.pdf", kind: "invoice", sha256: placeholder("D1 invoice"), submittedAt: isoUtc(at(13, "16:20")) },
    ];
    const ruling =
      `# Ruling D1 (order ${o.ref.trim()})\n\nReason: NOT_RECEIVED. Tracking shows the parcel held by customs and in transit, not delivered, ` +
      "eight days after the expected delivery. The merchant shipped in time and the delay is at customs. " +
      "Split: 25.60 USDC (40%) to the buyer's refund address now; the rest to the merchant. The buyer keeps the rebozo if it arrives.\n";
    out.D1 = {
      buyerHash: manifestHash(buyerEv),
      merchantHash: manifestHash(merchantEv),
      rulingHash: sha256Hex(ruling),
      files: {
        "dispute.json": JSON.stringify({ id: "D1", order_n: o.n, order_ref: o.ref, reason: "NOT_RECEIVED", buyer_lang: "es" }, null, 2) + "\n",
        "buyer-statement.txt": buyerStatement,
        "merchant-statement.txt": merchantStatement,
        "carrier-status.csv": csv,
        "buyer-evidence.json": JSON.stringify(buyerEv, null, 2) + "\n",
        "merchant-evidence.json": JSON.stringify(merchantEv, null, 2) + "\n",
        "ruling.md": ruling,
        "llm-response.json": llmMessage(
          JSON.stringify({
            summary:
              "The buyer paid 64.00 USDC for a silk rebozo and says it has not arrived. The merchant's carrier file shows the parcel held by customs in Memphis and last marked in transit on 2026-09-11. No delivery scan exists. The buyer's evidence is a chat screenshot; the merchant provided tracking and an invoice.",
            claims: {
              buyer: ["Paid on 2026-09-03 and the item has not arrived.", "The merchant said on WhatsApp that it had shipped."],
              merchant: ["Shipped on 2026-09-04 with Estafeta.", "The parcel is held by customs and still in transit."],
            },
            questions: {
              buyer: ["Has the carrier contacted you about customs duties or paperwork?"],
              merchant: ["Did you declare the parcel value and contents for customs?", "Can you open a trace request with Estafeta?"],
            },
            inconsistencies: ["The buyer says there has been no movement for a week, but the carrier shows a customs event on 2026-09-08."],
            checklist_additions: [
              { item: "Customs declaration or hold notice", whyForReason: "Explains the delay for a parcel held by customs", provided: "none" },
            ],
          }),
          "msg_fixture_d1",
        ),
      },
    };
  }

  // D2: DIGITAL_NOT_DELIVERED; merchant later provides the access log.
  {
    const o = byTag("D2");
    const buyerStatement =
      "I bought the phone photography course on the 21st. The login link in the email says 'invalid token' and support has not answered for 15 hours. I'd like my money back.\n";
    const merchantStatement =
      "We checked our access log for this order. The buyer never logged in; our email provider bounced the magic link. We are refunding in full.\n";
    const log =
      "timestamp,order_ref,event,detail\n" +
      `2026-09-21T18:00:41Z,${o.ref.trim()},magic_link_sent,bounced\n` +
      `2026-09-21T18:02:10Z,${o.ref.trim()},magic_link_sent,bounced\n`;
    const buyerEv: EvidenceItem[] = [
      { name: "buyer-statement.txt", kind: "statement", sha256: sha256Hex(buyerStatement), submittedAt: isoUtc(at(21, "09:15")) },
      { name: "email-invalid-token.png", kind: "chat", sha256: placeholder("D2 invalid token screenshot"), submittedAt: isoUtc(at(21, "09:15")) },
    ];
    const merchantEv: EvidenceItem[] = [
      { name: "merchant-statement.txt", kind: "statement", sha256: sha256Hex(merchantStatement), submittedAt: isoUtc(at(21, "16:05")) },
      { name: "access-log.csv", kind: "access_log", sha256: sha256Hex(log), submittedAt: isoUtc(at(21, "16:05")), extracted: { lastLoginAt: null } },
    ];
    out.D2 = {
      buyerHash: manifestHash(buyerEv),
      merchantHash: manifestHash(merchantEv),
      rulingHash: sha256Hex("no ruling: merchant refunded in full"),
      files: {
        "dispute.json": JSON.stringify({ id: "D2", order_n: o.n, order_ref: o.ref, reason: "DIGITAL_NOT_DELIVERED", buyer_lang: "en" }, null, 2) + "\n",
        "buyer-statement.txt": buyerStatement,
        "merchant-statement.txt": merchantStatement,
        "access-log.csv": log,
        "buyer-evidence.json": JSON.stringify(buyerEv, null, 2) + "\n",
        "merchant-evidence.json": JSON.stringify(merchantEv, null, 2) + "\n",
        "llm-response.json": llmMessage(
          JSON.stringify({
            summary:
              "The buyer paid 29.00 USDC for a video course and reports that the login link fails with an invalid token. The merchant's access log shows two bounced login emails and no login.",
            claims: { buyer: ["The login link returns 'invalid token'."], merchant: ["The buyer never logged in; the magic link bounced."] },
            questions: { buyer: ["Which email address did you use at checkout?"], merchant: ["Can you resend access to a different address?"] },
            inconsistencies: [],
            checklist_additions: [
              { item: "Email delivery log for the access link", whyForReason: "Shows whether access was ever delivered", provided: "merchant", evidenceRef: "access-log.csv" },
            ],
          }),
          "msg_fixture_d2",
        ),
      },
    };
  }

  // D3: NOT_RECEIVED; statement contains a phone number and street address
  // (redaction); merchant tracking says "delivered" before the payment date;
  // the arbiter stays silent; the recorded LLM output is malformed.
  {
    const o = byTag("D3");
    const buyerStatement =
      "The embroidered huipil never came. Please ship to 4417 N Kedzie Ave, Chicago, IL 60625 or refund me. " +
      "You can call me on +1 (773) 555-0142 or email dana.k.orders@example.com. Card on file ending 4242 4242 4242 4242 was not used.\n";
    const merchantStatement =
      "Se envió por DHL. Adjunto la guía. (Shipped with DHL, receipt attached.)\n";
    const buyerEv: EvidenceItem[] = [
      { name: "buyer-statement.txt", kind: "statement", sha256: sha256Hex(buyerStatement), submittedAt: isoUtc(at(15, "10:00")) },
      { name: "empty-mailbox.jpg", kind: "photo", sha256: placeholder("D3 mailbox photo"), submittedAt: isoUtc(at(15, "10:00")) },
    ];
    const merchantEv: EvidenceItem[] = [
      { name: "merchant-statement.txt", kind: "statement", sha256: sha256Hex(merchantStatement), submittedAt: isoUtc(at(16, "12:35")) },
      {
        name: "guia-dhl.pdf",
        kind: "tracking",
        sha256: placeholder("D3 DHL receipt"),
        note: "tracking number copied from another order",
        submittedAt: isoUtc(at(16, "12:35")),
        extracted: { carrier: "DHL", trackingNo: "JD014600006281234567", status: "delivered", statusAt: "2026-08-29T15:20:00Z", deliveryAddressMatches: false },
      },
    ];
    out.D3 = {
      buyerHash: manifestHash(buyerEv),
      merchantHash: manifestHash(merchantEv),
      rulingHash: sha256Hex("no ruling: arbiter silent, timeout refund"),
      files: {
        "dispute.json": JSON.stringify({ id: "D3", order_n: o.n, order_ref: o.ref, reason: "NOT_RECEIVED", buyer_lang: "en" }, null, 2) + "\n",
        "buyer-statement.txt": buyerStatement,
        "merchant-statement.txt": merchantStatement,
        "buyer-evidence.json": JSON.stringify(buyerEv, null, 2) + "\n",
        "merchant-evidence.json": JSON.stringify(merchantEv, null, 2) + "\n",
        // malformed: truncated JSON plus an outcome field
        "llm-response.json": llmMessage(
          '{"summary": "The buyer did not receive the huipil.", "recommendation": "refund in full", "claims": {"buyer": ["not received"',
          "msg_fixture_d3_malformed",
        ),
      },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function bytes(hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a 32-byte hex: ${hex}`);
  const b: string[] = [];
  for (let i = 0; i < 64; i += 2) b.push(`0x${hex.slice(i, i + 2)}`);
  return `[${b.join(", ")}]`;
}

function rustSeed(
  psp: PspSeed,
  merchants: MerchantSeed[],
  orders: OrderSeed[],
  outcomes: { n: number; state: string; held: string; refunded: string; refund_owed: string; released: string; fee: string; release_at: number; closed_at: number }[],
  schedule: ScheduledCall[],
  x: Expected,
  addresses: Record<string, string>,
): string {
  const tokIdx = (c: string) => psp.tokens.findIndex((t) => t.code === c);
  const mIdx = (id: string) => merchants.findIndex((m) => m.id === id);
  const who = (label?: string) => {
    if (!label) return "Who::Nobody";
    if (/^B\d\d$/.test(label)) return `Who::Buyer(${Number(label.slice(1)) - 1})`;
    if (/^R\d\d$/.test(label)) return `Who::Extra(${Number(label.slice(1)) - 1})`;
    throw new Error(`no Rust mapping for ${label}`);
  };
  const escrow = orders.filter((o) => o.mode === "escrow");
  const outByN = new Map(outcomes.map((o) => [o.n, o]));
  const lines: string[] = [];
  const L = (s = "") => lines.push(s);
  L("//! GENERATED by `refundwin seed` (app/src/seed/generate.ts). Do not edit by hand.");
  L("//! Simulated seed data: 44 escrow orders from data/seed/orders.jsonl, the call");
  L("//! schedule produced by the offline simulator (human actions from events.jsonl plus");
  L("//! the keeper's calls), and the final states and amounts the TypeScript model");
  L("//! reached. `test_scenario.rs` replays the schedule on the real contract.");
  L("#![allow(dead_code)]");
  L();
  L(`pub const T0: u64 = ${psp.t0_s};`);
  L(`pub const ARBITER_TIMEOUT: u64 = ${psp.arbiter_timeout_s};`);
  L(`pub const MIN_WINDOW: u64 = ${psp.min_window_s};`);
  L(`pub const MAX_WINDOW: u64 = ${psp.max_window_s};`);
  L(`pub const TOKENS: &[&str] = &[${psp.tokens.map((t) => `"${t.code}"`).join(", ")}];`);
  L(`pub const N_BUYERS: usize = ${Object.keys(addresses).filter((k) => /^B\d\d$/.test(k)).length};`);
  L(`pub const N_EXTRA: usize = ${Object.keys(addresses).filter((k) => /^R\d\d$/.test(k)).length};`);
  L();
  L("pub struct SeedMerchant { pub id: &'static str, pub fee_bps: u32, pub window: u64 }");
  L("pub const MERCHANTS: &[SeedMerchant] = &[");
  for (const m of merchants) L(`    SeedMerchant { id: "${m.id}", fee_bps: ${m.fee_bps}, window: ${m.window_s} },`);
  L("];");
  L();
  L("#[derive(Clone, Copy, Debug, PartialEq, Eq)]");
  L("pub enum Who { Nobody, Buyer(usize), Extra(usize) }");
  L();
  L("pub struct SeedOrder {");
  L("    pub n: u32, pub tag: &'static str, pub merchant: usize, pub token: usize, pub buyer: usize,");
  L("    pub refund_to: Who, pub amount: i128, pub window: Option<u64>, pub id: [u8; 32], pub memo: [u8; 32],");
  L("    pub state: &'static str, pub held: i128, pub refunded: i128, pub refund_owed: i128, pub released: i128,");
  L("    pub fee: i128, pub release_at: u64, pub closed_at: u64,");
  L("}");
  L("pub const ORDERS: &[SeedOrder] = &[");
  for (const o of escrow) {
    const r = outByN.get(o.n)!;
    L(
      `    SeedOrder { n: ${o.n}, tag: "${o.tag ?? ""}", merchant: ${mIdx(o.merchant)}, token: ${tokIdx(o.token)}, buyer: ${Number(o.buyer.slice(1)) - 1}, ` +
        `refund_to: ${o.refund_to ? who(o.refund_to) : "Who::Nobody"}, amount: ${parseAmount(o.amount)}, window: ${o.window_s ? `Some(${o.window_s})` : "None"}, ` +
        `id: ${bytes(o.order_id)}, memo: ${bytes(o.memo_hash)}, state: "${r.state}", held: ${r.held}, refunded: ${r.refunded}, ` +
        `refund_owed: ${r.refund_owed}, released: ${r.released}, fee: ${r.fee}, release_at: ${r.release_at}, closed_at: ${r.closed_at} },`,
    );
  }
  L("];");
  L();
  L("pub struct SeedCall {");
  L("    pub at: u64, pub kind: &'static str, pub order: u32, pub ids: &'static [u32], pub id: [u8; 32],");
  L("    pub token: usize, pub amount: i128, pub reason: u32, pub hash: [u8; 32], pub who: Who,");
  L("    pub expect: &'static str, pub ret: i128,");
  L("}");
  L("pub const CALLS: &[SeedCall] = &[");
  const zero = "0".repeat(64);
  for (const c of schedule) {
    L(
      `    SeedCall { at: ${c.at}, kind: "${c.kind}", order: ${c.order ?? 0}, ids: &[${(c.ids ?? []).join(", ")}], id: ${bytes(c.id_hex ?? zero)}, ` +
        `token: ${c.token ? tokIdx(c.token) : 0}, amount: ${c.amount ?? 0}, reason: ${c.reason ?? 0}, hash: ${bytes(c.hash ?? zero)}, ` +
        `who: ${who(c.who)}, expect: "${c.expect}", ret: ${c.ret ?? 0} },`,
    );
  }
  L("];");
  L();
  L("pub struct SeedTotals { pub token: usize, pub paid: i128, pub payout: [i128; 2], pub refunded: i128, pub fees: i128 }");
  L("pub const TOTALS: &[SeedTotals] = &[");
  for (const [code, t] of Object.entries(x.totals)) {
    L(
      `    SeedTotals { token: ${tokIdx(code)}, paid: ${parseAmount(t.paid)}, payout: [${parseAmount(t.payout.M1 ?? "0")}, ${parseAmount(t.payout.M2 ?? "0")}], ` +
        `refunded: ${parseAmount(t.refunded)}, fees: ${parseAmount(t.fees)} },`,
    );
  }
  L("];");
  L(`pub const EXPECTED_STATES: &[(&str, u32)] = &[${Object.entries(x.states).sort().map(([k, v]) => `("${k}", ${v})`).join(", ")}];`);
  L(`pub const EXPECTED_LATE_RELEASES: u32 = ${x.late_releases};`);
  L(`pub const EXPECTED_UNTOUCHED_RELEASES: u32 = ${x.untouched_releases};`);
  L();
  L("/// (amount, fee_bps, fee): shared with app/test/fee.test.ts via data/seed/fee-vectors.json");
  L("pub const FEE_VECTORS: &[(i128, u32, i128)] = &[");
  for (const v of feeVectors()) L(`    (${v.amount}, ${v.fee_bps}, ${v.fee}), // ${v.note}`);
  L("];");
  L();
  L("/// (merchant strkey, raw ref, normalised ref, order id): shared with app/test/orderid.test.ts");
  L("pub const ORDER_ID_VECTORS: &[(&str, &str, &str, [u8; 32])] = &[");
  for (const v of orderIdVectors(addresses.M1!, addresses.M2!)) {
    L(`    (${JSON.stringify(v.merchant)}, ${JSON.stringify(v.ref)}, ${JSON.stringify(v.normalised)}, ${bytes(v.order_id)}),`);
  }
  L("];");
  return lines.join("\n") + "\n";
}

// CLI entry: node src/seed/generate.ts [projectRoot]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
  const r = await generateSeed({ root });
  console.log(`wrote ${r.files.length} files; ${r.orders.length} orders, ${r.events.length} events, ${r.schedule.length} scheduled calls`);
}
