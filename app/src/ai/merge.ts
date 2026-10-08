// Merge rules for an LLM-assisted brief:
// * the checklist is the union of heuristic and model items: the model can add
//   items, never remove or downgrade one;
// * timeline entries with source "chain" come only from the heuristic;
// * claims, questions and inconsistencies are unions;
// * the summary is the model's only if the numbers guard passes.
import { digestOf } from "../canonical.ts";
import type { LlmOutput } from "./schema.ts";
import { validateBrief } from "./schema.ts";
import { checkNumbers } from "./guard.ts";
import type { DisputeBrief, DisputePacket } from "./types.ts";

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export interface MergeResult {
  brief: DisputeBrief;
  summaryFrom: "llm" | "heuristic";
  invented: string[];
}

export function mergeBrief(h: DisputeBrief, m: LlmOutput, packet: DisputePacket): MergeResult {
  const known = new Set(h.checklist.map((c) => c.item.toLowerCase()));
  const additions = m.checklist_additions.filter((c) => !known.has(c.item.toLowerCase()));
  const guard = checkNumbers(m.summary, packet);
  const body = {
    summary: guard.ok ? m.summary.trim() : h.summary,
    timeline: h.timeline, // chain entries only from the heuristic; the model adds none
    claims: { buyer: uniq([...h.claims.buyer, ...m.claims.buyer]), merchant: uniq([...h.claims.merchant, ...m.claims.merchant]) },
    checklist: [...h.checklist, ...additions],
    missing: uniq([...h.missing, ...additions.filter((a) => a.provided === "none").map((a) => a.item)]),
    questions: { buyer: uniq([...h.questions.buyer, ...m.questions.buyer]), merchant: uniq([...h.questions.merchant, ...m.questions.merchant]) },
    inconsistencies: uniq([...h.inconsistencies, ...m.inconsistencies]),
    generatedBy: "llm" as const,
  };
  return {
    brief: validateBrief({ ...body, digest: digestOf(body) }),
    summaryFrom: guard.ok ? "llm" : "heuristic",
    invented: guard.invented,
  };
}
