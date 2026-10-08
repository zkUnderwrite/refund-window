import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../src/ai/redact.ts";
import { SEED_DIR } from "./helpers.ts";

test("D3's phone number, street address, email and card number are removed", () => {
  const raw = readFileSync(join(SEED_DIR, "disputes", "D3", "buyer-statement.txt"), "utf8");
  const r = redact(raw);
  assert.doesNotMatch(r.text, /555-0142/);
  assert.doesNotMatch(r.text, /Kedzie/);
  assert.doesNotMatch(r.text, /60625/);
  assert.doesNotMatch(r.text, /@example\.com/);
  assert.doesNotMatch(r.text, /4242/);
  assert.deepEqual(r.counts, { email: 1, phone: 1, address: 1, card: 1 });
  assert.match(r.text, /Card on file ending \[CARD\] was not used/);
});

test("amounts, dates and order numbers survive", () => {
  const s = "Pagué 64.00 USDC el 2026-09-03 por la orden ORD-1033; total 1999.00.";
  assert.equal(redact(s).text, s);
});

test("Spanish and Portuguese street patterns", () => {
  assert.match(redact("Envíen a Calle Reforma 222, CDMX").text, /\[ADDRESS\]/);
  assert.match(redact("Moro na Rua Augusta, 1500 em São Paulo").text, /\[ADDRESS\]/);
  assert.match(redact("Llámame al +52 55 1234 5678").text, /\[PHONE\]/);
});
