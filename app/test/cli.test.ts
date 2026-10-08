// Drives the CLI's local-sim network end to end in a temp directory: no RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "refundwin-cli-"));
process.env.REFUNDWIN_DIR = dir;
process.env.REFUNDWIN_HOME = join(dir, "home");
process.env.REFUNDWIN_NETWORK = "local-sim";
delete process.env.LLM_API_KEY;
const { main } = await import("../src/cli.ts");

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const o: string[] = [];
  const e: string[] = [];
  const wo = process.stdout.write.bind(process.stdout);
  const we = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (o.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (e.push(String(s)), true)) as typeof process.stderr.write;
  process.exitCode = 0;
  try {
    const code = await main(argv);
    return { code, out: o.join(""), err: e.join("") };
  } finally {
    process.stdout.write = wo;
    process.stderr.write = we;
    process.exitCode = 0;
  }
}

test("local-sim journey: pay, duplicate, refund confirm, auth, dispute, brief, resolve, keeper, receipt", async () => {
  const ok = async (...a: string[]) => {
    const r = await run(...a);
    assert.equal(r.code, 0, `${a.join(" ")}\n${r.err}`);
    return r.out;
  };
  await ok("init", "--admin", "psp-admin", "--arbiter", "psp-arbiter", "--fee-to", "psp-fees", "--arbiter-timeout", "7d", "--start", "2026-10-01T09:00:00Z");
  await ok("token", "enable", "--admin", "psp-admin", "--asset", "USDC");
  assert.equal((await run("token", "enable", "--admin", "buyer1", "--asset", "EURC")).code, 1); // not the admin
  await ok("merchant", "add", "--admin", "psp-admin", "--merchant", "oaxaca", "--payout", "oaxaca-payout", "--fee-bps", "150", "--window", "14d");
  await ok("sim", "fund", "--to", "buyer1", "--asset", "USDC", "--amount", "200");
  await ok("sim", "fund", "--to", "buyer2", "--asset", "USDC", "--amount", "100");

  const pay = await ok("pay", "--buyer", "buyer1", "--merchant", "oaxaca", "--ref", "ORD-1044", "--asset", "USDC", "--amount", "49.99", "--tz", "-06:00");
  assert.match(pay, /release_at 2026-10-15T09:00:00Z {2}\(2026-10-15 03:00 \(-06:00\)\)/);
  assert.match(pay, /can only go to: G[A-Z2-7]{55} \(the paying wallet\)/);
  const dup = await run("pay", "--buyer", "buyer1", "--merchant", "oaxaca", "--ref", "ord 1044", "--asset", "USDC", "--amount", "49.99");
  assert.equal(dup.code, 1);
  assert.match(dup.err, /DuplicateOrder/);

  // separate refund address must sign
  const noCosign = await run("pay", "--buyer", "buyer2", "--merchant", "oaxaca", "--ref", "#1045", "--asset", "USDC", "--amount", "64.00", "--window", "3d");
  assert.equal(noCosign.code, 0);
  assert.equal((await run("pay", "--buyer", "buyer2", "--merchant", "oaxaca", "--ref", "#1046", "--asset", "USDC", "--amount", "1", "--window", "1m")).code, 1); // window below min
  const two = await ok("pay", "--buyer", "buyer2", "--merchant", "oaxaca", "--ref", "#1047", "--asset", "USDC", "--amount", "20", "--refund-to", "buyer2-cold");
  assert.match(two, /second wallet, signed at checkout/);

  // refunds are final: confirmation needed; only the merchant signs
  const noYes = await run("refund", "--merchant", "oaxaca", "--ref", "ORD1044", "--amount", "15.00");
  assert.equal(noYes.code, 1);
  assert.match(noYes.err, /Refusing without --yes/);
  const wrong = await run("refund", "--merchant", "buyer1", "--ref", "ORD1044", "--all", "--yes");
  assert.match(wrong.err, /must be signed by the merchant/);
  assert.equal((await run("refund", "--merchant", "oaxaca", "--ref", "ORD1044", "--all", "--amount", "1", "--yes")).code, 2);
  assert.match(await ok("refund", "--merchant", "oaxaca", "--ref", "ORD1044", "--amount", "15.00", "--yes"), /still held 34.99/);

  // dispute on #1045 with evidence, merchant responds with a carrier CSV
  writeFileSync(join(dir, "buyer.txt"), "The rebozo never arrived. Call me on +1 (773) 555-0142.\n");
  writeFileSync(join(dir, "merchant.txt"), "Shipped with Estafeta.\n");
  writeFileSync(join(dir, "tracking.csv"), "tracking_no,carrier,status,date,time,location\nEST1,Estafeta,in transit,02/10/2026,10:00,Memphis\n");
  assert.equal((await run("dispute", "--buyer", "buyer1", "--ref", "#1045", "--reason", "NOT_RECEIVED", "--statement", join(dir, "buyer.txt"))).code, 1);
  assert.match(await ok("dispute", "--buyer", "buyer2", "--ref", "#1045", "--reason", "NOT_RECEIVED", "--statement", join(dir, "buyer.txt")), /arbiter can rule until 2026-10-08T09:00:00Z/);
  await ok("respond", "--merchant", "oaxaca", "--ref", "1045", "--statement", join(dir, "merchant.txt"), "--evidence", join(dir, "tracking.csv"));
  await ok("brief", "--ref", "1045", "--out", join(dir, "brief.json"));
  const brief = JSON.parse(readFileSync(join(dir, "brief.json"), "utf8"));
  assert.equal(brief.generatedBy, "heuristic");
  assert.equal(brief.checklist.find((c: { item: string }) => c.item === "Tracking number").provided, "merchant");
  assert.ok(brief.inconsistencies.some((i: string) => /in transit/.test(i)));
  assert.equal((await run("brief", "--ref", "1045", "--provider", "llm")).code, 1); // no key / no sign-off

  writeFileSync(join(dir, "ruling.md"), "40% refund\n");
  assert.match((await run("resolve", "--arbiter", "psp-admin", "--ref", "1045", "--refund", "25.60", "--ruling", join(dir, "ruling.md"), "--yes")).err, /snapshot arbiter/);
  assert.match(await ok("resolve", "--arbiter", "psp-arbiter", "--ref", "1045", "--refund", "25.60", "--ruling", join(dir, "ruling.md"), "--yes"), /25.60 to refund_to, 37.824 net to payout, fee 0.576/);

  // release before T does nothing; after T the keeper releases
  assert.match(await ok("release", "--due"), /0 order\(s\) released/);
  assert.equal((await run("release", "--ref", "ORD-1044")).code, 1); // WindowOpen
  await ok("sim", "advance", "--by", "14d");
  assert.match(await ok("keeper", "--once"), /released 2 in 1 batch/);

  // receipt round trip, then a tampered copy
  const rpath = join(dir, "r.json");
  await ok("receipt", "--ref", "ORD-1044", "--out", rpath);
  assert.match(await ok("receipt", "--ref", "ORD-1044", "--verify", rpath), /^MATCH/);
  const r = JSON.parse(readFileSync(rpath, "utf8"));
  r.refunded = "0.0000000";
  writeFileSync(rpath, JSON.stringify(r));
  const bad = await run("receipt", "--ref", "ORD-1044", "--verify", rpath);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /MISMATCH[\s\S]*refunded: receipt "0.0000000" vs chain "15.0000000"/);

  assert.match(await ok("fees", "withdraw", "--admin", "psp-admin", "--asset", "USDC"), /withdrew 1.40085 USDC/);
  const cache = JSON.parse(readFileSync(join(dir, "home", "receipts", `${r.order_id}.json`), "utf8"));
  assert.deepEqual(cache.txs.map((t: { type: string }) => t.type), ["pay", "refund", "release"]);
});

test("express mode on local-sim: refund-to refused, merchant cannot claim before T, buyer reclaims", async () => {
  const r1 = await run("express", "pay", "--buyer", "buyer1", "--merchant", "oaxaca", "--ref", "PRE-1", "--asset", "USDC", "--amount", "10", "--release-in", "14d", "--refund-to", "buyer2");
  assert.equal(r1.code, 2);
  assert.match(r1.err, /refuses --refund-to/);
  const p = await run("express", "pay", "--buyer", "buyer1", "--merchant", "oaxaca", "--ref", "PRE-1", "--asset", "USDC", "--amount", "10", "--release-in", "14d");
  assert.equal(p.code, 0, p.err);
  const id = /claimable balance ([0-9a-f]{72})/.exec(p.out)![1]!;
  assert.match((await run("express", "claim", "--id", id, "--merchant", "oaxaca")).err, /CANNOT_CLAIM/);
  assert.match((await run("express", "reclaim", "--id", id, "--buyer", "buyer1")).out, /buyer claimed 10.0000000 USDC/);
  assert.match((await run("express", "reclaim", "--id", id, "--buyer", "buyer1")).err, /DOES_NOT_EXIST/);
});

test("simulate exits 0 and prints MATCH; unknown commands and flags are usage errors", async () => {
  const s = await run("simulate");
  assert.equal(s.code, 0);
  assert.match(s.out, /MATCH expected.json/);
  assert.equal((await run("frobnicate")).code, 2);
  assert.equal((await run("simulate", "--bogus", "1")).code, 2);
  assert.match((await run("--help")).out, /refundwin/);
});
