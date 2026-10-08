import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { heuristicBrief } from "../src/ai/heuristic.ts";
import { buildRequest, LlmProvider, llmEnabled, parseMessage } from "../src/ai/llm.ts";
import { mergeBrief } from "../src/ai/merge.ts";
import { checkNumbers } from "../src/ai/guard.ts";
import { makeProvider } from "../src/ai/provider.ts";
import { seedDisputePacket } from "../src/ai/run.ts";
import { SchemaError, validateLlmOutput } from "../src/ai/schema.ts";
import { readJson, ROOT, SEED_DIR } from "./helpers.ts";

const ENV = { LLM_API_KEY: "test-key", LLM_DISPUTES_ALLOWED: "true" };
const fixture = (id: string) => readJson<unknown>(join(SEED_DIR, "disputes", id, "llm-response.json"));
const packet = async (id: string) => (await seedDisputePacket({ root: ROOT, id })).packet;

test("recorded fixtures parse and validate", () => {
  const d1 = parseMessage(fixture("D1"));
  assert.match(d1.summary, /Memphis/);
  assert.equal(d1.claims.buyer.length, 2);
  assert.equal(d1.checklist_additions[0]!.provided, "none");
  assert.equal(parseMessage(fixture("D2")).checklist_additions[0]!.evidenceRef, "access-log.csv");
  assert.throws(() => parseMessage(fixture("D3")), SchemaError);
});

test("a malformed fixture triggers one retry, then the heuristic fallback", async () => {
  const p = await packet("D3");
  const bodies: unknown[] = [];
  const prov = new LlmProvider(ENV, async (body) => {
    bodies.push(body);
    return fixture("D3");
  });
  const b = await prov.brief(p);
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify((bodies[1] as { messages: unknown[] }).messages.at(-1)), /rejected/);
  assert.equal(prov.lastRun.fellBack, true);
  assert.equal(b.generatedBy, "heuristic");
  assert.equal(b.digest, heuristicBrief(p).digest);
});

test("a retry that succeeds is used", async () => {
  const p = await packet("D1");
  let n = 0;
  const prov = new LlmProvider(ENV, async () => (n++ === 0 ? { content: [{ type: "text", text: "sorry" }] } : fixture("D1")));
  const b = await prov.brief(p);
  assert.equal(prov.lastRun.attempts, 2);
  assert.equal(b.generatedBy, "llm");
  assert.equal(prov.lastRun.summaryFrom, "llm");
});

test("the schema rejects an outcome/split field at any depth", () => {
  const ok = { summary: "s", claims: { buyer: [], merchant: [] }, questions: { buyer: [], merchant: [] }, inconsistencies: [], checklist_additions: [] };
  assert.doesNotThrow(() => validateLlmOutput(ok));
  for (const bad of [{ ...ok, outcome: "refund" }, { ...ok, split: 0.4 }, { ...ok, recommendation: "x" }, { ...ok, claims: { ...ok.claims, winner: "buyer" } }, { ...ok, checklist_additions: [{ item: "a", whyForReason: "b", provided: "none", refund_amount: 5 }] }]) {
    assert.throws(() => validateLlmOutput(bad), SchemaError);
  }
  assert.throws(() => validateLlmOutput({ ...ok, summary: "word ".repeat(151) }), /150 words/);
  assert.throws(() => validateLlmOutput({ ...ok, extra: 1 }), /unexpected field/);
});

test("the union merge keeps every heuristic item and chain timeline entry", async () => {
  const p = await packet("D1");
  const h = heuristicBrief(p);
  const m = parseMessage(fixture("D1"));
  const { brief } = mergeBrief(h, { ...m, checklist_additions: [...m.checklist_additions, { item: "Tracking number", whyForReason: "dup", provided: "buyer" }] }, p);
  for (const c of h.checklist) assert.ok(brief.checklist.some((x) => x.item === c.item && x.provided === c.provided), c.item);
  assert.equal(brief.checklist.length, h.checklist.length + 1); // the duplicate was not added, the customs item was
  assert.deepEqual(brief.timeline, h.timeline);
  for (const i of h.inconsistencies) assert.ok(brief.inconsistencies.includes(i));
  assert.ok(brief.missing.includes("Customs declaration or hold notice"));
});

test("the guard replaces a summary that invents an amount or a date", async () => {
  const p = await packet("D1");
  const h = heuristicBrief(p);
  const m = parseMessage(fixture("D1"));
  assert.equal(checkNumbers(m.summary, p).ok, true, checkNumbers(m.summary, p).invented.join(","));
  const invented = { ...m, summary: "The buyer paid 72.50 USDC and the parcel was delivered on 2026-09-09." };
  const r = mergeBrief(h, invented, p);
  assert.equal(r.summaryFrom, "heuristic");
  assert.equal(r.brief.summary, h.summary);
  assert.deepEqual(r.invented.sort(), ["2026-09-09", "72.50 USDC"].sort());
  assert.equal(checkNumbers("Paid 64.00 USDC on 03/09/2026.", p).ok, true);
});

test("disabled unless LLM_DISPUTES_ALLOWED=true", () => {
  assert.equal(llmEnabled({ LLM_API_KEY: "k" }), false);
  assert.equal(llmEnabled({ LLM_API_KEY: "k", LLM_DISPUTES_ALLOWED: "yes" }), false);
  assert.equal(llmEnabled({ LLM_DISPUTES_ALLOWED: "true" }), false);
  assert.equal(llmEnabled(ENV), true);
  assert.throws(() => new LlmProvider({ LLM_API_KEY: "k" }), /disabled/);
  assert.throws(() => makeProvider("llm", { LLM_API_KEY: "k" }), /LLM_DISPUTES_ALLOWED/);
  assert.equal(makeProvider("heuristic", {}).name, "heuristic");
});

test("the request carries the redacted packet, the heuristic brief, the model and the arbiter language", async () => {
  const p = await packet("D3");
  const body = buildRequest(p, heuristicBrief(p), { ...ENV, ARBITER_LANG: "es" }) as { model: string; system: string; messages: { content: string }[] };
  assert.equal(body.model, "claude-sonnet-5");
  assert.match(body.system, /never decide/);
  assert.match(body.messages[0]!.content, /"arbiter_language":"es"/);
  assert.doesNotMatch(body.messages[0]!.content, /555-0142|Kedzie|example\.com/);
});
