// Builds a DisputePacket from a dispute folder (statements + evidence
// manifests, as in data/seed/disputes/D1) and a receipt. Statements are
// redacted here, before any provider sees them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceItem } from "../evidence.ts";
import type { Receipt } from "../receipt.ts";
import { redact } from "./redact.ts";
import type { DisputeBrief, DisputePacket } from "./types.ts";

export interface DisputeDir {
  meta: { id: string; order_n: number; order_ref: string; reason: string; buyer_lang?: string };
  buyerStatement: string;
  merchantStatement?: string;
  buyerEvidence: EvidenceItem[];
  merchantEvidence: EvidenceItem[];
}

export function loadDisputeDir(dir: string): DisputeDir {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const opt = (f: string) => (existsSync(join(dir, f)) ? read(f) : undefined);
  return {
    meta: JSON.parse(read("dispute.json")),
    buyerStatement: read("buyer-statement.txt"),
    merchantStatement: opt("merchant-statement.txt"),
    buyerEvidence: JSON.parse(read("buyer-evidence.json")),
    merchantEvidence: existsSync(join(dir, "merchant-evidence.json")) ? JSON.parse(read("merchant-evidence.json")) : [],
  };
}

export interface PacketOptions {
  /** Include only evidence submitted at or before this ISO time (default: all). */
  asOf?: string;
  policy: DisputePacket["merchantPolicy"];
}

export function buildPacket(receipt: Receipt, d: DisputeDir, opts: PacketOptions): DisputePacket {
  const upTo = (e: EvidenceItem) => !opts.asOf || !e.submittedAt || e.submittedAt <= opts.asOf;
  const merchantEvidence = d.merchantEvidence.filter(upTo);
  const merchantHasStatement = merchantEvidence.some((e) => e.kind === "statement");
  return {
    receipt,
    reason: d.meta.reason,
    buyerStatement: redact(d.buyerStatement).text,
    ...(d.merchantStatement && merchantHasStatement ? { merchantStatement: redact(d.merchantStatement).text } : {}),
    buyerEvidence: d.buyerEvidence.filter(upTo),
    merchantEvidence,
    merchantPolicy: opts.policy,
  };
}

/** Markdown view for the arbiter; raw statements and the evidence manifest are shown beside the brief. */
export function briefToMarkdown(b: DisputeBrief, p: DisputePacket): string {
  const L: string[] = [];
  L.push(`# Dispute brief (${b.generatedBy}) — ${p.reason}`, "", "_Supporting material only. The arbiter decides; this brief contains no outcome._", "");
  L.push("## Summary", "", b.summary, "", "## Timeline", "");
  for (const t of b.timeline) L.push(`- ${t.at} [${t.source}] ${t.event}`);
  L.push("", "## Checklist", "", "| Item | Provided by | Evidence | Why it matters |", "|---|---|---|---|");
  for (const c of b.checklist) L.push(`| ${c.item} | ${c.provided} | ${c.evidenceRef ?? ""} | ${c.whyForReason} |`);
  L.push("", "## Missing", "", ...(b.missing.length ? b.missing.map((m) => `- ${m}`) : ["- none"]));
  L.push("", "## Inconsistencies", "", ...(b.inconsistencies.length ? b.inconsistencies.map((m) => `- ${m}`) : ["- none"]));
  L.push("", "## Questions", "", "Buyer:", ...b.questions.buyer.map((q) => `- ${q}`), "", "Merchant:", ...b.questions.merchant.map((q) => `- ${q}`));
  L.push("", "## Raw statements (redacted)", "", "Buyer:", "", "> " + p.buyerStatement.trim().replace(/\n/g, "\n> "));
  if (p.merchantStatement) L.push("", "Merchant:", "", "> " + p.merchantStatement.trim().replace(/\n/g, "\n> "));
  L.push("", "## Evidence manifest", "", "| Side | Name | Kind | sha256 |", "|---|---|---|---|");
  for (const e of p.buyerEvidence) L.push(`| buyer | ${e.name} | ${e.kind} | ${e.sha256.slice(0, 16)}… |`);
  for (const e of p.merchantEvidence) L.push(`| merchant | ${e.name} | ${e.kind} | ${e.sha256.slice(0, 16)}… |`);
  L.push("", `Brief digest: ${b.digest}`, "");
  return L.join("\n");
}
