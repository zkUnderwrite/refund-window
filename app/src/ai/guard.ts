// Numbers guard: every amount and date in an LLM summary must appear in the
// receipt or the evidence. If any does not, the heuristic summary is kept.
import type { DisputePacket } from "./types.ts";

const AMOUNT = /(?:[$€]\s?)?\b\d{1,9}(?:[.,]\d{1,7})\b(?:\s?(?:USDC|EURC|PYUSD|USD|EUR))?|\b\d{1,9}\s?(?:USDC|EURC|PYUSD|USD|EUR)\b|[$€]\s?\d{1,9}\b/g;
const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{2}\/\d{2}\/\d{4}\b/g;

function normNumber(s: string): string | null {
  const m = /(\d{1,9})(?:[.,](\d{1,7}))?/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return frac ? `${Number(m[1])}.${frac}` : `${Number(m[1])}`;
}

function normDate(s: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

/** All amounts and dates that the packet itself contains. */
export function allowedValues(p: DisputePacket): { amounts: Set<string>; dates: Set<string> } {
  const amounts = new Set<string>();
  const dates = new Set<string>();
  const text = JSON.stringify(p.receipt) + JSON.stringify(p.buyerEvidence) + JSON.stringify(p.merchantEvidence) +
    p.buyerStatement + (p.merchantStatement ?? "") + (p.merchantPolicy.returnPolicyText ?? "");
  for (const m of text.matchAll(/\d{1,9}(?:\.\d{1,7})?/g)) {
    const n = normNumber(m[0]);
    if (n) amounts.add(n);
  }
  for (const m of text.matchAll(DATE)) dates.add(normDate(m[0]));
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}T/g)) dates.add(m[0].slice(0, 10));
  return { amounts, dates };
}

export interface GuardResult {
  ok: boolean;
  invented: string[];
}

export function checkNumbers(summary: string, p: DisputePacket): GuardResult {
  const { amounts, dates } = allowedValues(p);
  const invented: string[] = [];
  const noDates = summary.replace(DATE, (d) => {
    if (!dates.has(normDate(d))) invented.push(d);
    return " ";
  });
  for (const m of noDates.matchAll(AMOUNT)) {
    const n = normNumber(m[0]);
    if (n && !amounts.has(n)) invented.push(m[0].trim());
  }
  return { ok: invented.length === 0, invented };
}
