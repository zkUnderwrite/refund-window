# Express mode

Express mode needs no contract. The checkout builds one classic `CreateClaimableBalance` operation per order, signed and paid for by the buyer, with exactly two claimants:

| Claimant | Predicate | Meaning |
|---|---|---|
| buyer (always the transaction source) | `before_absolute_time(T)` | the buyer can take the money back until `T` |
| merchant | `not(before_absolute_time(T))` | the merchant can take it from `T` on |

The memo is `MEMO_HASH = memo_hash`, the sha256 of the order reference and line items. The balance id comes from the transaction result (`getClaimableBalanceIdFromResult`, JS SDK 17.1.0). Code: `app/src/express.ts`. Tests: `app/test/express.test.ts`.

```bash
refundwin express pay     --buyer b1 --merchant M1 --ref PRE-7 --asset USDC --amount 32.40 --release-in 14d
refundwin express reclaim --id <balance id> --buyer b1       # before T only
refundwin express claim   --id <balance id> --merchant m1    # from T only
refundwin express status  --id <balance id>                  # RPC getLedgerEntries (verify-first item (c))
```

## When to use it

Use it only when the merchant accepts **unconditional cancellation before `T`**: pre-orders, made-to-order goods not yet started, event deposits. The buyer needs no reason to reclaim, and nobody can stop them.

## Limits

- **No dispute and no arbiter.** Before `T` the buyer does not need one; after `T` there is none.
- **No partial refund.** A claimable balance is claimed whole.
- **The merchant cannot refund before `T`.** It asks the buyer to reclaim.
- **After `T` a refund is a fresh transfer again**, with all the problems this project exists to avoid.
- **No on-chain PSP fee.** Express-mode fees are billed off-chain.
- **No separate refund address.** `--refund-to` is refused: a classic claimant does not sign, so the checkout could not prove the buyer controls it. Use escrow mode for that.
- **If the buyer forgets to reclaim before `T`, the merchant can claim.** This is the trade-off of the mode, and the checkout says so ("cancel any time before <date>").

## Pre-flight checks

Before building the transaction, the CLI checks the following through RPC `getLedgerEntries`:

- the merchant has a trustline for the asset; otherwise it could never claim;
- `T - now` is within `[MIN_WINDOW, MAX_WINDOW]` from `.env`;
- the buyer holds the asset amount;
- the buyer holds enough XLM for its own minimum balance plus the reserve the balance locks. The reserve is **assumed** to be one base reserve (0.5 XLM) per claimant (`requiredXlm`).

## Verify-first item (b)

Two things were not verified on a live network:

- the predicate semantics at exactly `T`, modelled as the buyer iff ledger close time `< T` and the merchant iff `>= T`;
- the XLM reserve the creator holds while the balance exists.

`scripts/e2e-testnet.sh` checks:

- (i) the buyer reclaims before `T`;
- (ii) the merchant is refused before `T` with `CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM`;
- (iii) the merchant claims after `T`;
- (iv) the buyer is refused after `T`;
- (v) the buyer's XLM and subentries before, during and after, via `express account`.

**If the reserve is a barrier for buyers**, the PSP can sponsor it by wrapping the operation in `BeginSponsoringFutureReserves` / `EndSponsoringFutureReserves` with the PSP as sponsor. That needs the PSP's signature on every checkout transaction, and it is not built here.

## Why not the contract for everything

Express mode costs one classic operation and leaves nothing for a keeper to do: the merchant claims when it wants. Claimable-balance history is not available from RPC, and Horizon is nearing end-of-life (E14). So the CLI records each balance id in its local index, and receipts for express orders are the transaction hashes.
