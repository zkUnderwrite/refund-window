// LLM provider: Anthropic Messages API, strict JSON, schema validation, one
// retry, then fallback to the heuristic brief. Disabled unless LLM_API_KEY is
// set AND LLM_DISPUTES_ALLOWED=true (the PSP's data-protection sign-off).
// Statements are redacted before they are sent. The model never decides.
import { heuristicBrief } from "./heuristic.ts";
import { mergeBrief } from "./merge.ts";
import { validateLlmOutput, SchemaError, type LlmOutput } from "./schema.ts";
import type { DisputeBrief, DisputeBriefProvider, DisputePacket } from "./types.ts";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const API_URL = "https://api.anthropic.com/v1/messages";

/** Sends a request body, returns the parsed Messages API response body. */
export type Transport = (body: unknown, apiKey: string) => Promise<unknown>;

export const fetchTransport: Transport = async (body, apiKey) => {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Messages API HTTP ${res.status}`);
  return res.json();
};

export interface LlmEnv {
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_DISPUTES_ALLOWED?: string;
  ARBITER_LANG?: string;
}

export function llmEnabled(env: LlmEnv): boolean {
  return !!env.LLM_API_KEY && env.LLM_DISPUTES_ALLOWED === "true";
}

const SYSTEM = [
  "You prepare dispute briefs for a payment arbiter. You never decide, recommend, or suggest an outcome, a split or an amount to refund.",
  "Answer with ONE JSON object and nothing else, with exactly these fields:",
  '{"summary": string (max 150 words, neutral), "claims": {"buyer": string[], "merchant": string[]},',
  '"questions": {"buyer": string[], "merchant": string[]}, "inconsistencies": string[],',
  '"checklist_additions": [{"item": string, "whyForReason": string, "provided": "buyer"|"merchant"|"none", "evidenceRef"?: string}]}',
  "Only use amounts and dates that appear in the input. Personal data has been redacted; do not try to restore it.",
].join("\n");

export function buildRequest(packet: DisputePacket, heuristic: DisputeBrief, env: LlmEnv, retryNote?: string): unknown {
  const lang = env.ARBITER_LANG ?? "en";
  const user = JSON.stringify({ arbiter_language: lang, packet, heuristic_brief: heuristic });
  return {
    model: env.LLM_MODEL ?? DEFAULT_MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    messages: [
      { role: "user", content: user },
      ...(retryNote ? [{ role: "user", content: `Your previous answer was rejected: ${retryNote}. Reply with the JSON object only.` }] : []),
    ],
  };
}

/** Extracts the model's JSON object from a Messages API response body. */
export function parseMessage(resp: unknown): LlmOutput {
  const content = (resp as { content?: { type: string; text?: string }[] })?.content;
  const text = content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SchemaError("no JSON object in the model response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new SchemaError(`model response is not valid JSON: ${(e as Error).message}`);
  }
  return validateLlmOutput(parsed);
}

export interface LlmRunInfo {
  attempts: number;
  fellBack: boolean;
  error?: string;
  summaryFrom?: "llm" | "heuristic";
  invented?: string[];
}

export class LlmProvider implements DisputeBriefProvider {
  readonly name = "llm" as const;
  lastRun: LlmRunInfo = { attempts: 0, fellBack: false };
  private readonly env: LlmEnv;
  private readonly transport: Transport;

  constructor(env: LlmEnv, transport: Transport = fetchTransport) {
    if (!llmEnabled(env)) {
      throw new Error("LLM provider disabled: set LLM_API_KEY and LLM_DISPUTES_ALLOWED=true (PSP data-protection sign-off)");
    }
    this.env = env;
    this.transport = transport;
  }

  async brief(packet: DisputePacket): Promise<DisputeBrief> {
    const h = heuristicBrief(packet);
    let lastErr = "";
    this.lastRun = { attempts: 0, fellBack: false };
    for (let attempt = 0; attempt < 2; attempt++) {
      this.lastRun.attempts = attempt + 1;
      try {
        const resp = await this.transport(buildRequest(packet, h, this.env, attempt ? lastErr : undefined), this.env.LLM_API_KEY!);
        const out = parseMessage(resp);
        const merged = mergeBrief(h, out, packet);
        this.lastRun.summaryFrom = merged.summaryFrom;
        this.lastRun.invented = merged.invented;
        return merged.brief;
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    this.lastRun = { ...this.lastRun, fellBack: true, error: lastErr };
    return h;
  }
}
