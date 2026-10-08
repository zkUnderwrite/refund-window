# PSP integration

This guide is for a non-custodial PSP or checkout provider. A custodial PSP can run the same rules in its own ledger and does not need this contract (Assumption A1).

## 1. Deploy one contract

```bash
stellar contract build
scripts/deploy-testnet.sh          # testnet; review first; not run in the build environment
```

- **Constructor arguments.** `admin`, `arbiter`, `fee_to`, `arbiter_timeout` (≤ 30 days; 7 days suggested), `min_window`, `max_window` (60 days suggested).
- **Immutability.** The contract has no upgrade function. A new version is a new deployment; existing orders finish on the old one.
- **Key separation.** Keep `admin`, `arbiter` and `fee_to` as separate keys.
- **TTL.** Check `stellar network settings` (the script saves it to `target/network-settings.json`). The max entry TTL must exceed `max_window + arbiter_timeout + 14 days`.

## 2. Enable tokens and onboard merchants

```bash
refundwin token enable --admin psp-admin --asset USDC:<issuer>
refundwin merchant add --admin psp-admin --merchant <merchant alias> --payout <G…> --fee-bps 150 --window 14d
```

- `add_merchant` needs the **merchant's signature** as well as the admin's, so the merchant consents to the fee and the arbiter.
- `fee_bps` is capped at 1,000 (10%). It is your fee, taken on released value only; it is never charged on refunded value.
- `set_payout`, `set_arbiter`, `set_fee_to` and `set_merchant_active` affect **new** orders only. Every order keeps the terms it was paid under.
- `set_paused` stops new payments only. Refunds, disputes, releases and timeouts keep working.

## 3. Embed the checkout

Serve `web/checkout.html` and `web/dist/checkout.js` (`npm run build:web`) with a `config.json` holding the contract id, asset issuers, merchants and your arbiter's display name. Link to it with `checkout.html?merchant=G…&ref=<merchant order ref>&amount=49.99&asset=USDC[&window=3d]`. The page:

- shows the buyer "Refunds for this order can only go to: G…XYZ (this wallet)";
- lets the buyer choose a second wallet they control, which must sign (`signAuthEntry`; if a wallet lacks it, the second wallet signs a separate envelope; see VALIDATION H5);
- shows the release time in the buyer's timezone, your fee and your arbiter;
- builds `pay` with the shared code in `app/src/tx`, simulates it, asks the wallet to sign, and submits.

**Tell buyers paying from an exchange to use a self-custody wallet or a card.** An exchange cannot sign `pay`. That is the point of the design, and also its largest limit.

**Order ids.** An order id is `sha256(merchant_strkey ":" normalise(ref))`, where normalisation trims, uppercases, and removes spaces, `#` and `-`. A buyer re-typing a reference in another format therefore hits `DuplicateOrder` instead of paying twice.

## 4. Run the keeper

```bash
refundwin keeper --network testnet --interval 10m --caller keeper
```

Each pass:

- releases every indexed order that is due, in batches of 25 (`release_many` skips anything not releasable and never fails the batch);
- triggers `timeout_refund` for disputes past `resolve_by`;
- retries `settle_refund` for refunds that could not be delivered.

The network has no native cron (01-§14). If the keeper stops, releases are delayed, not lost: anyone, including the merchant, can call `release`. The seed demonstrates this with a 26 h outage.

The keeper knows only the orders in its local index (`.refundwin.json`). If orders are paid through the web checkout, add them to the index from your order system, or index `pay` events from RPC. RPC keeps events for 7 days only, so run the indexer continuously.

## 5. Support workflows

| Situation | Who | Command |
|---|---|---|
| Refund (part or all) before release | merchant | `refundwin refund --merchant <alias> --ref … --amount 15.00` (asks for confirmation; refunds are final) |
| Refund could not be delivered (buyer lost the trustline) | anyone / keeper | `refundwin settle-refund --ref …` once the buyer can receive again |
| Buyer disputes | buyer | `refundwin dispute --buyer <alias> --ref … --reason NOT_RECEIVED --statement s.txt --evidence a.pdf,b.jpg` |
| Merchant answers | merchant | `refundwin respond …` |
| Arbiter prepares and rules | PSP arbiter | `refundwin brief …`, then `refundwin resolve …` (docs/ARBITER-GUIDE.md) |
| Proof for a regulator or a party | anyone | `refundwin receipt --ref … --out r.json`, later `--verify r.json` |
| Collect fees | PSP admin | `refundwin fees withdraw --admin psp-admin --asset USDC` |

## 6. Fees and cost

- **Your fee** is `fee_bps` on the merchant's released share, floored per order (a 0.0000050 USDC order pays 0).
- **Network cost.** Each order costs a `pay` and a share of a `release_many` transaction. The per-order cost is a hypothesis (target under $0.01) until measured on testnet.
- **Express mode.** Pre-order fees cannot be taken on-chain; bill them off-chain.

## 7. Merchant cash-out (documented, not built)

Merchants in LatAm, Africa and SEA can cash out through anchors or SCF Integration-List ramps, for example alfredpay or Koywe in LatAm (01-§5, §11). Point merchants to one and record the choice in onboarding.
