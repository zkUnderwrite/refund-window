// Deterministic dispute brief. No model: checklists keyed to the reason code,
// `provided` computed from evidence kinds and extracted fields, a timeline
// from receipt events plus evidence timestamps, rule-based inconsistencies,
// and a fixed-template summary. This is the floor the LLM can only add to.

import { digestOf } from "../canonical.ts";
import type { EvidenceItem } from "../evidence.ts";
import type { ReceiptEvent } from "../receipt.ts";
import { validateBrief } from "./schema.ts";
import type { ChecklistItem, DisputeBrief, DisputeBriefProvider, DisputePacket, Party, TimelineEntry } from "./types.ts";

interface Rule {
  item: string;
  why: string;
  /** Which evidence satisfies the item, and for whom it counts. */
  match: (e: EvidenceItem, packet: DisputePacket) => boolean;
}

const DAY = 86_400_000;
const t = (iso: unknown) => (typeof iso === "string" ? Date.parse(iso) : NaN);

const delivered = (e: EvidenceItem) => e.kind === "tracking" && /deliver|entregad/i.test(e.extracted?.status ?? "");

export const CHECKLISTS: Record<string, Rule[]> = {
  NOT_RECEIVED: [
    { item: "Tracking number", why: "Identifies the shipment the merchant says it sent", match: (e) => e.kind === "tracking" && !!e.extracted?.trackingNo },
    { item: "Carrier status showing delivery", why: "A not-received claim turns on whether the carrier recorded a delivery", match: (e) => delivered(e) },
    { item: "Delivery address matches the order", why: "A delivery to another address does not answer the claim", match: (e) => e.kind === "tracking" && e.extracted?.deliveryAddressMatches === true },
    {
      item: "Delivery date before the dispute was opened",
      why: "A delivery after the dispute may resolve it; one before it contradicts the claim",
      match: (e, p) => delivered(e) && t(e.extracted?.statusAt) < t(p.receipt.disputed_at),
    },
  ],
  NOT_AS_DESCRIBED: [
    { item: "Listing snapshot at the payment date", why: "Shows what was described when the buyer paid", match: (e) => e.kind === "listing" },
    { item: "Buyer photos of the item received", why: "Shows the difference the buyer describes", match: (e) => e.kind === "photo" },
    { item: "Return policy", why: "States what the merchant offered for items not as described", match: (_e, p) => !!p.merchantPolicy.returnPolicyText },
    { item: "Merchant reply to the complaint", why: "Shows whether a return or repair was offered", match: (e) => e.kind === "chat" || e.kind === "statement" },
  ],
  DIGITAL_NOT_DELIVERED: [
    { item: "Access log showing download or login after payment", why: "The only direct evidence that digital goods were delivered", match: (e) => e.kind === "access_log" },
    { item: "Buyer's screenshot of the access error", why: "Shows what the buyer saw", match: (e) => e.kind === "chat" || e.kind === "photo" },
  ],
  DUPLICATE_CHARGE: [
    { item: "Both order ids with the same buyer and amount within 24 h", why: "A duplicate needs two on-chain payments; check them against the chain", match: (e) => e.kind === "invoice" || e.kind === "other" },
  ],
  CANCELLED_BEFORE_FULFILMENT: [
    { item: "Cancellation message with timestamp", why: "Must predate shipping or delivery", match: (e) => e.kind === "chat" },
    { item: "Shipping timestamp", why: "Compared with the cancellation time", match: (e) => e.kind === "tracking" },
  ],
  OTHER: [{ item: "Statement from each side", why: "No reason-specific checklist exists", match: (e) => e.kind === "statement" }],
};

export const QUESTIONS: Record<string, { buyer: string[]; merchant: string[] }> = {
  NOT_RECEIVED: {
    buyer: ["Is the delivery address on the order correct and complete?", "Have you checked with neighbours, building reception or the local carrier office?"],
    merchant: ["Which carrier and tracking number belong to this order?", "Can you open a trace with the carrier?"],
  },
  NOT_AS_DESCRIBED: {
    buyer: ["What exactly differs from the listing?", "Are you willing to return the item?"],
    merchant: ["Can you share the listing as it was on the payment date?", "Do you offer a return or replacement?"],
  },
  DIGITAL_NOT_DELIVERED: {
    buyer: ["Which email address did you use at checkout?", "What error did you see when you tried to access the product?"],
    merchant: ["Does your access log show any login or download for this order?", "Can you resend access to a verified address?"],
  },
  DUPLICATE_CHARGE: {
    buyer: ["Which two order ids do you believe are duplicates?"],
    merchant: ["Did you fulfil both orders?"],
  },
  CANCELLED_BEFORE_FULFILMENT: {
    buyer: ["When and how did you cancel?"],
    merchant: ["When did the order ship, and was the cancellation seen before that?"],
  },
  OTHER: { buyer: ["Please describe the problem and what you are asking for."], merchant: ["Please describe your side."] },
};

/** How long after a carrier delivery a dispute is considered suspiciously late. */
export const LATE_DISPUTE_DAYS = 30;

function checklist(p: DisputePacket): ChecklistItem[] {
  const rules = CHECKLISTS[p.reason] ?? CHECKLISTS.OTHER!;
  return rules.map((r) => {
    const m = p.merchantEvidence.find((e) => r.match(e, p));
    const b = p.buyerEvidence.find((e) => r.match(e, p));
    let provided: Party = "none";
    let ref: string | undefined;
    if (r.item === "Return policy" && p.merchantPolicy.returnPolicyText) {
      provided = "merchant";
      ref = "merchant policy";
    } else if (m) {
      provided = "merchant";
      ref = m.name;
    } else if (b) {
      provided = "buyer";
      ref = b.name;
    }
    return { item: r.item, whyForReason: r.why, provided, ...(ref ? { evidenceRef: ref } : {}) };
  });
}

const EVENT_TEXT: Record<string, (a: Record<string, string>) => string> = {
  pay: () => "Buyer paid into escrow; refund address fixed",
  refund: (a) => `Merchant refunded ${a.amount ?? ""}`.trim(),
  refund_pending: () => "Refund credited but not deliverable (refund address cannot receive)",
  refund_settled: (a) => `Pending refund of ${a.amount ?? ""} delivered`.trim(),
  dispute: () => "Buyer opened the dispute",
  respond: () => "Merchant submitted evidence",
  dispute_withdrawn: () => "Buyer withdrew the dispute",
  resolve: () => "Arbiter ruled",
  timeout: () => "Arbiter did not rule in time; full refund",
  release: () => "Released to the merchant",
};

function timeline(p: DisputePacket): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const events = (p.receipt.events as ReceiptEvent[] | undefined) ?? [];
  for (const e of events) {
    const at = e.at ?? "";
    out.push({ at, event: (EVENT_TEXT[e.type] ?? ((_: Record<string, string>) => e.type))(e.amounts), source: "chain" });
  }
  if (events.length === 0) {
    out.push({ at: String(p.receipt.paid_at), event: "Buyer paid into escrow; refund address fixed", source: "chain" });
    if (p.receipt.disputed_at) out.push({ at: String(p.receipt.disputed_at), event: "Buyer opened the dispute", source: "chain" });
  }
  for (const [side, list] of [["buyer", p.buyerEvidence], ["merchant", p.merchantEvidence]] as const) {
    for (const e of list) {
      if (e.extracted?.statusAt) {
        out.push({ at: e.extracted.statusAt, event: `Carrier status "${e.extracted.status}" (${e.name})`, source: side });
      }
      if (e.submittedAt && e.kind !== "statement") {
        out.push({ at: e.submittedAt, event: `${side === "buyer" ? "Buyer" : "Merchant"} provided ${e.name}`, source: side });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function inconsistencies(p: DisputePacket): string[] {
  const out: string[] = [];
  const paid = t(p.receipt.paid_at);
  const disputed = t(p.receipt.disputed_at);
  const resolveBy = t(p.receipt.resolve_by);
  const all = [...p.buyerEvidence.map((e) => ["buyer", e] as const), ...p.merchantEvidence.map((e) => ["merchant", e] as const)];
  for (const [side, e] of all) {
    const ex = e.extracted;
    if (ex?.statusAt && /deliver|entregad/i.test(ex.status ?? "") && t(ex.statusAt) < paid) {
      out.push(`${e.name} (${side}) shows "delivered" on ${ex.statusAt.slice(0, 10)}, before the payment on ${String(p.receipt.paid_at).slice(0, 10)}; it may belong to another shipment.`);
    }
    if (ex?.statusAt && /deliver|entregad/i.test(ex.status ?? "") && disputed - t(ex.statusAt) > LATE_DISPUTE_DAYS * DAY) {
      out.push(`The dispute was opened more than ${LATE_DISPUTE_DAYS} days after the carrier recorded delivery.`);
    }
    if (ex?.deliveryAddressMatches === false) {
      out.push(`${e.name} (${side}) is for a delivery address that does not match the order.`);
    }
    if (side === "merchant" && e.submittedAt && Number.isFinite(resolveBy) && t(e.submittedAt) >= resolveBy) {
      out.push(`${e.name} was submitted after the arbiter deadline (${String(p.receipt.resolve_by)}).`);
    }
  }
  if (p.reason === "NOT_RECEIVED") {
    const tracking = p.merchantEvidence.filter((e) => e.kind === "tracking" && e.extracted?.status);
    if (tracking.length > 0 && !tracking.some(delivered)) {
      const last = tracking.map((e) => e.extracted!.status).join(", ");
      out.push(`The merchant's tracking shows "${last}", not a delivery; nothing in the evidence records the item as delivered.`);
    }
  }
  if (p.reason === "DIGITAL_NOT_DELIVERED") {
    const log = p.merchantEvidence.find((e) => e.kind === "access_log");
    if (log && log.extracted && log.extracted.lastLoginAt === null) {
      out.push(`The merchant's own access log (${log.name}) shows no login for this order.`);
    }
  }
  return [...new Set(out)];
}

function summaryText(p: DisputePacket, cl: ChecklistItem[], inc: string[]): string {
  const r = p.receipt;
  const provided = cl.filter((c) => c.provided !== "none").length;
  const parts = [
    `Order ${String(r.order_id).slice(0, 12)}… paid ${String(r.amount)} ${String(r.asset_code)} on ${String(r.paid_at).slice(0, 10)}; release was due ${String(r.release_at).slice(0, 10)}.`,
    `The buyer opened a ${p.reason} dispute on ${String(r.disputed_at ?? "").slice(0, 10)}; the arbiter can rule until ${String(r.resolve_by ?? "").slice(0, 16)}, after which the held ${String(r.held)} is refunded by default.`,
    `Evidence: buyer ${p.buyerEvidence.length} item(s), merchant ${p.merchantEvidence.length} item(s)${p.merchantStatement ? "" : ", no merchant statement yet"}.`,
    `${provided} of ${cl.length} checklist items are covered.`,
    inc.length ? `${inc.length} inconsistency flag(s) need attention.` : "No rule-based inconsistencies.",
  ];
  return parts.join(" ");
}

export function heuristicBrief(p: DisputePacket): DisputeBrief {
  const cl = checklist(p);
  const inc = inconsistencies(p);
  const q = QUESTIONS[p.reason] ?? QUESTIONS.OTHER!;
  const firstSentence = (s?: string) => (s ? [s.split(/(?<=[.!?])\s/)[0]!.trim()] : []);
  const body = {
    summary: summaryText(p, cl, inc),
    timeline: timeline(p),
    claims: { buyer: firstSentence(p.buyerStatement), merchant: firstSentence(p.merchantStatement) },
    checklist: cl,
    missing: cl.filter((c) => c.provided === "none").map((c) => c.item),
    questions: { buyer: [...q.buyer], merchant: [...q.merchant] },
    inconsistencies: inc,
    generatedBy: "heuristic" as const,
  };
  return validateBrief({ ...body, digest: digestOf(body) });
}

export class HeuristicProvider implements DisputeBriefProvider {
  readonly name = "heuristic" as const;
  async brief(packet: DisputePacket): Promise<DisputeBrief> {
    return heuristicBrief(packet);
  }
}
