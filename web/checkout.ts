// Web checkout for refund_escrow (bundled by `npm run build:web` into
// web/dist/checkout.js). Exercised manually on testnet (DEMO.md); not run in
// this environment. Transaction building is shared with the CLI through
// app/src/tx and app/src/express.ts, which are unit-tested offline.
//
// URL: checkout.html?merchant=G…&ref=ORD-1044&amount=49.99&asset=USDC[&window=3d]

import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { Account, Asset, authorizeEntry, buildAuthorizationEntryPreimage, rpc, TransactionBuilder, BASE_FEE, xdr } from "@stellar/stellar-sdk";
import { parseAmount, displayAmount } from "../app/src/amount.ts";
import { parseDuration } from "../app/src/duration.ts";
import { bytesToHex, orderIdPreimage } from "../app/src/ref.ts";
import { invokeOp, payArgs, type PayParams } from "../app/src/tx/args.ts";
import { entrySigner } from "../app/src/tx/auth.ts";
import { buildExpressPay } from "../app/src/express.ts";

interface Config {
  networkPassphrase: string;
  rpcUrl: string;
  contractId: string;
  psp: { name: string; arbiterName: string };
  minWindowSecs: number;
  maxWindowSecs: number;
  assets: Record<string, { issuer: string }>;
  merchants: Record<string, { name: string; feeBps: number; windowSecs: number; express: boolean }>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string, cls = "") => {
  $("result").hidden = false;
  const el = $("status");
  el.className = `status ${cls}`;
  el.textContent = s;
};

async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

function when(unix: number): string {
  const d = new Date(unix * 1000);
  const local = d.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${local} (${tz}); ${d.toISOString().replace(".000Z", "Z")} UTC`;
}

const short = (g: string) => `${g.slice(0, 4)}…${g.slice(-4)}`;

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const cfg = (await (await fetch("./config.json")).json()) as Config;
  const merchant = q.get("merchant") ?? "";
  const ref = q.get("ref") ?? "";
  const assetCode = (q.get("asset") ?? "USDC").toUpperCase();
  const amount = parseAmount(q.get("amount") ?? "0");
  const m = cfg.merchants[merchant];
  const asset = cfg.assets[assetCode];
  if (!m || !asset || !ref || amount <= 0n || !cfg.contractId) {
    status("This checkout link is incomplete or the merchant is unknown to this PSP.", "bad");
    return;
  }
  const window = q.get("window") ? parseDuration(q.get("window")!) : m.windowSecs;
  const now = Math.floor(Date.now() / 1000);
  const releaseAt = now + window;
  $("order-line").textContent = `${m.name} · order ${ref}`;
  $("t-merchant").textContent = `${m.name} (${short(merchant)})`;
  $("t-amount").textContent = `${displayAmount(amount)} ${assetCode}`;
  $("t-release").textContent = when(releaseAt);
  $("t-fee").textContent = `${(m.feeBps / 100).toFixed(2)}%, paid by the merchant from its share`;
  $("t-arbiter").textContent = cfg.psp.arbiterName;
  if (m.express) {
    $("mode-box").hidden = false;
    $("express-label").textContent = `Pre-order (cancel any time before ${new Date(releaseAt * 1000).toLocaleDateString()}; no disputes)`;
  }

  StellarWalletsKit.init({ modules: defaultModules() });
  let buyer = "";
  let second = "";
  await StellarWalletsKit.createButton($("wallet-box"));
  const refresh = async () => {
    try {
      buyer = (await StellarWalletsKit.getAddress()).address;
    } catch {
      buyer = "";
    }
    const target = second || buyer;
    $("refund-line").hidden = !buyer;
    $("second-box").hidden = !buyer;
    $("refund-to").textContent = target ? `${short(target)}${second ? " (your second wallet)" : " (this wallet)"}` : "";
    const pay = $<HTMLButtonElement>("pay");
    pay.disabled = !buyer;
    pay.textContent = buyer ? `Pay ${displayAmount(amount)} ${assetCode}` : "Connect a wallet first";
  };
  setInterval(refresh, 1500);
  await refresh();

  $<HTMLInputElement>("second").addEventListener("change", async (ev) => {
    const box = ev.target as HTMLInputElement;
    if (!box.checked) {
      second = "";
      await refresh();
      return;
    }
    status("Connect the second wallet. It will be asked to sign this checkout, which proves you control it.");
    try {
      second = (await StellarWalletsKit.authModal()).address;
      if (second === buyer) second = "";
    } catch {
      box.checked = false;
      second = "";
    }
    await refresh();
  });

  $("pay").addEventListener("click", async () => {
    const mode = (document.querySelector('input[name="mode"]:checked') as HTMLInputElement | null)?.value ?? "escrow";
    const server = new rpc.Server(cfg.rpcUrl);
    const memoHash = await sha256Hex(JSON.stringify({ items: [], ref: ref.trim() }));
    try {
      if (mode === "express") {
        if (second) throw new Error("Pre-orders refund only to the paying wallet; untick the second-wallet option.");
        const acct = await server.getAccount(buyer);
        const tx = buildExpressPay({
          source: new Account(acct.accountId(), acct.sequenceNumber()),
          merchant,
          asset: new Asset(assetCode, asset.issuer),
          amount,
          releaseAt,
          memoHash,
          networkPassphrase: cfg.networkPassphrase,
          now,
          minWindow: cfg.minWindowSecs,
          maxWindow: cfg.maxWindowSecs,
        });
        const { signedTxXdr } = await StellarWalletsKit.signTransaction(tx.toXDR(), { networkPassphrase: cfg.networkPassphrase, address: buyer });
        const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, cfg.networkPassphrase));
        const res = await server.pollTransaction(sent.hash);
        status(`Pre-order placed (${res.status}).\nTransaction ${sent.hash}\nYou can cancel and take the money back until ${when(releaseAt)}.`);
        return;
      }
      const p: PayParams = {
        buyer,
        merchant,
        orderId: await sha256Hex(orderIdPreimage(merchant, ref)),
        token: new Asset(assetCode, asset.issuer).contractId(cfg.networkPassphrase),
        amount,
        refundTo: second || null,
        window: q.get("window") ? window : null,
        memoHash,
      };
      const acct = await server.getAccount(buyer);
      const build = (auth: xdr.SorobanAuthorizationEntry[] = []) =>
        new TransactionBuilder(new Account(acct.accountId(), acct.sequenceNumber()), { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
          .addOperation(invokeOp(cfg.contractId, "pay", payArgs(p), auth))
          .setTimeout(180)
          .build();
      status("Simulating…");
      let tx = build();
      let sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
      if (second) {
        // The second wallet signs its own authorisation entry for `pay`.
        const entries = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.auth ?? [];
        const until = (await server.getLatestLedger()).sequence + 60;
        const signed: xdr.SorobanAuthorizationEntry[] = [];
        for (const e of entries) {
          let who = "";
          try {
            who = entrySigner(e);
          } catch {
            who = "";
          }
          if (who !== second) {
            signed.push(e);
            continue;
          }
          status("Sign the refund-address authorisation in your second wallet…");
          const preimage = buildAuthorizationEntryPreimage(e, until, cfg.networkPassphrase);
          const { signedAuthEntry } = await StellarWalletsKit.signAuthEntry(preimage.toXDR("base64"), {
            networkPassphrase: cfg.networkPassphrase,
            address: second,
          });
          const sig = Uint8Array.from(atob(signedAuthEntry), (ch) => ch.charCodeAt(0));
          signed.push(await authorizeEntry(e, async () => ({ signature: sig, publicKey: second }), until, cfg.networkPassphrase));
        }
        tx = build(signed);
        sim = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
      }
      const prepared = rpc.assembleTransaction(tx, sim).build();
      status("Sign the payment in your wallet…");
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(prepared.toXDR(), { networkPassphrase: cfg.networkPassphrase, address: buyer });
      const sent = await server.sendTransaction(TransactionBuilder.fromXDR(signedTxXdr, cfg.networkPassphrase));
      status(`Submitted ${sent.hash}; waiting for the ledger…`);
      const res = await server.pollTransaction(sent.hash);
      status(
        `Payment ${res.status}.\nOrder id ${p.orderId}\nRefunds can only go to ${second || buyer}.\n` +
          `Release to the merchant: ${when(releaseAt)}.\nReceipt: refundwin receipt --network testnet --ref "${ref}" --merchant ${merchant}`,
      );
    } catch (e) {
      status(`Payment not completed: ${(e as Error).message}`, "bad");
    }
  });
}

main().catch((e) => status(`Checkout failed to start: ${(e as Error).message}`, "bad"));
