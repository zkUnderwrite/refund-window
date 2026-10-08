import { test } from "node:test";
import assert from "node:assert/strict";
import { amountOrAll, ArgError, Flags, parseArgv, parseAssetFlag, parseNetwork, refOrDue } from "../src/args.ts";
import { formatDuration, parseDuration } from "../src/duration.ts";

const flags = (argv: string[]) => new Flags(parseArgv(argv));

test("durations 1h|3d|14d and friends", () => {
  assert.equal(parseDuration("1h"), 3_600);
  assert.equal(parseDuration("3d"), 259_200);
  assert.equal(parseDuration("14d"), 1_209_600);
  assert.equal(parseDuration("90m"), 5_400);
  assert.equal(parseDuration("2w"), 1_209_600);
  assert.equal(parseDuration("600"), 600);
  assert.throws(() => parseDuration("3 days"));
  assert.throws(() => parseDuration("-1h"));
  assert.equal(formatDuration(1_209_600), "2w");
  assert.equal(formatDuration(259_200), "3d");
});

test("--all and --amount are mutually exclusive, one is required", () => {
  assert.deepEqual(amountOrAll(flags(["--all"])), { all: true });
  assert.deepEqual(amountOrAll(flags(["--amount", "15.00"])), { all: false, amount: 150_000_000n });
  assert.throws(() => amountOrAll(flags(["--all", "--amount", "1"])), /either --amount or --all/);
  assert.throws(() => amountOrAll(flags([])), /--amount <x> or --all/);
  assert.throws(() => amountOrAll(flags(["--amount", "0"])), /positive/);
  assert.throws(() => amountOrAll(flags(["--amount", "1.123456789"])), /7 decimals/);
});

test("--ref or --due", () => {
  assert.deepEqual(refOrDue(flags(["--due"])), { due: true });
  assert.deepEqual(refOrDue(flags(["--ref", "ORD-1"])), { due: false, ref: "ORD-1" });
  assert.throws(() => refOrDue(flags(["--due", "--ref", "x"])));
});

test("flag syntax: values, booleans, =, positional, unknowns", () => {
  const p = parseArgv(["refund", "--merchant", "m1", "--ref=ORD 1044", "--yes", "--all"]);
  assert.deepEqual(p.positional, ["refund"]);
  assert.equal(p.flags.get("ref"), "ORD 1044");
  assert.equal(p.flags.get("yes"), true);
  assert.throws(() => parseArgv(["--yes=1"]), /does not take a value/);
  assert.throws(() => parseArgv(["--amount"]), /needs a value/);
  assert.throws(() => parseArgv(["--amount", "--all"]), /needs a value/);
  assert.throws(() => parseArgv(["--ref", "a", "--ref", "b"]), /twice/);
  const f = flags(["--ref", "x", "--bogus", "1"]);
  f.str("ref");
  assert.throws(() => f.done(), (e: unknown) => e instanceof ArgError && /--bogus/.test((e as Error).message));
});

test("assets and networks", () => {
  assert.deepEqual(parseAssetFlag("usdc"), { code: "USDC" });
  const g = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  assert.deepEqual(parseAssetFlag(`USDC:${g}`), { code: "USDC", issuer: g });
  assert.throws(() => parseAssetFlag("USDC:nope"));
  assert.equal(parseNetwork("testnet"), "testnet");
  assert.throws(() => parseNetwork("mainnet"), /testnet or local-sim/);
});
