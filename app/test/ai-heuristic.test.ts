import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKLISTS, heuristicBrief, HeuristicProvider } from "../src/ai/heuristic.ts";
import { seedDisputePacket } from "../src/ai/run.ts";
import { assertNoOutcomeKeys, wordCount } from "../src/ai/schema.ts";
import type { DisputePacket } from "../src/ai/types.ts";
import { ROOT } from "./helpers.ts";

const packet = async (id: string, asOf?: string) => (await seedDisputePacket({ root: ROOT, id, ...(asOf ? { asOf } : {}) })).packet;

test("a checklist per reason code", () => {
  assert.deepEqual(CHECKLISTS.NOT_RECEIVED!.map((r) => r.item), [
    "Tracking number",
    "Carrier status showing delivery",
    "Delivery address matches the order",
    "Delivery date before the dispute was opened",
  ]);
  assert.equal(CHECKLISTS.NOT_AS_DESCRIBED!.length, 4);
  assert.match(CHECKLISTS.DIGITAL_NOT_DELIVERED![0]!.item, /Access log/);
  assert.match(CHECKLISTS.DUPLICATE_CHARGE![0]!.item, /24 h/);
  assert.match(CHECKLISTS.CANCELLED_BEFORE_FULFILMENT![0]!.item, /Cancellation/);
  for (const reason of Object.keys(CHECKLISTS)) {
    const p = { receipt: { paid_at: "2026-09-01T00:00:00Z" }, reason, buyerStatement: "x", buyerEvidence: [], merchantEvidence: [], merchantPolicy: { window_s: 1 } } as unknown as DisputePacket;
    const b = heuristicBrief(p);
    assert.equal(b.checklist.length, CHECKLISTS[reason]!.length, reason);
    assert.ok(b.checklist.every((c) => c.provided === "none"), reason);
  }
});

test("D1: 'in transit' is flagged as an inconsistency against no delivery", async () => {
  const b = heuristicBrief(await packet("D1"));
  assert.equal(b.generatedBy, "heuristic");
  assert.ok(b.inconsistencies.some((i) => /in transit/.test(i) && /not a delivery/.test(i)), b.inconsistencies.join("; "));
  const byItem = Object.fromEntries(b.checklist.map((c) => [c.item, c.provided]));
  assert.equal(byItem["Tracking number"], "merchant");
  assert.equal(byItem["Carrier status showing delivery"], "none");
  assert.ok(b.missing.includes("Carrier status showing delivery"));
  assert.ok(b.timeline.some((t) => t.source === "chain" && /paid/.test(t.event)));
  assert.ok(b.timeline.some((t) => t.source === "merchant" && /in transit/.test(t.event)));
});

test("D2: missing an access log until the merchant provides it", async () => {
  const before = heuristicBrief(await packet("D2", "2026-09-22T12:00:00Z"));
  assert.ok(before.missing.some((m) => /Access log/.test(m)));
  const after = heuristicBrief(await packet("D2"));
  assert.ok(!after.missing.some((m) => /Access log/.test(m)));
  assert.equal(after.checklist.find((c) => /Access log/.test(c.item))!.evidenceRef, "access-log.csv");
  assert.ok(after.inconsistencies.some((i) => /no login/.test(i)));
});

test("D3: delivery dated before payment and a wrong address are flagged; statement is redacted", async () => {
  const p = await packet("D3");
  const b = heuristicBrief(p);
  assert.ok(b.inconsistencies.some((i) => /before the payment/.test(i)));
  assert.ok(b.inconsistencies.some((i) => /does not match the order/.test(i)));
  assert.doesNotMatch(p.buyerStatement, /555-0142|Kedzie/);
});

test("deterministic, short, and never an outcome", async () => {
  const p = await packet("D1");
  const a = await new HeuristicProvider().brief(p);
  const b = heuristicBrief(p);
  assert.equal(a.digest, b.digest);
  assert.ok(wordCount(a.summary) <= 150);
  assert.doesNotThrow(() => assertNoOutcomeKeys(a));
  assert.doesNotMatch(JSON.stringify(a), /recommend|winner|should (refund|release)/i);
});
