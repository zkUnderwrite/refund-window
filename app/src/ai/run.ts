// Runs a dispute brief for a seed dispute (data/seed/disputes/D1..D3): the
// offline simulation is run up to the chosen time, the order's receipt is
// built from the model, and the packet is assembled from the dispute folder.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSeed, runSimulation } from "../sim/simulate.ts";
import { modelReceipt } from "../sim/model-receipt.ts";
import { buildPacket, loadDisputeDir } from "./packet.ts";
import type { DisputePacket } from "./types.ts";

export interface SeedDisputeOptions {
  root: string;
  id: string;
  /** ISO time; default: one hour after the last evidence in the folder. */
  asOf?: string;
}

export async function seedDisputePacket(o: SeedDisputeOptions): Promise<{ packet: DisputePacket; asOf: string; orderRef: string }> {
  const dir = join(o.root, "data", "seed", "disputes", o.id);
  const d = loadDisputeDir(dir);
  const seed = loadSeed(join(o.root, "data", "seed"));
  const order = seed.orders.find((x) => x.n === d.meta.order_n);
  if (!order) throw new Error(`dispute ${o.id}: order #${d.meta.order_n} not in orders.jsonl`);
  const merchant = seed.merchants.find((m) => m.id === order.merchant)!;
  const times = [...d.buyerEvidence, ...d.merchantEvidence].map((e) => e.submittedAt).filter((x): x is string => !!x).sort();
  const asOf = o.asOf ?? new Date(Date.parse(times.at(-1)!) + 3_600_000).toISOString().replace(".000Z", "Z");
  const until = Math.floor(Date.parse(asOf) / 1000);
  if (!Number.isFinite(until)) throw new Error(`bad --as-of "${o.asOf}"`);
  const sim = await runSimulation(seed, { until });
  const token = seed.psp.tokens.find((t) => t.code === order.token)!;
  const { receipt } = modelReceipt(sim.model, order.order_id, { code: token.code, issuer: token.issuer }, order.ref);
  const packet = buildPacket(receipt, d, {
    asOf,
    policy: {
      window_s: order.window_s ?? merchant.window_s,
      returnPolicyText: merchant.return_policy,
      shipsWithinDays: merchant.ships_within_days,
    },
  });
  return { packet, asOf, orderRef: order.ref };
}

/** The recorded Messages-API fixture of a seed dispute. */
export function seedFixture(root: string, id: string): unknown {
  return JSON.parse(readFileSync(join(root, "data", "seed", "disputes", id, "llm-response.json"), "utf8"));
}
