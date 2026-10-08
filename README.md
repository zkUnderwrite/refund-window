# Refund Window

Refund windows and dispute escrow for merchants who accept stablecoins through a non-custodial PSP. Each payment is bound at checkout to the buyer's refund address and held until a deadline. Before the deadline the merchant can refund any part of it and the buyer can open one dispute. After the deadline the merchant is paid automatically.

Everything in `data/seed/` is simulated. No merchant, PSP or buyer has used this software. Nothing was deployed from the build environment.

## Problem

Stablecoin payments have no chargeback. Refunds must be started by the merchant, and each merchant builds its own refund workflow. The most common pattern is a fresh transfer from the merchant's wallet. When the buyer paid from an exchange withdrawal address, that transfer "often fails or gets credited to a different account" (research `11-R3`; eco.com, Venable). Regulation has not filled the gap: MiCA's transition closed in January 2026 with consumer recourse unresolved, and GENIUS is "thin on the chargeback equivalent" (`11-R3`). The closest shipped non-custodial standard, Circle's Refund Protocol, is EVM-only, unaudited, and discloses a bug that "allows an arbiter to drain other users' payments" (`11-R3`, E4).

**Caveat.** Demand is unquantified: merchant stablecoin checkout volume was not measured in any dossier. A custodial PSP (Bridge, BVNK) can run a refund window in its own ledger without a chain. This project matters only for PSPs that must, or choose to, stay non-custodial (Assumption A1). The escrow mechanics are ported from projects 05 (DepositGuard) and 10 (Agent Escrow). The novel parts are the **refund address that signed at checkout** and the **no-contract express mode** built on a claimable balance.

## User

Support and finance staff at a small or mid-size merchant, for example in Latin America, Africa or South-East Asia selling abroad, who handle refund requests from buyers who paid in stablecoins through a non-custodial PSP. The secondary user is the PSP's product lead, who has to answer merchants and regulators about recourse.

## What the MVP does

- **Contract `refund_escrow`** (Soroban, one instance per PSP). The buyer signs `pay`, and the order snapshots the merchant's payout, PSP fee, arbiter, arbiter timeout, release time `T` and `refund_to`. `refund_to` is the paying address, or a second address that also signed `pay`. An exchange hot wallet can never be the refund address.
  - `refund(order, amount)` has **no recipient argument**; money can only go to `refund_to`. If the transfer fails (for example the buyer lost authorisation on the trustline), the refund is recorded as owed and `settle_refund` pays it later.
  - `dispute` (buyer, before `T`, once) freezes release. `resolve(order, refund_amount)` splits the held amount between `refund_to` and `payout`. Only the order's snapshot arbiter can sign it, and only before `resolve_by`. After `resolve_by` anyone can trigger a full refund.
  - `release` / `release_many` (anyone, from `T`) pay the merchant, less the PSP fee. The admin can withdraw accrued fees and nothing else. There is no upgrade function, no sweep, and no way to change `refund_to`.
- **Express mode** (`app/src/express.ts`, no contract): one classic claimable balance per order. The buyer may claim `before_absolute_time(T)` and the merchant `not(before_absolute_time(T))`. It suits pre-orders where the merchant accepts unconditional cancellation.
- **CLI `refundwin`** (`app/`): init, tokens, merchants, pay, refund, settle-refund, dispute, respond, brief, resolve, withdraw-dispute, release/timeout `--due`, keeper, receipt (build and `--verify`), express, fees, `simulate` and `seed`. It runs against `--network local-sim` (the TypeScript model of the contract, no network) or `--network testnet` (Stellar RPC; written, not run here).
- **Receipts:** canonical JSON with a sha256 digest, built from on-chain order state and captured transaction hashes, and re-verifiable against the chain. A local cache keeps hashes beyond RPC's 7-day retention.
- **Dispute brief for the arbiter:** a deterministic heuristic provider, plus an optional LLM provider (off by default; needs `LLM_API_KEY` **and** `LLM_DISPUTES_ALLOWED=true`). The brief never contains an outcome, and the schema rejects outcome fields. Statements are redacted before any model sees them, and a numbers guard rejects invented amounts and dates.
- **Web checkout** (`web/`): Stellar Wallets Kit 2.7.0. It shows "Refunds for this order can only go to: G…XYZ (this wallet)", offers an optional second wallet that must sign, and shows the terms that will be fixed on-chain. It also offers the express pre-order option.
- **Seed** (`data/seed/`, generated deterministically): 2 merchants and 50 orders (44 escrow, 6 express), with messy amounts and references, a duplicate reference, a separate `refund_to`, a removed trustline, 3 disputes (one each: resolved, refunded in dispute, timed out), a late dispute, and a 26 h keeper outage.

## Quickstart

```bash
# Contract: 50 tests in the Soroban host (47 unit/negative, 1 property test of
# 300 random sequences, 2 scenario tests replaying the 44-order seed)
cargo test
stellar contract build            # target/wasm32v1-none/release/refund_escrow.wasm (27,763 bytes)

# App: 72 offline tests (no RPC, no LLM key)
cd app && npm ci && npm test && npm run build
node dist/src/cli.js simulate     # full seed offline; prints the outcome table, exits 1 on any mismatch

# A dispute brief for a seed dispute (heuristic; add --provider llm to replay the recorded fixture)
node dist/src/cli.js brief --seed D1

# The whole journey on the local model (no network): see DEMO.md
```

Testnet: `scripts/deploy-testnet.sh` and `scripts/e2e-testnet.sh` (the full journey, including the express predicate tests and the four verify-first items). Both were written for stellar-cli 28 and **not executed** here, because the environment had no testnet access.

## Layout

```
Cargo.toml                         workspace (release profile per CONTRIBUTING)
contracts/refund_escrow/src/       lib.rs, types.rs, test.rs, test_prop.rs, test_scenario.rs, test_seed.rs (generated)
contracts/refund_escrow/test_snapshots/
app/src/                           cli.ts, args.ts, backend*.ts, express.ts, keeper.ts, receipt.ts, evidence.ts,
                                   tx/ (args, auth, decode, rpc), ai/ (heuristic, llm, schema, merge, guard, redact),
                                   sim/ (model.ts, simulate.ts), seed/generate.ts
app/test/                          14 test files, fixtures/
web/                               checkout.html, checkout.ts, config.json (bundle: npm run build:web)
scripts/                           deploy-testnet.sh, e2e-testnet.sh (not run here)
data/seed/                         psp, merchants, orders, events, expected, vectors, disputes/D1..D3
docs/                              EXPRESS-MODE, ARBITER-GUIDE, PSP-INTEGRATION, CIRCLE-COMPARISON, DATA-PROTECTION
```

## Status

**Functional locally; testnet-ready scripts (not run).** The contract is executed and tested in the Soroban host (`cargo test`, 50/50), and the wasm builds (27,763 bytes). The app's 72 offline tests pass, and `simulate` reproduces `expected.json`. The Rust scenario test replays the same 148-call schedule on the real contract and reaches the same states and balances. The testnet scripts and the web checkout are written and type-checked but were not run. The LLM provider is implemented and exercised only through recorded fixtures. No user, merchant or PSP has used it. Nothing is deployed, validated, measured or adopted.
