// Chooses the dispute brief provider. The heuristic provider always works;
// the LLM provider needs a key and the PSP's explicit sign-off.
import { HeuristicProvider } from "./heuristic.ts";
import { LlmProvider, llmEnabled, type LlmEnv, type Transport } from "./llm.ts";
import type { DisputeBriefProvider } from "./types.ts";

export function makeProvider(kind: "heuristic" | "llm", env: LlmEnv, transport?: Transport): DisputeBriefProvider {
  if (kind === "heuristic") return new HeuristicProvider();
  if (!llmEnabled(env)) {
    throw new Error("--provider llm needs LLM_API_KEY and LLM_DISPUTES_ALLOWED=true; use --provider heuristic");
  }
  return new LlmProvider(env, transport);
}
