# Refund Window: architecture

## Verify-first items (each must pass on testnet before any pilot)

These are protocol behaviours the build could not observe on a live network. `scripts/e2e-testnet.sh` checks each one. Neither script has been run.

| Item | Question | What this build shows | Fallback if testnet disagrees |
|---|---|---|---|
| (a) | Does `TokenClient::try_transfer` catch the SAC's failure when `refund_to` is a G-account with no trustline, or a deauthorised one, so `refund` can record `refund_pending` instead of reverting? CAP-73 (P26) changed how the SAC creates G-account balances (01-§1). | In the Soroban host, yes. `refund_to_deauthorised_balance_goes_pending_and_settles_later` deauthorises the buyer through the SAC issuer, gets `refund_pending`, fails `settle_refund` with `TransferFailed` until re-authorisation, then settles. The seed scenario does the same for order A2. A removed trustline (as opposed to a deauthorised one) was not reproduced in the host. | `refund` never transfers and only records `refund_owed`; the keeper calls `settle_refund` in the next transaction. |
| (b) | Claimable-balance predicates at exactly `T` (close time `< T` vs `>= T`), and the XLM reserve the creator holds per claimant. | Modelled from the documented rule: buyer iff `close < T`, merchant iff `close >= T` (`canClaim`, `sim/express-model.ts`). The reserve is an assumption: one base reserve (0.5 XLM) per claimant, plus the fee (`requiredXlm`). | If the reserve is a barrier for buyers, the PSP sponsors it (`BeginSponsoringFutureReserves`, docs/EXPRESS-MODE.md). |
| (c) | Can RPC `getLedgerEntries` read a claimable-balance entry for `express status`? | `refundwin express status` builds the `LedgerKey.claimableBalance` key and decodes the entry (decoder unit-tested on an entry built from the operation's own XDR). | Horizon, with its deprecation noted (01-§3, E14). |
| (d) | Does `release_many` with 25 orders stay within per-transaction resource limits? | `MAX_BATCH = 25`; `release_many` with 26 ids fails `BatchTooLarge`. Host tests run with an unlimited budget, so they say nothing about live limits. `deploy-testnet.sh` saves `stellar network settings` to `target/network-settings.json`; `E2E_BATCH=1 scripts/e2e-testnet.sh` releases 25 at once. | Lower `MAX_BATCH` (constant in `types.rs` and `app/src/keeper.ts`). |

## Components and data flow

```
buyer wallet ──(Wallets Kit)── web/checkout ──pay(buyer, merchant, order_id, token, amount, refund_to?, window?, memo)──► refund_escrow
   │                                  │  refund_to = signer(s) of pay                           │ Order{…snapshot: payout, fee_bps,
   │                                  └─ express: CreateClaimableBalance                       │        arbiter, timeout; release_at}
   │                                      buyer: before(T) | merchant: not(before(T))          │
merchant support ── refundwin refund/respond ─────────────────────────────────────────────────►│ refund → refund_to only
buyer ── refundwin dispute (reason, evidence hash) / withdraw-dispute ─────────────────────────►│ freeze until resolve_by
PSP arbiter ◄── refundwin brief (heuristic | LLM, redacted, guarded) ◄── evidence manifests (off-chain)
PSP arbiter ── resolve(order, refund_amount, ruling_hash) ───────────────────────────────────►│ split between bound parties only
keeper (PSP) ── release_many / timeout_refund / settle_refund ────────────────────────────────►│ payout (net of fee) | refund_to
admin (PSP) ── set_token / add_merchant / withdraw_fees(fees only) ─────────────────────────►│
receipt ◄── order() + captured tx hashes ──► canonical JSON + sha256 (both sides)
```

| Component | Where | Notes |
|---|---|---|
| Contract | `contracts/refund_escrow/src/lib.rs`, `types.rs` | soroban-sdk 28.0.0, `wasm32v1-none`, 27,763 bytes |
| Contract model | `app/src/sim/model.ts` | Follows `lib.rs` rule for rule, including error codes and check order. Used by `simulate`, `--network local-sim` and the seed generator |
| Seed generator | `app/src/seed/generate.ts` | Fixed PRNG seed. Writes `data/seed/*` and `contracts/refund_escrow/src/test_seed.rs` (orders, the full 148-call schedule and the model's final state). The Rust scenario test replays that schedule on the real contract, so any divergence between model and contract fails `cargo test` |
| Transaction building | `app/src/tx/` | `args.ts` (ScVal args per function), `auth.ts` (the two-signer `pay` auth tree), `decode.ts`, `rpc.ts` (simulate, co-sign, assemble, send, poll). Shared with `web/checkout.ts` |
| Express mode | `app/src/express.ts` | Builders, predicate decoding, balance-id extraction, pre-flight |
| Keeper | `app/src/keeper.ts` | Pure selection (`dueReleases`, `dueTimeouts`, `pendingRefunds`, batches of 25) plus one executor per network |
| Receipts | `app/src/receipt.ts`, `canonical.ts` | Canonical JSON, sha256 digest, `verifyReceipt`, and the local cache `~/.refundwin/receipts/<order_id>.json` |
| Dispute brief | `app/src/ai/` | See "AI" below |
| Web checkout | `web/checkout.ts` | Stellar Wallets Kit 2.7.0; `signAuthEntry` for the second wallet |

### Contract interface

`__constructor(admin, arbiter, fee_to, arbiter_timeout, min_window, max_window)`, `set_token`, `add_merchant` (admin **and** merchant auth), `set_merchant_active`, `set_payout` (merchant and admin; future orders only), `set_arbiter`, `set_fee_to`, `set_paused`, `pay`, `refund`, `settle_refund`, `dispute`, `respond`, `withdraw_dispute`, `resolve`, `timeout_refund`, `release`, `release_many`, `withdraw_fees`. Views: `order`, `merchant`, `config`, `fees`, `token_enabled`. The full specification is in `research/round2-specs/14-refund-window.md` §2–§8. Differences from it:

- **Error `TransferFailed = 23`** (not in the specification's list). `settle_refund` and `pay` report a failed token transfer with this code, because the SAC's own error codes overlap the contract's.
- **`refund` emits `refund` only when something was delivered**; otherwise it emits `refund_pending`. The model and the receipt builder follow the same rule.

State machine and boundary rules: dispute iff `now < release_at`; release iff `now >= release_at`; resolve iff `now < resolve_by`; timeout iff `now >= resolve_by`. All four are tested at `T-1` and `T`.

Invariants, asserted after every step of the property test (300 sequences × up to 60 steps, 3 merchants, 6 buyers, 2 tokens, plus trustline toggles):

- per order, `amount == held + refunded + released + fee` and `0 <= refund_owed <= refunded`;
- per token, `balance(contract) == Σ held + Σ refund_owed + Fees(token)`;
- only `refund_to`, `payout` and `fee_to` ever gain from contract outflows;
- terminal orders change only through `refund_owed → 0`;
- `fee <= (amount - refunded) * fee_bps / BPS`.

### TTL

Every write to an order extends its TTL to cover `release_at + arbiter_timeout - now` plus 14 days, at 5 s per ledger, capped at the network's max entry TTL (`order_ttl_covers_window_plus_arbiter_timeout_plus_margin`). With the defaults, `max_window` (60 d) + `arbiter_timeout` (≤ 30 d) + 14 d stays below the ≈180-day figure in 01-§1. `deploy-testnet.sh` records the live value.

### Why a silent arbiter defaults to a refund (and 05 defaults to 50/50)

In DepositGuard both parties made a claim on an amount they both had a right to argue over. Here the buyer's money is held against a promise the merchant has not yet shown it kept. If the PSP that earns fees from the merchant does not rule, the risk of its silence falls on the merchant side. This favours buyers if the PSP is slow (risk 4); the PSP controls that by staffing, and `arbiter_timeout` bounds it.

## AI (off-chain; never decides)

`DisputeBriefProvider` has two implementations.

- `HeuristicProvider` (`ai/heuristic.ts`) is deterministic. It builds a checklist per reason code and computes `provided` from evidence kinds and extracted fields. The timeline comes from receipt events plus evidence times. Inconsistencies are rule-based: "delivered" dated before payment, a dispute opened more than 30 days after delivery, merchant evidence submitted after `resolve_by`, "in transit" with no delivery, and an access log with no login. The summary is a fixed template.
- `LlmProvider` (`ai/llm.ts`) calls the Anthropic Messages API (`LLM_MODEL`, default `claude-sonnet-5`). It is enabled only when `LLM_API_KEY` is set **and** `LLM_DISPUTES_ALLOWED=true`. Statements pass through `redact.ts` first. The model returns strict JSON, validated by `schema.ts` with one retry; after that the heuristic brief is used.
  - `merge.ts` takes the union of checklists (the model can add items, never remove or downgrade one), takes chain timeline entries only from the heuristic, and unions claims, questions and inconsistencies.
  - `guard.ts` rejects the model's summary if any amount or date in it is not in the receipt or the evidence.
  - The schema rejects any key naming an outcome (`recommend*`, `split`, `winner`, `refund_amount`, `outcome`, `verdict`, …) at any depth.

When the model is wrong:

- A misleading summary is contained because the arbiter always sees the raw (redacted) statements and the evidence manifest beside the brief (`briefToMarkdown`), and the numbers guard blocks invented figures.
- A missed checklist item cannot happen, because the heuristic floor is kept.
- Statements in Spanish or Portuguese are handled because the heuristic works on structured fields only, and the model is asked to answer in `ARBITER_LANG`.

## Trust assumptions

- **PSP admin.** It onboards merchants (with their consent: `add_merchant` needs the merchant's signature), enables tokens, sets fees for future merchants (capped at 10%), pauses new payments, and withdraws accrued fees. It cannot move held or owed funds, change an order's terms, or upgrade the contract. `pause` blocks only `pay` and `add_merchant`.
- **Arbiter.** It can split only a disputed order, only between that order's `refund_to` and `payout`, and only before `resolve_by`. The order's snapshot arbiter signs, not the current config. A compromised arbiter key can misallocate disputed orders between their two parties but cannot take funds (`a_compromised_arbiter_sweeping_every_order_takes_nothing`).
- **Keeper.** A convenience. Anyone can call `release`, `release_many`, `timeout_refund` or `settle_refund`.
- **Token issuers.** Issuer controls (freeze, clawback where enabled) apply to funds held by the contract. The flags on mainnet USDC, EURC and PYUSD were not researched.
- **Merchant.** It must trust that buyers will not dispute in bad faith; there are no dispute fees.

## Limits

- **Self-custody payers only.** Exchange accounts cannot sign `pay`. The checkout tells those buyers to use a self-custody wallet or a card. This is the largest design limit: the population whose refunds fail today (E2) is the one escrow mode cannot serve directly.
- **RPC retention is 7 days.** Receipts rely on the local cache for older transaction hashes. `--verify` marks them "not re-checkable via RPC; use an archive provider".
- **Express mode:** no dispute, no partial refund, no merchant refund before `T`, and no on-chain fee (see docs/EXPRESS-MODE.md).
- **Contract-account (passkey) buyers** should work through `require_auth` but are not tested.
- **The `local-sim` network enforces auth roles in `backend.ts`**, not through signatures; it is for demos and tests, not a security boundary.
