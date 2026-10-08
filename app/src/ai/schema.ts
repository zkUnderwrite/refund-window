// Strict validation for briefs and for the model's raw JSON. Any key that
// names or implies an outcome is rejected, at any depth.
import type { DisputeBrief } from "./types.ts";

export const FORBIDDEN_KEY = /^(recommend.*|split|splits|winner|refund_amount|refundamount|outcome|verdict|decision|award|liable|fault)$/i;
export const MAX_SUMMARY_WORDS = 150;

export class SchemaError extends Error {}

export function assertNoOutcomeKeys(v: unknown, path = "$"): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoOutcomeKeys(x, `${path}[${i}]`));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEY.test(k)) throw new SchemaError(`field "${path}.${k}" implies an outcome; briefs never decide`);
      assertNoOutcomeKeys(x, `${path}.${k}`);
    }
  }
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const PARTIES = new Set(["buyer", "merchant", "none"]);

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** What the model may return: additions and rewrites only. */
export interface LlmOutput {
  summary: string;
  claims: { buyer: string[]; merchant: string[] };
  questions: { buyer: string[]; merchant: string[] };
  inconsistencies: string[];
  checklist_additions: { item: string; whyForReason: string; provided: "buyer" | "merchant" | "none"; evidenceRef?: string }[];
}

export function validateLlmOutput(v: unknown): LlmOutput {
  assertNoOutcomeKeys(v);
  if (!v || typeof v !== "object") throw new SchemaError("model output is not an object");
  const o = v as Record<string, unknown>;
  const allowed = new Set(["summary", "claims", "questions", "inconsistencies", "checklist_additions"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new SchemaError(`unexpected field "${k}"`);
  if (typeof o.summary !== "string" || o.summary.trim() === "") throw new SchemaError("summary must be a non-empty string");
  if (wordCount(o.summary) > MAX_SUMMARY_WORDS) throw new SchemaError(`summary exceeds ${MAX_SUMMARY_WORDS} words`);
  const pair = (x: unknown, name: string) => {
    const p = x as Record<string, unknown> | undefined;
    if (!p || !isStrArr(p.buyer) || !isStrArr(p.merchant)) throw new SchemaError(`${name} must have buyer[] and merchant[] string arrays`);
    return { buyer: p.buyer, merchant: p.merchant };
  };
  const claims = pair(o.claims, "claims");
  const questions = pair(o.questions, "questions");
  if (!isStrArr(o.inconsistencies)) throw new SchemaError("inconsistencies must be a string array");
  const adds = o.checklist_additions ?? [];
  if (!Array.isArray(adds)) throw new SchemaError("checklist_additions must be an array");
  const checklist_additions = adds.map((a, i) => {
    const x = a as Record<string, unknown>;
    if (typeof x.item !== "string" || typeof x.whyForReason !== "string" || !PARTIES.has(String(x.provided))) {
      throw new SchemaError(`checklist_additions[${i}] is malformed`);
    }
    return {
      item: x.item,
      whyForReason: x.whyForReason,
      provided: x.provided as "buyer" | "merchant" | "none",
      ...(typeof x.evidenceRef === "string" ? { evidenceRef: x.evidenceRef } : {}),
    };
  });
  return { summary: o.summary, claims, questions, inconsistencies: o.inconsistencies, checklist_additions };
}

export function validateBrief(b: DisputeBrief): DisputeBrief {
  assertNoOutcomeKeys(b);
  if (wordCount(b.summary) > MAX_SUMMARY_WORDS) throw new SchemaError(`summary exceeds ${MAX_SUMMARY_WORDS} words`);
  for (const t of b.timeline) {
    if (!["chain", "buyer", "merchant"].includes(t.source)) throw new SchemaError(`bad timeline source ${t.source}`);
  }
  for (const c of b.checklist) if (!PARTIES.has(c.provided)) throw new SchemaError(`bad provided ${c.provided}`);
  if (b.generatedBy !== "heuristic" && b.generatedBy !== "llm") throw new SchemaError("bad generatedBy");
  return b;
}
