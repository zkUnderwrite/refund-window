import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { latestStatus, manifestHash, manifestLines, parseCarrierCsv, parseCarrierDate, guessKind } from "../src/evidence.ts";
import { SEED_DIR } from "./helpers.ts";

test("carrier dates in both formats (2026-09-03 and 03/09/2026 are the same day)", () => {
  assert.equal(parseCarrierDate("2026-09-03", "10:12"), "2026-09-03T10:12:00Z");
  assert.equal(parseCarrierDate("03/09/2026", "10:12"), "2026-09-03T10:12:00Z");
  assert.throws(() => parseCarrierDate("09-03-2026"));
  assert.throws(() => parseCarrierDate("31/13/2026"));
});

test("D1's carrier CSV parses in order and ends 'in transit'", () => {
  const rows = parseCarrierCsv(readFileSync(join(SEED_DIR, "disputes", "D1", "carrier-status.csv"), "utf8"));
  assert.equal(rows.length, 5);
  assert.equal(rows[1]!.at, "2026-09-04T17:40:00Z"); // written 04/09/2026
  const s = latestStatus(rows);
  assert.equal(s.status, "in transit");
  assert.equal(s.statusAt, "2026-09-11T14:30:00Z");
});

test("manifest hash is independent of item order and matches the seed", () => {
  const a = [{ name: "b.txt", sha256: "11".repeat(32) }, { name: "a.png", sha256: "22".repeat(32) }];
  assert.equal(manifestHash(a), manifestHash([...a].reverse()));
  assert.match(manifestLines(a), /^2{64} {2}a\.png\n1{64} {2}b\.txt\n$/);
  assert.throws(() => manifestHash([]));
  const d1 = JSON.parse(readFileSync(join(SEED_DIR, "disputes", "D1", "buyer-evidence.json"), "utf8"));
  const events = readFileSync(join(SEED_DIR, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ev = events.find((e: { type: string; dispute?: string }) => e.type === "dispute" && e.dispute === "D1");
  assert.equal(manifestHash(d1), ev.evidence_hash);
});

test("kind guessing", () => {
  assert.equal(guessKind("carrier-status.csv"), "tracking");
  assert.equal(guessKind("IMG_2231.jpg"), "photo");
  assert.equal(guessKind("whatsapp-export.txt"), "chat");
  assert.equal(guessKind("access-log.csv"), "access_log");
});
