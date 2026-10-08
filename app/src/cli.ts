#!/usr/bin/env node
// refundwin: CLI for the refund_escrow contract, express mode, receipts, the
// keeper and dispute briefs. `--network local-sim` (default) runs everything
// against the TypeScript contract model with no network; `--network testnet`
// uses Stellar RPC (written for testnet; not run in this environment).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { Account, Asset, Keypair, xdr } from "@stellar/stellar-sdk";
import { amountOrAll, ArgError, Flags, parseArgv, parseAssetFlag, parseNetwork, refOrDue } from "./args.ts";
import { displayAmount, formatAmount, parseAmount } from "./amount.ts";
import { formatDuration, isoUtc, localTime, parseDuration } from "./duration.ts";
import { appConfig, loadEnv, projectRoot } from "./env.ts";
import { ContractError } from "./errors.ts";
import { hashFiles, latestStatus, manifestHash, parseCarrierCsv, type EvidenceItem } from "./evidence.ts";
import { resolveAddress, resolveKeypair } from "./keys.ts";
import { runKeeperOnce, MAX_BATCH, batches, dueReleases, dueTimeouts, type KeeperExecutor } from "./keeper.ts";
import { orderIdHex, sha256Hex } from "./orderid.ts";
import { reasonCode, reasonName } from "./reasons.ts";
import { appendTx, buildReceipt, verifyReceipt, type Receipt, type ReceiptEvent } from "./receipt.ts";
import { SimBackend, indexOrders, type Backend, type TxRef } from "./backend.ts";
import { RpcBackend } from "./backend-rpc.ts";
import { ChainClient } from "./tx/rpc.ts";
import { constructorArgs } from "./tx/args.ts";
import { emptyIndex, findOrderId, loadIndex, saveIndex, type LocalIndex } from "./state.ts";
import { canonicalJson } from "./canonical.ts";
import { loadSeed, runSimulation } from "./sim/simulate.ts";
import { generateSeed } from "./seed/generate.ts";
import { buildClaim, buildExpressPay, buildReclaim, balanceIdFromResult, checkPreflight, checkWindow, expressStatus } from "./express.ts";
import { CANNOT_CLAIM } from "./sim/express-model.ts";
import { makeProvider } from "./ai/provider.ts";
import { LlmProvider } from "./ai/llm.ts";
import { briefToMarkdown, buildPacket, type DisputeDir } from "./ai/packet.ts";
import { seedDisputePacket, seedFixture } from "./ai/run.ts";
import type { DisputePacket } from "./ai/types.ts";

const env = loadEnv();
const cfg = appConfig(env);
const dir = resolve(env.REFUNDWIN_DIR ?? process.cwd());

const out = (s = "") => process.stdout.write(s + "\n");

const HELP = `refundwin — refund windows and dispute escrow for stablecoin checkouts

Global: --network local-sim|testnet (default local-sim, or REFUNDWIN_NETWORK)

  init --admin <alias> --arbiter <alias|G…> --fee-to <alias|G…> --arbiter-timeout 7d --min-window 1h --max-window 60d [--contract C…]
  token enable --admin <alias> --asset USDC[:G…issuer]
  merchant add --admin <alias> --merchant <alias> --payout <alias|G…> --fee-bps 150 --window 14d
  pay --buyer <alias> --merchant <G…|alias> --ref "ORD-1044" --asset USDC --amount 49.99 [--refund-to <alias>] [--window 3d] [--items items.json] [--tz -06:00]
  refund --merchant <alias> --ref "ORD-1044" --amount 15.00|--all [--yes]
  settle-refund --ref … [--merchant G…] [--caller <alias>]
  dispute --buyer <alias> --ref … --reason NOT_RECEIVED --statement buyer.txt [--evidence f1,f2]
  respond --merchant <alias> --ref … --statement merchant.txt [--evidence f1,f2]
  brief --ref … | --seed D1 [--as-of <iso>] [--provider heuristic|llm] [--fixture llm-response.json] [--out brief.json|brief.md]
  resolve --arbiter <alias> --ref … --refund 20.00 --ruling ruling.md [--yes]
  withdraw-dispute --buyer <alias> --ref …
  release --ref … | --due        timeout --ref … | --due
  keeper [--once] [--interval 10m] [--caller <alias>]
  receipt --ref … [--json] [--out receipt.json] [--verify receipt.json]
  express pay --buyer <alias> --merchant <G…|alias> --ref … --asset USDC --amount 32.40 --release-in 14d
  express reclaim|claim|status --id <balance id> [--buyer|--merchant <alias>]
  express account --who <alias|G…>   XLM balance and subentries (reserve check, verify-first item (b))
  fees withdraw --admin <alias> --asset USDC
  simulate [--json]              run the seed offline; exit 1 if counts differ from expected.json
  seed                           regenerate data/seed/* and contracts/refund_escrow/src/test_seed.rs
  sim fund|advance|deauth|reauth|time   local-sim helpers (test tokens, clock, trustline authorisation)
`;

// ---------------------------------------------------------------------------

interface Ctx {
  network: "testnet" | "local-sim";
  f: Flags;
}

function index(network: Ctx["network"]): LocalIndex {
  const idx = loadIndex(dir);
  if (!idx) throw new Error(`no ${join(dir, ".refundwin.json")}: run \`refundwin init --network ${network} …\` first`);
  if (idx.network !== network) throw new Error(`.refundwin.json is for ${idx.network}; pass --network ${idx.network}`);
  return idx;
}

function backend(network: Ctx["network"], idx?: LocalIndex): Backend {
  if (network === "local-sim") return SimBackend.load(dir);
  const contractId = cfg.contractId ?? idx?.contractId;
  return new RpcBackend(new ChainClient({ rpcUrl: cfg.rpcUrl, networkPassphrase: cfg.networkPassphrase, ...(contractId ? { contractId } : {}) }));
}

const kp = (c: Ctx, alias: string) => resolveKeypair(alias, c.network, env);
const address = (c: Ctx, v: string) => resolveAddress(v, c.network, env);

function tokenOf(idx: LocalIndex, code: string): { id: string; issuer?: string } {
  const t = idx.tokens[code.toUpperCase()];
  if (!t) throw new Error(`asset ${code} is not enabled here; run \`refundwin token enable --asset ${code}…\``);
  return t;
}

function record(orderId: string, type: string, tx: TxRef, amounts: Record<string, string> = {}): void {
  appendTx(orderId, { type, tx_hash: tx.hash, ledger: tx.ledger, at: isoUtc(tx.at), ...(Object.keys(amounts).length ? { amounts } : {}) });
}

function printTx(tx: TxRef): void {
  out(`  tx ${tx.hash}  ledger ${tx.ledger}  ${isoUtc(tx.at)}`);
}

async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) throw new Error(`${question} Refusing without --yes (stdin is not a terminal).`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} Type "yes" to continue: `)).trim().toLowerCase();
  rl.close();
  if (a !== "yes") throw new Error("aborted");
}

function orderIdFor(c: Ctx, idx: LocalIndex, ref: string, merchantFlag?: string): string {
  if (merchantFlag) {
    const id = orderIdHex(address(c, merchantFlag), ref);
    // Not ours? Fall back to the index so a wrong signer meets the auth check.
    if (idx.orders[id] || c.network === "testnet") return id;
  }
  return findOrderId(idx, ref);
}

function readFile(p: string): string {
  if (!existsSync(p)) throw new ArgError(`file not found: ${p}`);
  return readFileSync(p, "utf8");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(c: Ctx): Promise<void> {
  const admin = kp(c, c.f.req("admin"));
  const arbiter = address(c, c.f.req("arbiter"));
  const feeTo = address(c, c.f.req("fee-to"));
  const arbiterTimeout = c.f.duration("arbiter-timeout") ?? parseDuration("7d");
  const minWindow = c.f.duration("min-window") ?? cfg.minWindow;
  const maxWindow = c.f.duration("max-window") ?? cfg.maxWindow;
  const wasmPath = c.f.str("wasm") ?? join(projectRoot(), "target", "wasm32v1-none", "release", "refund_escrow.wasm");
  const start = c.f.str("start");
  const existing = c.f.str("contract");
  c.f.done();
  let contractId: string;
  if (existing) {
    if (c.network !== "testnet") throw new ArgError("--contract attaches a deployed testnet contract; local-sim has none");
    contractId = existing; // deployed and constructed by scripts/deploy-testnet.sh
  } else if (c.network === "local-sim") {
    const now = start ? Math.floor(Date.parse(start) / 1000) : undefined;
    SimBackend.create(dir, { admin, arbiter, feeTo, arbiterTimeout, minWindow, maxWindow }, now);
    contractId = "local-sim";
  } else {
    const client = new ChainClient({ rpcUrl: cfg.rpcUrl, networkPassphrase: cfg.networkPassphrase });
    const r = await client.deploy(
      readFileSync(wasmPath),
      constructorArgs({ admin: admin.publicKey(), arbiter, feeTo, arbiterTimeout, minWindow, maxWindow }),
      admin,
    );
    contractId = r.contractId;
    out(`wasm hash ${r.wasmHash}`);
  }
  const idx = emptyIndex(c.network, contractId);
  idx.admin = admin.publicKey();
  saveIndex(dir, idx);
  out(`contract ${contractId} (${c.network})`);
  out(`  admin ${admin.publicKey()}\n  arbiter ${arbiter}\n  fee_to ${feeTo}`);
  out(`  arbiter timeout ${formatDuration(arbiterTimeout)}, windows ${formatDuration(minWindow)}..${formatDuration(maxWindow)}`);
  out(`wrote ${join(dir, ".refundwin.json")}`);
}

async function cmdToken(c: Ctx, sub: string | undefined): Promise<void> {
  if (sub !== "enable" && sub !== "disable") throw new ArgError("usage: token enable|disable --admin <alias> --asset CODE[:ISSUER]");
  const idx = index(c.network);
  const admin = kp(c, c.f.req("admin"));
  const a = parseAssetFlag(c.f.req("asset"));
  c.f.done();
  const b = backend(c.network, idx);
  const id = b.tokenId(a.code, a.issuer);
  const tx = await b.setToken(id, sub === "enable", admin);
  idx.tokens[a.code] = { id, ...(a.issuer ? { issuer: a.issuer } : {}) };
  saveIndex(dir, idx);
  out(`${sub}d ${a.code} (${id})`);
  printTx(tx);
}

async function cmdMerchant(c: Ctx, sub: string | undefined): Promise<void> {
  if (sub !== "add") throw new ArgError("usage: merchant add --admin <alias> --merchant <alias> --payout <G…> --fee-bps 150 --window 14d");
  const idx = index(c.network);
  const admin = kp(c, c.f.req("admin"));
  const merchant = kp(c, c.f.req("merchant"));
  const payout = address(c, c.f.req("payout"));
  const feeBps = c.f.int("fee-bps") ?? 0;
  const window = c.f.duration("window") ?? parseDuration("14d");
  c.f.done();
  const tx = await backend(c.network, idx).addMerchant(merchant, payout, feeBps, window, admin);
  idx.merchants[merchant.publicKey()] = { payout, feeBps, window };
  saveIndex(dir, idx);
  out(`merchant ${merchant.publicKey()} payout ${payout} fee ${feeBps} bps window ${formatDuration(window)}`);
  printTx(tx);
}

async function cmdPay(c: Ctx): Promise<void> {
  const idx = index(c.network);
  const buyer = kp(c, c.f.req("buyer"));
  const merchant = address(c, c.f.req("merchant"));
  const ref = c.f.req("ref");
  const assetCode = parseAssetFlag(c.f.req("asset")).code;
  const amount = parseAmount(c.f.req("amount"));
  const refundToAlias = c.f.str("refund-to");
  const window = c.f.duration("window");
  const itemsFile = c.f.str("items");
  const tz = c.f.str("tz") ?? env.BUYER_TZ ?? "+00:00";
  c.f.done();
  const refundTo = refundToAlias ? kp(c, refundToAlias) : undefined;
  const token = tokenOf(idx, assetCode);
  const items = itemsFile ? JSON.parse(readFile(itemsFile)) : [];
  const memoHash = sha256Hex(canonicalJson({ ref: ref.trim(), items }));
  const orderId = orderIdHex(merchant, ref);
  const b = backend(c.network, idx);
  const tx = await b.pay(
    buyer,
    {
      buyer: buyer.publicKey(),
      merchant,
      orderId,
      token: token.id,
      amount,
      refundTo: refundTo?.publicKey() ?? null,
      window: window ?? null,
      memoHash,
    },
    refundTo,
  );
  idx.orders[orderId] = { ref, merchant, token: token.id, asset: assetCode, ...(itemsFile ? { items } : {}) };
  saveIndex(dir, idx);
  const o = (await b.order(orderId))!;
  record(orderId, "pay", tx, { amount: formatAmount(amount) });
  out(`order_id   ${orderId}`);
  out(`amount     ${displayAmount(amount)} ${assetCode}`);
  out(`release_at ${isoUtc(o.release_at)}  (${localTime(o.release_at, tz)})`);
  out(`refunds for this order can only go to: ${o.refund_to}${o.refund_to === buyer.publicKey() ? " (the paying wallet)" : " (second wallet, signed at checkout)"}`);
  printTx(tx);
}

async function cmdRefund(c: Ctx): Promise<void> {
  const idx = index(c.network);
  const merchant = kp(c, c.f.req("merchant"));
  const ref = c.f.req("ref");
  const amt = amountOrAll(c.f);
  const yes = c.f.bool("yes");
  c.f.done();
  // Resolve by the merchant's own address first; fall back to the index so a
  // wrong signer gets the contract's auth failure, not "order not found".
  const own = orderIdHex(merchant.publicKey(), ref);
  const id = idx.orders[own] ? own : findOrderId(idx, ref);
  const b = backend(c.network, idx);
  const o = await b.order(id);
  if (!o) throw new ContractError(10);
  const amount = amt.all ? o.held : amt.amount;
  const asset = idx.orders[id]?.asset ?? "";
  await confirm(`Refund ${displayAmount(amount)} ${asset} of ${ref} to ${o.refund_to}? Refunds are final.`, yes);
  const tx = await b.refund(id, amount, merchant);
  const after = (await b.order(id))!;
  record(id, "refund", tx, { amount: formatAmount(amount) });
  out(`refunded ${displayAmount(amount)} ${asset} to ${after.refund_to}; state ${after.state}, still held ${displayAmount(after.held)}`);
  if (after.refund_owed > 0n) {
    out(`  PENDING: ${displayAmount(after.refund_owed)} could not be delivered (refund address cannot receive this asset). The keeper retries settle-refund.`);
  }
  printTx(tx);
}

async function withOrder(c: Ctx, fn: (id: string, idx: LocalIndex, b: Backend) => Promise<void>): Promise<void> {
  const idx = index(c.network);
  const ref = c.f.req("ref");
  const merchantFlag = c.f.str("merchant");
  const id = orderIdFor(c, idx, ref, merchantFlag);
  await fn(id, idx, backend(c.network, idx));
}

function callerOf(c: Ctx): Keypair {
  return kp(c, c.f.str("caller") ?? env.KEEPER_KEY ?? "keeper");
}

async function cmdSettle(c: Ctx): Promise<void> {
  await withOrder(c, async (id, _idx, b) => {
    const caller = callerOf(c);
    c.f.done();
    const r = await b.settleRefund(id, caller);
    record(id, "refund_settled", r.tx, { amount: formatAmount(r.value) });
    out(`settled ${displayAmount(r.value)} to the refund address`);
    printTx(r.tx);
  });
}

function evidenceFrom(c: Ctx, statementPath: string, files: string[], now: number): { items: EvidenceItem[]; hash: string; statement: string } {
  const statement = readFile(statementPath);
  const submittedAt = isoUtc(now);
  const items: EvidenceItem[] = [
    { name: "statement.txt", kind: "statement", sha256: sha256Hex(statement), submittedAt },
    ...hashFiles(files).map((i, n) => {
      const item: EvidenceItem = { ...i, submittedAt };
      if (i.kind === "tracking" && files[n]!.endsWith(".csv")) {
        try {
          item.extracted = latestStatus(parseCarrierCsv(readFile(files[n]!)));
        } catch {
          // not a carrier-status export; hashed but not interpreted
        }
      }
      return item;
    }),
  ];
  void c;
  return { items, hash: manifestHash(items), statement };
}

async function cmdDispute(c: Ctx): Promise<void> {
  await withOrder(c, async (id, idx, b) => {
    const buyer = kp(c, c.f.req("buyer"));
    const reason = c.f.req("reason");
    const code = reasonCode(reason);
    const ev = evidenceFrom(c, c.f.req("statement"), c.f.list("evidence"), await b.now());
    c.f.done();
    const tx = await b.dispute(id, code, ev.hash, buyer);
    idx.disputes[id] = { ...(idx.disputes[id] ?? {}), reason: reasonName(code), buyer: { statement: ev.statement, items: ev.items, hash: ev.hash } };
    saveIndex(dir, idx);
    const o = (await b.order(id))!;
    record(id, "dispute", tx, { reason: String(code) });
    out(`dispute opened (${reasonName(code)}); evidence manifest ${ev.hash}`);
    out(`release is frozen; the arbiter can rule until ${isoUtc(o.resolve_by)}, after which anyone can trigger a full refund`);
    printTx(tx);
  });
}

async function cmdRespond(c: Ctx): Promise<void> {
  await withOrder(c, async (id, idx, b) => {
    const merchant = kp(c, c.f.req("merchant"));
    const ev = evidenceFrom(c, c.f.req("statement"), c.f.list("evidence"), await b.now());
    c.f.done();
    const tx = await b.respond(id, ev.hash, merchant);
    const d = idx.disputes[id] ?? { reason: "OTHER" };
    idx.disputes[id] = { ...d, merchant: { statement: ev.statement, items: ev.items, hash: ev.hash } };
    saveIndex(dir, idx);
    record(id, "respond", tx);
    out(`merchant evidence recorded; manifest ${ev.hash}`);
    printTx(tx);
  });
}

async function cmdWithdrawDispute(c: Ctx): Promise<void> {
  await withOrder(c, async (id, _idx, b) => {
    const buyer = kp(c, c.f.req("buyer"));
    c.f.done();
    const tx = await b.withdrawDispute(id, buyer);
    record(id, "dispute_withdrawn", tx);
    out("dispute withdrawn; the order is Held again (no second dispute is possible)");
    printTx(tx);
  });
}

async function cmdResolve(c: Ctx): Promise<void> {
  await withOrder(c, async (id, idx, b) => {
    const arbiter = kp(c, c.f.req("arbiter"));
    const refund = parseAmount(c.f.req("refund"));
    const ruling = readFile(c.f.req("ruling"));
    const yes = c.f.bool("yes");
    c.f.done();
    const o = await b.order(id);
    if (!o) throw new ContractError(10);
    const asset = idx.orders[id]?.asset ?? "";
    await confirm(
      `Rule ${displayAmount(refund)} ${asset} to the buyer (${o.refund_to}) and ${displayAmount(o.held - refund)} to the merchant (less fee)? Rulings are final.`,
      yes,
    );
    const rulingHash = sha256Hex(ruling);
    const tx = await b.resolve(id, refund, rulingHash, arbiter);
    const after = (await b.order(id))!;
    record(id, "resolve", tx, { refund_amount: formatAmount(refund) });
    out(`resolved: ${displayAmount(after.refunded)} to refund_to, ${displayAmount(after.released)} net to payout, fee ${displayAmount(after.fee)}; ruling ${rulingHash}`);
    printTx(tx);
  });
}

async function cmdReleaseOrTimeout(c: Ctx, kind: "release" | "timeout"): Promise<void> {
  const idx = index(c.network);
  const which = refOrDue(c.f);
  const merchantFlag = c.f.str("merchant");
  const caller = callerOf(c);
  c.f.done();
  const b = backend(c.network, idx);
  if (!which.due) {
    const id = orderIdFor(c, idx, which.ref, merchantFlag);
    const tx = kind === "release" ? await b.release(id, caller) : await b.timeoutRefund(id, caller);
    record(id, kind, tx);
    out(`${kind === "release" ? "released" : "timed out (full refund)"} ${which.ref}`);
    printTx(tx);
    return;
  }
  const now = await b.now();
  const list = await indexOrders(b, Object.keys(idx.orders));
  if (kind === "release") {
    const due = dueReleases(list, now);
    let n = 0;
    for (const batch of batches(due, MAX_BATCH)) {
      const r = await b.releaseMany(batch, caller);
      n += r.value;
      for (const id of batch) record(id, "release", r.tx);
      out(`release_many(${batch.length}) -> ${r.value} released`);
      printTx(r.tx);
    }
    out(`${n} order(s) released (${due.length} due at ${isoUtc(now)})`);
  } else {
    const due = dueTimeouts(list, now);
    for (const id of due) {
      const tx = await b.timeoutRefund(id, caller);
      record(id, "timeout", tx);
      out(`timeout_refund ${idx.orders[id]?.ref ?? id}`);
    }
    out(`${due.length} dispute(s) timed out`);
  }
}

async function cmdKeeper(c: Ctx): Promise<void> {
  const idx = index(c.network);
  const once = c.f.bool("once");
  const interval = c.f.duration("interval") ?? cfg.keeperInterval;
  const caller = callerOf(c);
  c.f.done();
  for (;;) {
    const b = backend(c.network, idx);
    const now = await b.now();
    const exec: KeeperExecutor = {
      async releaseMany(ids) {
        const r = await b.releaseMany(ids, caller);
        for (const id of ids) record(id, "release", r.tx);
        return r.value;
      },
      async timeoutRefund(id) {
        record(id, "timeout", await b.timeoutRefund(id, caller));
      },
      async settleRefund(id) {
        const r = await b.settleRefund(id, caller);
        record(id, "refund_settled", r.tx, { amount: formatAmount(r.value) });
        return r.value;
      },
    };
    const rep = await runKeeperOnce(await indexOrders(b, Object.keys(idx.orders)), now, exec);
    out(
      `${isoUtc(now)} keeper: released ${rep.released} in ${rep.batches.length} batch(es), timed out ${rep.timedOut.length}, ` +
        `settled ${rep.settled.length}, pending still owed ${rep.settleFailures.length}`,
    );
    if (once) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

async function receiptFor(c: Ctx, id: string, idx: LocalIndex, b: Backend, ref: string): Promise<{ receipt: Receipt; json: string; digest: string }> {
  const o = await b.order(id);
  if (!o) throw new ContractError(10);
  const meta = idx.orders[id];
  const code = meta?.asset ?? "?";
  const issuer = idx.tokens[code]?.issuer ?? (c.network === "local-sim" ? "local-sim test asset (not real)" : "?");
  let events: ReceiptEvent[] = await b.events(id);
  if (c.network === "testnet") events = mergeCached(id, events);
  return buildReceipt(o, { contract: b.contractId, networkPassphrase: b.networkPassphrase, orderId: id, asset: { code, issuer }, merchantRef: ref, events });
}

function mergeCached(id: string, chain: ReceiptEvent[]): ReceiptEvent[] {
  const p = join(env.REFUNDWIN_HOME ?? join(process.env.HOME ?? ".", ".refundwin"), "receipts", `${id}.json`);
  if (!existsSync(p)) return chain;
  const cached = (JSON.parse(readFileSync(p, "utf8")) as { txs: { type: string; tx_hash: string; ledger?: number; at?: string; amounts?: Record<string, string> }[] }).txs;
  const seen = new Set(chain.map((e) => `${e.tx_hash}|${e.type}`));
  const extra = cached
    .filter((t) => !seen.has(`${t.tx_hash}|${t.type}`))
    .map((t) => ({ type: t.type, ledger: t.ledger ?? 0, tx_hash: t.tx_hash, ...(t.at ? { at: t.at } : {}), amounts: t.amounts ?? {} }));
  return [...chain, ...extra];
}

async function cmdReceipt(c: Ctx): Promise<void> {
  await withOrder(c, async (id, idx, b) => {
    const json = c.f.bool("json");
    const outFile = c.f.str("out");
    const verify = c.f.str("verify");
    c.f.done();
    const ref = idx.orders[id]?.ref ?? "";
    if (verify) {
      const stored = JSON.parse(readFile(verify)) as Receipt;
      const now = await b.now();
      const rep = await verifyReceipt(stored, {
        readOrder: () => b.order(id),
        ...(c.network === "local-sim"
          ? {
              lookupTx: async (h: string) => ((await b.events(id)).some((e) => e.tx_hash === h) ? "found" : "missing"),
            }
          : {
              lookupTx: async (h: string) => {
                const r = await (b as RpcBackend).client.server.getTransaction(h);
                return r.status === "NOT_FOUND" ? undefined : "found";
              },
              oldestLedger: (await (b as RpcBackend).client.server.getLatestLedger()).sequence - 7 * 17_280,
            }),
      });
      void now;
      out(rep.status);
      if (!rep.digestOk) out("  digest does not match the receipt body");
      for (const d of rep.differences) out(`  ${d.field}: receipt ${JSON.stringify(d.receipt)} vs chain ${JSON.stringify(d.chain)}`);
      for (const t of rep.txChecks) out(`  tx ${t.tx_hash}: ${t.result}`);
      if (rep.status !== "MATCH") process.exitCode = 1;
      return;
    }
    const r = await receiptFor(c, id, idx, b, ref);
    const text = JSON.stringify(r.receipt, null, 2) + "\n";
    if (outFile) writeFileSync(outFile, text);
    if (json) out(text.trimEnd());
    else {
      const x = r.receipt;
      out(`receipt ${ref} (${String(x.state)})  ${String(x.amount)} ${String(x.asset_code)}`);
      out(`  refunded ${String(x.refunded)}  released ${String(x.released)}  fee ${String(x.fee)}  held ${String(x.held)}`);
      out(`  refund_to ${String(x.refund_to)}  payout ${String(x.payout)}`);
      out(`  ${(x.events as ReceiptEvent[]).length} event(s); digest ${r.digest}${outFile ? `; wrote ${outFile}` : ""}`);
    }
  });
}

async function cmdBrief(c: Ctx): Promise<void> {
  const seedId = c.f.str("seed");
  const ref = seedId ? undefined : c.f.req("ref");
  const merchantFlag = c.f.str("merchant");
  const asOf = c.f.str("as-of");
  const providerName = (c.f.str("provider") ?? "heuristic") as "heuristic" | "llm";
  const fixture = c.f.str("fixture");
  const outFile = c.f.str("out");
  const policyFile = c.f.str("policy");
  c.f.done();
  if (providerName !== "heuristic" && providerName !== "llm") throw new ArgError("--provider must be heuristic or llm");
  let packet: DisputePacket;
  let label: string;
  const root = projectRoot();
  if (seedId) {
    const r = await seedDisputePacket({ root, id: seedId, ...(asOf ? { asOf } : {}) });
    packet = r.packet;
    label = `${seedId} (${r.orderRef.trim()}, as of ${r.asOf})`;
  } else {
    const idx = index(c.network);
    const id = orderIdFor(c, idx, ref!, merchantFlag);
    const b = backend(c.network, idx);
    const d = idx.disputes[id];
    if (!d?.buyer) throw new Error(`no dispute evidence for ${ref} in the local index`);
    const { receipt } = await receiptFor(c, id, idx, b, ref!);
    const o = (await b.order(id))!;
    const dd: DisputeDir = {
      meta: { id, order_n: 0, order_ref: ref!, reason: d.reason },
      buyerStatement: d.buyer.statement,
      ...(d.merchant ? { merchantStatement: d.merchant.statement } : {}),
      buyerEvidence: d.buyer.items,
      merchantEvidence: d.merchant?.items ?? [],
    };
    packet = buildPacket(receipt, dd, {
      policy: { window_s: o.release_at - o.paid_at, ...(policyFile ? { returnPolicyText: readFile(policyFile) } : {}) },
    });
    label = ref!;
  }
  const llmEnv = { ...env, ...(fixture && !env.LLM_API_KEY ? { LLM_API_KEY: "recorded-fixture" } : {}) };
  const transport = fixture
    ? async () => JSON.parse(readFile(fixture))
    : seedId && providerName === "llm" && !env.LLM_API_KEY
      ? async () => seedFixture(root, seedId)
      : undefined;
  const provider = makeProvider(providerName, seedId && providerName === "llm" && !env.LLM_API_KEY ? { ...llmEnv, LLM_API_KEY: "recorded-fixture" } : llmEnv, transport);
  const brief = await provider.brief(packet);
  if (provider instanceof LlmProvider) {
    const r = provider.lastRun;
    const src = transport ? " (replaying a recorded fixture; no API call)" : "";
    out(`llm${src}: ${r.attempts} attempt(s)${r.fellBack ? `, fell back to the heuristic brief (${r.error})` : `, summary from ${r.summaryFrom}`}${r.invented?.length ? `; guard rejected ${r.invented.join(", ")}` : ""}`);
  }
  const md = briefToMarkdown(brief, packet);
  if (outFile) {
    writeFileSync(outFile, outFile.endsWith(".md") ? md : JSON.stringify(brief, null, 2) + "\n");
    out(`brief for ${label} (${brief.generatedBy}) written to ${outFile}; digest ${brief.digest}`);
  } else {
    out(md);
  }
}

async function cmdFees(c: Ctx, sub: string | undefined): Promise<void> {
  if (sub !== "withdraw") throw new ArgError("usage: fees withdraw --admin <alias> --asset USDC");
  const idx = index(c.network);
  const admin = kp(c, c.f.req("admin"));
  const code = parseAssetFlag(c.f.req("asset")).code;
  c.f.done();
  const r = await backend(c.network, idx).withdrawFees(tokenOf(idx, code).id, admin);
  out(`withdrew ${displayAmount(r.value)} ${code} of accrued fees to fee_to`);
  printTx(r.tx);
}

// -- express -------------------------------------------------------------------

async function cmdExpress(c: Ctx, sub: string | undefined): Promise<void> {
  const idx = index(c.network);
  if (sub === "pay") {
    const buyer = kp(c, c.f.req("buyer"));
    const merchant = address(c, c.f.req("merchant"));
    const ref = c.f.req("ref");
    const code = parseAssetFlag(c.f.req("asset")).code;
    const amount = parseAmount(c.f.req("amount"));
    const releaseIn = c.f.duration("release-in") ?? c.f.duration("window");
    const refundTo = c.f.str("refund-to");
    c.f.done();
    if (refundTo !== undefined) {
      throw new ArgError("express mode refuses --refund-to: a claimable-balance claimant does not sign, so it could not be proven. Use escrow mode.");
    }
    if (releaseIn === undefined) throw new ArgError("--release-in <duration> is required");
    const memoHash = sha256Hex(canonicalJson({ ref: ref.trim(), items: [] }));
    if (c.network === "local-sim") {
      const b = SimBackend.load(dir);
      const now = await b.now();
      checkWindow(now + releaseIn, now, cfg.minWindow, cfg.maxWindow);
      const token = tokenOf(idx, code).id;
      if (b.balance(token, buyer.publicKey()) < amount) throw new Error("the buyer's asset balance is below the amount");
      b.fund(token, buyer.publicKey(), -amount);
      const id = "00000000" + sha256Hex(`${buyer.publicKey()}|${ref}|${now}`);
      idx.express[id] = { ref, buyer: buyer.publicKey(), merchant, asset: code, amount: formatAmount(amount), releaseAt: now + releaseIn, createdAt: now };
      saveIndex(dir, idx);
      out(`claimable balance ${id} (local-sim)`);
      out(`  buyer may reclaim before ${isoUtc(now + releaseIn)}; merchant may claim from then on`);
      return;
    }
    const b = backend(c.network, idx) as RpcBackend;
    const t = idx.tokens[code];
    if (!t?.issuer) throw new Error(`asset ${code} has no issuer in the index`);
    const asset = new Asset(code, t.issuer);
    const now = Math.floor(Date.now() / 1000);
    const pre = await expressPreflight(b.client, buyer.publicKey(), merchant, asset);
    const problems = checkPreflight({ ...pre, amount });
    if (problems.length) throw new Error(`pre-flight failed:\n  - ${problems.join("\n  - ")}`);
    const acct = await b.client.server.getAccount(buyer.publicKey());
    const tx = buildExpressPay({
      source: new Account(acct.accountId(), acct.sequenceNumber()),
      merchant,
      asset,
      amount,
      releaseAt: now + releaseIn,
      memoHash,
      networkPassphrase: cfg.networkPassphrase,
      now,
      minWindow: cfg.minWindow,
      maxWindow: cfg.maxWindow,
    });
    tx.sign(buyer);
    const res = await b.client.submit(tx);
    const id = balanceIdFromResult(res.resultXdr!);
    idx.express[id] = { ref, buyer: buyer.publicKey(), merchant, asset: code, amount: formatAmount(amount), releaseAt: now + releaseIn, createdAt: now, tx: res.hash };
    saveIndex(dir, idx);
    out(`claimable balance ${id}`);
    printTx({ hash: res.hash, ledger: res.ledger, at: res.createdAt });
    return;
  }
  if (sub === "reclaim" || sub === "claim") {
    const id = c.f.req("id");
    const who = kp(c, c.f.req(sub === "reclaim" ? "buyer" : "merchant"));
    c.f.done();
    if (c.network === "local-sim") {
      const rec = idx.express[id];
      const now = await SimBackend.load(dir).now();
      if (!rec || rec.claimedBy) throw new Error("CLAIM_CLAIMABLE_BALANCE_DOES_NOT_EXIST");
      const isBuyer = who.publicKey() === rec.buyer && now < rec.releaseAt;
      const isMerchant = who.publicKey() === rec.merchant && now >= rec.releaseAt;
      if (!isBuyer && !isMerchant) throw new Error(CANNOT_CLAIM);
      const b = SimBackend.load(dir);
      b.fund(tokenOf(idx, rec.asset).id, who.publicKey(), parseAmount(rec.amount));
      rec.claimedBy = isBuyer ? "buyer" : "merchant";
      rec.claimedAt = now;
      saveIndex(dir, idx);
      out(`${rec.claimedBy} claimed ${rec.amount} ${rec.asset} (${rec.ref})`);
      return;
    }
    const b = backend(c.network, idx) as RpcBackend;
    const acct = await b.client.server.getAccount(who.publicKey());
    const source = new Account(acct.accountId(), acct.sequenceNumber());
    const tx = sub === "reclaim" ? buildReclaim(id, source, cfg.networkPassphrase) : buildClaim(id, source, cfg.networkPassphrase);
    tx.sign(who);
    const res = await b.client.submit(tx);
    out(`${sub} submitted`);
    printTx({ hash: res.hash, ledger: res.ledger, at: res.createdAt });
    return;
  }
  if (sub === "account") {
    const who = address(c, c.f.req("who"));
    c.f.done();
    if (c.network !== "testnet") throw new ArgError("express account reads a testnet account");
    const b = backend(c.network, idx) as RpcBackend;
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(who).xdrAccountId() }));
    const a = (await b.client.ledgerEntry(key)) as unknown as { account?: { balance: bigint; numSubEntries: number } } | undefined;
    out(JSON.stringify({ account: who, xlm: formatAmount(BigInt(a?.account?.balance ?? 0n)), subentries: Number(a?.account?.numSubEntries ?? 0) }));
    return;
  }
  if (sub === "status") {
    const id = c.f.req("id");
    c.f.done();
    if (c.network === "local-sim") {
      const rec = idx.express[id];
      if (!rec) throw new Error("unknown balance id");
      const now = await SimBackend.load(dir).now();
      out(JSON.stringify({ balanceId: id, ...rec, exists: !rec.claimedBy, claimableBy: rec.claimedBy ? null : now < rec.releaseAt ? "buyer" : "merchant" }, null, 2));
      return;
    }
    const b = backend(c.network, idx) as RpcBackend;
    const key = xdr.LedgerKey.claimableBalance(new xdr.LedgerKeyClaimableBalance({ balanceId: xdr.ClaimableBalanceId.fromXDR(id, "hex") }));
    const data = await b.client.ledgerEntry(key);
    const entry = (data as unknown as { claimableBalance?: xdr.ClaimableBalanceEntry } | undefined)?.claimableBalance;
    out(JSON.stringify(expressStatus(id, entry, Math.floor(Date.now() / 1000)), (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return;
  }
  throw new ArgError("usage: express pay|reclaim|claim|status …");
}

async function expressPreflight(client: ChainClient, buyer: string, merchant: string, asset: Asset) {
  const acctKey = (g: string) => xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(g).xdrAccountId() }));
  const tlKey = (g: string) =>
    xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId: Keypair.fromPublicKey(g).xdrAccountId(), asset: asset.toTrustLineXDRObject() }));
  const buyerAcct = (await client.ledgerEntry(acctKey(buyer))) as unknown as { account?: { balance: bigint; numSubEntries: number } } | undefined;
  const buyerTl = (await client.ledgerEntry(tlKey(buyer))) as unknown as { trustLine?: { balance: bigint } } | undefined;
  const merchantTl = await client.ledgerEntry(tlKey(merchant));
  return {
    merchantHasTrustline: merchantTl !== undefined,
    buyerXlm: BigInt(buyerAcct?.account?.balance ?? 0n),
    buyerSubentries: Number(buyerAcct?.account?.numSubEntries ?? 0),
    buyerAssetBalance: BigInt(buyerTl?.trustLine?.balance ?? 0n),
  };
}

// -- simulate / seed / sim helpers ---------------------------------------------

async function cmdSimulate(c: Ctx): Promise<void> {
  const json = c.f.bool("json");
  c.f.done();
  const root = projectRoot();
  const seedDir = join(root, "data", "seed");
  const seed = loadSeed(seedDir);
  const r = await runSimulation(seed);
  const expected = JSON.parse(readFileSync(join(seedDir, "expected.json"), "utf8"));
  const same = canonicalJson(r.expected) === canonicalJson(expected);
  if (json) {
    out(JSON.stringify({ match: same, expected: r.expected, keeper: r.keeper, outcomes: r.outcomes }, null, 2));
  } else {
    out(`Simulated seed: ${seed.orders.length} orders (${r.expected.escrow_orders} escrow, ${r.expected.express_orders} express), ${seed.events.length} planned events, ${r.schedule.length} contract calls`);
    out("");
    out(" #  tag      merchant token  amount        state      refunded      released(net)  fee          late");
    for (const o of r.outcomes) {
      out(
        `${String(o.n).padStart(2)}  ${(o.tag ?? "").padEnd(8)} ${o.merchant.padEnd(8)} ${o.token.padEnd(6)} ${displayAmount(BigInt(o.amount)).padStart(12)}  ${o.state.padEnd(10)} ` +
          `${displayAmount(BigInt(o.refunded)).padStart(12)}  ${displayAmount(BigInt(o.released)).padStart(13)}  ${displayAmount(BigInt(o.fee)).padStart(11)}  ${o.released_late ? "late" : ""}`,
      );
    }
    const x = r.expected;
    out("");
    out(`states: ${Object.entries(x.states).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    out(`refunded outside disputes ${x.refunded_outside_dispute}, inside disputes ${x.refunded_in_dispute}; pending refunds ${x.refund_pending} (settled ${x.refund_settled})`);
    out(`rejected calls: ${Object.entries(x.rejected).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    out(`keeper: ${r.keeper.ticks} ticks, ${r.keeper.skippedTicks} skipped during the outage, ${r.keeper.releaseCalls} release_many calls, ${r.keeper.timeouts} timeout(s); ${x.late_releases} late releases`);
    out(`settled with no action after pay: ${x.untouched_releases} of ${x.escrow_orders} escrow orders`);
    out(`express: ${x.express.claimed} claimed by the merchant after T (${x.express.claimed_amount}), ${x.express.reclaimed} reclaimed by the buyer before T (${x.express.reclaimed_amount})`);
    for (const [code, t] of Object.entries(x.totals)) {
      out(`${code.padEnd(5)} paid ${t.paid} = payouts ${Object.values(t.payout).join(" + ")} + refunds ${t.refunded} + fees ${t.fees}; contract after withdraw ${t.contract_after}`);
    }
    for (const l of r.log) out(`  ${l}`);
    out("");
    out(same ? "MATCH expected.json" : "MISMATCH expected.json");
  }
  if (!same) process.exitCode = 1;
}

async function cmdSeed(c: Ctx): Promise<void> {
  c.f.done();
  const r = await generateSeed({ root: projectRoot() });
  out(`wrote ${r.files.length} files: ${r.orders.length} orders, ${r.events.length} events, ${r.schedule.length} scheduled contract calls`);
}

async function cmdSim(c: Ctx, sub: string | undefined): Promise<void> {
  if (c.network !== "local-sim") throw new ArgError("sim helpers exist only on --network local-sim");
  const b = SimBackend.load(dir);
  if (sub === "time") {
    c.f.done();
    out(isoUtc(await b.now()));
    return;
  }
  if (sub === "advance") {
    const by = c.f.duration("by");
    c.f.done();
    if (by === undefined) throw new ArgError("--by <duration> is required");
    out(`ledger time now ${isoUtc(b.advance(by))}`);
    return;
  }
  const idx = index(c.network);
  const who = address(c, c.f.req("to"));
  const code = parseAssetFlag(c.f.req("asset")).code;
  const token = tokenOf(idx, code).id;
  if (sub === "fund") {
    const amount = parseAmount(c.f.req("amount"));
    c.f.done();
    b.fund(token, who, amount);
    out(`minted ${displayAmount(amount)} ${code} (test asset) to ${who}; balance ${displayAmount(b.balance(token, who))}`);
    return;
  }
  if (sub === "deauth" || sub === "reauth") {
    c.f.done();
    b.authorize(token, who, sub === "reauth");
    out(`${code} trustline of ${who} ${sub === "reauth" ? "restored" : "deauthorised (cannot receive)"}`);
    return;
  }
  throw new ArgError("usage: sim fund|advance|deauth|reauth|time");
}

// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const [cmd, sub] = parsed.positional;
    if (!cmd || parsed.flags.has("help") || cmd === "help") {
      out(HELP);
      return 0;
    }
    const c: Ctx = { network: parseNetwork(parsed.flags.get("network") as string | undefined), f: new Flags(parsed) };
    c.f.bool("help");
    switch (cmd) {
      case "init": await cmdInit(c); break;
      case "token": await cmdToken(c, sub); break;
      case "merchant": await cmdMerchant(c, sub); break;
      case "pay": await cmdPay(c); break;
      case "refund": await cmdRefund(c); break;
      case "settle-refund": await cmdSettle(c); break;
      case "dispute": await cmdDispute(c); break;
      case "respond": await cmdRespond(c); break;
      case "withdraw-dispute": await cmdWithdrawDispute(c); break;
      case "resolve": await cmdResolve(c); break;
      case "release": await cmdReleaseOrTimeout(c, "release"); break;
      case "timeout": await cmdReleaseOrTimeout(c, "timeout"); break;
      case "keeper": await cmdKeeper(c); break;
      case "receipt": await cmdReceipt(c); break;
      case "brief": await cmdBrief(c); break;
      case "express": await cmdExpress(c, sub); break;
      case "fees": await cmdFees(c, sub); break;
      case "simulate": await cmdSimulate(c); break;
      case "seed": await cmdSeed(c); break;
      case "sim": await cmdSim(c, sub); break;
      default:
        throw new ArgError(`unknown command "${cmd}" (see refundwin --help)`);
    }
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    const err = e as Error;
    process.stderr.write(`error: ${err instanceof ContractError ? `${err.errName} (contract error ${err.code})` : err.message}\n`);
    return err instanceof ArgError ? 2 : 1;
  }
}

if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
