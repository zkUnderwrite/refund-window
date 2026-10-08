// Stellar RPC client for the `testnet` network of the CLI. Not exercised by
// `npm test` (tests are offline); scripts/e2e-testnet.sh drives it. Written
// against @stellar/stellar-sdk 17.1.0: simulate, sign auth entries of
// co-signers, re-simulate, assemble, sign, send, poll.

import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { ContractError } from "../errors.ts";
import { invokeOp } from "./args.ts";
import { entrySigner, signEntry } from "./auth.ts";
import { contractErrorCode } from "./decode.ts";

export interface TxOutcome {
  hash: string;
  ledger: number;
  createdAt: number;
  returnValue?: xdr.ScVal;
  resultXdr?: xdr.TransactionResult;
}

export interface ChainOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId?: string;
  /** Ledgers an auth signature stays valid (default 100, ~8 minutes). */
  authValidityLedgers?: number;
}

export class ChainClient {
  readonly server: rpc.Server;
  readonly opts: ChainOptions;
  constructor(opts: ChainOptions) {
    this.opts = opts;
    this.server = new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith("http://") });
  }

  get contractId(): string {
    if (!this.opts.contractId) throw new Error("no contract id: run `refundwin init` or set REFUNDWIN_CONTRACT");
    return this.opts.contractId;
  }

  private throwSim(sim: rpc.Api.SimulateTransactionErrorResponse): never {
    const code = contractErrorCode(sim.error);
    if (code !== undefined) throw new ContractError(code);
    throw new Error(`simulation failed: ${sim.error}`);
  }

  /** Read-only call through simulation (no signature, no fee). */
  async read(fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const source = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: this.opts.networkPassphrase })
      .addOperation(invokeOp(this.contractId, fn, args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) this.throwSim(sim);
    const ok = sim as rpc.Api.SimulateTransactionSuccessResponse;
    if (!ok.result) throw new Error(`${fn}: simulation returned no result`);
    return ok.result.retval;
  }

  async readNative<T>(fn: string, args: xdr.ScVal[]): Promise<T> {
    return scValToNative(await this.read(fn, args)) as T;
  }

  /**
   * Invokes a contract function. `source` pays and signs the envelope; each
   * co-signer signs its own address-credential auth entry (e.g. a separate
   * refund_to in `pay`).
   */
  async invoke(fn: string, args: xdr.ScVal[], source: Keypair, cosigners: Keypair[] = []): Promise<TxOutcome> {
    return this.invokeOperation(invokeOp(this.contractId, fn, args), source, cosigners, (auth) =>
      invokeOp(this.contractId, fn, args, auth),
    );
  }

  async invokeOperation(
    op: xdr.Operation,
    source: Keypair,
    cosigners: Keypair[] = [],
    withAuth?: (auth: xdr.SorobanAuthorizationEntry[]) => xdr.Operation,
  ): Promise<TxOutcome> {
    const account = await this.server.getAccount(source.publicKey());
    const build = (o: xdr.Operation) =>
      new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.opts.networkPassphrase })
        .addOperation(o)
        .setTimeout(120)
        .build();
    let tx = build(op);
    let sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) this.throwSim(sim);
    const auth = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.auth ?? [];
    const needsCosign = auth.some((e) => {
      try {
        return entrySigner(e) !== source.publicKey();
      } catch {
        return false;
      }
    });
    if (needsCosign && withAuth) {
      const latest = await this.server.getLatestLedger();
      const until = latest.sequence + (this.opts.authValidityLedgers ?? 100);
      const signed: xdr.SorobanAuthorizationEntry[] = [];
      for (const e of auth) {
        let who: string | undefined;
        try {
          who = entrySigner(e);
        } catch {
          who = undefined; // source-account credentials: covered by the envelope signature
        }
        const kp = who === source.publicKey() ? source : cosigners.find((k) => k.publicKey() === who);
        if (who && !kp) throw new Error(`auth entry for ${who} needs a signature, but no key was given for it`);
        signed.push(who && kp ? await signEntry(e, kp, until, this.opts.networkPassphrase) : e);
      }
      tx = build(withAuth(signed));
      sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) this.throwSim(sim);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(source);
    return this.submit(prepared);
  }

  /** Sends a signed transaction (Soroban or classic) and waits for the result. */
  async submit(tx: Transaction): Promise<TxOutcome> {
    const sent = await this.server.sendTransaction(tx);
    if (sent.status === "ERROR") {
      throw new Error(`send failed: ${sent.errorResult?.toXDR("base64") ?? "unknown error"}`);
    }
    const res = await this.server.pollTransaction(sent.hash, { attempts: 30 });
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      const detail = res.status === rpc.Api.GetTransactionStatus.FAILED ? res.resultXdr.toXDR("base64") : res.status;
      const code = contractErrorCode(String(detail));
      if (code !== undefined) throw new ContractError(code);
      throw new Error(`transaction ${sent.hash} ${res.status}: ${detail}`);
    }
    const ok = res as rpc.Api.GetSuccessfulTransactionResponse;
    return { hash: sent.hash, ledger: ok.ledger, createdAt: ok.createdAt, returnValue: ok.returnValue, resultXdr: ok.resultXdr };
  }

  /** Uploads the wasm and creates the contract with its constructor args. */
  async deploy(wasm: Buffer, constructorArgs: xdr.ScVal[], source: Keypair): Promise<{ contractId: string; wasmHash: string }> {
    const up = await this.invokeOperation(Operation.uploadContractWasm({ wasm }), source);
    const wasmHash = Buffer.from(scValToNative(up.returnValue!) as Uint8Array);
    const created = await this.invokeOperation(
      Operation.createCustomContract({ address: Address.fromString(source.publicKey()), wasmHash, constructorArgs }),
      source,
    );
    return { contractId: Address.fromScVal(created.returnValue!).toString(), wasmHash: wasmHash.toString("hex") };
  }

  /** Raw ledger entry (claimable balance, trustline) or undefined. */
  async ledgerEntry(key: xdr.LedgerKey): Promise<xdr.LedgerEntryData | undefined> {
    const res = await this.server.getLedgerEntries(key);
    return res.entries[0]?.val;
  }

  /** Contract events of this order in RPC's retention window (≤ 7 days). */
  async orderEvents(orderIdHex: string, startLedger: number): Promise<rpc.Api.EventResponse[]> {
    const topic = xdr.ScVal.scvBytes(Buffer.from(orderIdHex, "hex")).toXDR("base64");
    const res = await this.server.getEvents({
      startLedger,
      filters: [{ type: "contract", contractIds: [this.contractId], topics: [["*", topic]] }],
    });
    return res.events;
  }
}
