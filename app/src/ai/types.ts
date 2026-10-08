// Dispute brief types. The brief supports the PSP arbiter; it never contains
// an outcome, a split or a recommendation (the schema rejects such fields).
import type { EvidenceItem } from "../evidence.ts";
import type { Receipt } from "../receipt.ts";

export interface DisputePacket {
  receipt: Receipt;
  reason: string;
  buyerStatement: string;
  merchantStatement?: string;
  buyerEvidence: EvidenceItem[];
  merchantEvidence: EvidenceItem[];
  merchantPolicy: { window_s: number; returnPolicyText?: string; shipsWithinDays?: number | null };
}

export type Party = "buyer" | "merchant" | "none";

export interface ChecklistItem {
  item: string;
  whyForReason: string;
  provided: Party;
  evidenceRef?: string;
}

export interface TimelineEntry {
  at: string;
  event: string;
  source: "chain" | "buyer" | "merchant";
}

export interface DisputeBrief {
  summary: string;
  timeline: TimelineEntry[];
  claims: { buyer: string[]; merchant: string[] };
  checklist: ChecklistItem[];
  missing: string[];
  questions: { buyer: string[]; merchant: string[] };
  inconsistencies: string[];
  generatedBy: "heuristic" | "llm";
  digest: string;
}

export interface DisputeBriefProvider {
  readonly name: "heuristic" | "llm";
  brief(packet: DisputePacket): Promise<DisputeBrief>;
}
