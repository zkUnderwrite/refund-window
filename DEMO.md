# Refund Window: demo

Everything here runs offline, from the project root, with no network and no keys. The testnet journey (`scripts/e2e-testnet.sh`) is written but was **not run** in the build environment. All data is simulated.

## 1. Contract tests in the Soroban host

```bash
cargo test
```

Expected: `test result: ok. 50 passed; 0 failed` (47 unit and negative tests, the property test, the scenario test and the order-id vector test). The scenario and property tests print their counts with `--nocapture`:

```bash
cargo test -- --nocapture scenario_two_merchants_fifty_orders invariants_hold
```

```
scenario: 148 calls replayed {"deauth": 1, "dispute": 4, "pay": 44, "pay_dup": 1, "reauth": 1, "refund": 6, "release_many": 34, "resolve": 1, "respond": 3, "settle": 49, "timeout": 1, "withdraw_fees": 3}; final states {"Refunded": 4, "Released": 38, "Resolved": 1, "TimedOut": 1}; late releases 4
property test: successes {"advance_time": 588, "dispute": 231, "pay": 1510, "refund": 674, "release": 42, "release_many": 535, "resolve": 62, "respond": 24, "set_arbiter": 146, "set_payout": 148, "settle_refund": 4, "timeout_refund": 3, "toggle_trustline": 287, "withdraw_dispute": 28, "withdraw_fees": 609}
property test: expected failures by error code {7: 309, 8: 53, 9: 64, 10: 1134, 11: 1973, 12: 31, 13: 285, 14: 6, 15: 7, 16: 31, 17: 479, 19: 52, 20: 45, 23: 28}
```

`scenario_two_merchants_fifty_orders` replays, on the real contract:

- the 44 escrow orders of `data/seed/orders.jsonl`;
- every planned action of `data/seed/events.jsonl`: the duplicate reference, 6 merchant refunds including one inside a dispute, the trustline removed and restored, 4 dispute attempts including the late one, 3 responses, 1 ruling and 3 fee withdrawals;
- every keeper call the offline simulator made: 34 `release_many`, 1 `timeout_refund`, and 49 `settle_refund` calls, 48 of which fail while the buyer's trustline is deauthorised.

It asserts each call's outcome and return value, the per-token invariant after every call, each order's final state, amounts and timestamps, 4 late releases, and the balances of every payout, `refund_to` and `fee_to`. It also asserts a zero contract balance after `withdraw_fees`.

```bash
stellar contract build     # target/wasm32v1-none/release/refund_escrow.wasm, 27,763 bytes
```

## 2. App tests and the offline simulation

```bash
cd app
npm ci
npm test                   # 72 tests, 0 failures, no RPC, no LLM key
npm run typecheck && npm run typecheck:web
npm run build
node dist/src/cli.js simulate
```

Expected output of `simulate` (exit code 0; 1 if anything differs from `data/seed/expected.json`):

```
Simulated seed: 50 orders (44 escrow, 6 express), 28 planned events, 148 contract calls

 #  tag      merchant token  amount        state      refunded      released(net)  fee          late
 1           M1       USDC         171.60  Released           0.00        169.026        2.574  
 2  A1       M1       USDC          49.99  Refunded          49.99           0.00         0.00  
 3           M1       USDC          61.90  Released           0.00        60.9715       0.9285  
 4  D1       M1       USDC          64.00  Resolved          25.60         37.824        0.576  
 5  A2       M1       USDC         120.00  Refunded         120.00           0.00         0.00  
 6  A3       M1       USDC          84.50  Released          25.35       58.26275      0.88725  
 7           M1       USDC         224.35  Released           0.00      220.98475      3.36525  
 8           M1       USDC          49.89  Released           0.00       49.14165      0.74835  
 9  D3       M1       EURC          37.80  TimedOut          37.80           0.00         0.00  
10           M2       USDC          19.99  Released           0.00      19.740125     0.249875  
11  O1       M2       USDC          38.50  Released           0.00       38.01875      0.48125  late
12  O2       M2       USDC          29.00  Released           0.00        28.6375       0.3625  late
14  L1       M2       USDC           9.99  Released           0.00       9.865125     0.124875  late
15  O3       M2       USDC          43.50  Released           0.00       42.95625      0.54375  late
16           M2       USDC          33.99  Released           0.00      33.565125     0.424875  
17           M2       USDC          25.99  Released           0.00      25.665125     0.324875  
18  DUP      M1       USDC         126.90  Released           0.00       124.9965       1.9035  
19           M2       USDC          18.00  Released           0.00         17.775        0.225  
20           M1       EURC         162.98  Released           0.00       160.5353       2.4447  
21  EURC12   M1       EURC          12.50  Released           0.00        12.3125       0.1875  
22  B1       M2       USDC          15.00  Refunded          15.00           0.00         0.00  
23           M2       USDC          14.50  Released           0.00       14.31875      0.18125  
24  DUST     M2       USDC       0.000005  Released           0.00       0.000005         0.00  
26  B2       M2       USDC          19.99  Released           5.00      14.802625     0.187375  
27           M1       USDC         107.20  Released           0.00        105.592        1.608  
28           M1       USDC          54.10  Released           0.00        53.2885       0.8115  
29           M1       USDC         122.50  Released           0.00       120.6625       1.8375  
30           M2       USDC          29.00  Released           0.00        28.6375       0.3625  
33           M1       EURC         142.69  Released           0.00      140.54965      2.14035  
34           M1       USDC          76.89  Released           0.00       75.73665      1.15335  
35  OUTLIER  M1       USDC        1999.00  Released           0.00       1969.015       29.985  
36           M1       USDC          11.25  Released           0.00       11.08125      0.16875  
38           M2       USDC          12.00  Released           0.00          11.85         0.15  
39  PY1      M2       PYUSD     7.3333333  Released           0.00      7.2416667    0.0916666  
40  D2       M2       USDC          29.00  Refunded          29.00           0.00         0.00  
41  WIN7     M1       USDC          70.20  Released           0.00         69.147        1.053  
42           M2       USDC           9.99  Released           0.00       9.865125     0.124875  
43  PY2      M2       PYUSD         22.50  Released           0.00       22.21875      0.28125  
44           M2       USDC          24.00  Released           0.00          23.70         0.30  
45           M1       USDC         118.10  Released           0.00       116.3285       1.7715  
46           M2       USDC           6.00  Released           0.00          5.925        0.075  
47           M1       USDC          32.40  Released           0.00         31.914        0.486  
48           M1       USDC         175.90  Released           0.00       173.2615       2.6385  
50           M1       USDC          28.40  Released           0.00         27.974        0.426  

states: Released 38, Refunded 4, Resolved 1, TimedOut 1
refunded outside disputes 3, inside disputes 1; pending refunds 1 (settled 1)
rejected calls: DuplicateOrder 1, WindowClosed 1
keeper: 6468 ticks, 156 skipped during the outage, 34 release_many calls, 1 timeout(s); 4 late releases
settled with no action after pay: 35 of 44 escrow orders
express: 5 claimed by the merchant after T (885.0000000), 1 reclaimed by the buyer before T (32.4000000)
USDC  paid 4127.5100050 = payouts 3475.2080500 + 325.3220050 + refunds 269.9400000 + fees 57.0399500; contract after withdraw 0.0000000
EURC  paid 355.9700000 = payouts 313.3974500 + refunds 37.8000000 + fees 4.7725500; contract after withdraw 0.0000000
PYUSD paid 29.8333333 = payouts 29.4604167 + refunds 0.0000000 + fees 0.3729166; contract after withdraw 0.0000000
  2026-09-22T01:27:00Z express_claim #13: ok
  2026-09-27T10:14:00Z express_claim #25: CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM
  2026-09-27T21:14:00Z express_claim #25: ok
  2026-10-01T22:02:00Z express_claim #31: ok
  2026-10-02T07:47:00Z express_claim #32: ok
  2026-10-02T21:57:00Z express_claim #37: ok
  2026-10-04T13:17:00Z express_reclaim #49: ok

MATCH expected.json
```

Reading the table:

- **A1** was refunded to the separate address that co-signed checkout.
- **A2** was refunded while the buyer's trustline was deauthorised. The refund stayed owed and settled on the keeper's first hourly retry after the trustline was restored.
- **A3** and **B2** are partial refunds. The fee was charged only on the released remainder.
- **D1** is the arbiter's 40% split (fee on the merchant share only), **D2** the merchant's full refund during the dispute, **D3** the arbiter timeout.
- **O1–O3** and **L1** were released late because of the 26 h keeper outage. L1's late dispute at `T+2h` was rejected with `WindowClosed`.
- **DUP**'s second `pay` failed with `DuplicateOrder`.
- The **DUST** order's fee rounds to 0.
- Missing numbers (#13, #25, …) are the six express orders.

## 3. The whole journey on the local model

`scripts/demo-local.sh` runs the CLI against `--network local-sim`, the TypeScript model of the contract. Addresses are derived from the aliases and are synthetic. The start time is fixed, so the output below is reproducible, apart from the temp directory (`$WORK`).

```bash
scripts/demo-local.sh
```

```

$ refundwin init --admin psp-admin --arbiter psp-arbiter --fee-to psp-fees --arbiter-timeout 7d --min-window 1h --max-window 60d --start 2026-10-01T09:00:00Z
contract local-sim (local-sim)
  admin GDT6UVNSANWB6AJ7KF4DEEKVM5SQ7YHH6B6D6DJIKCKVQ2QYD3VYUMWP
  arbiter GBV67YOEFFOHPZFCVVKWKFQCUOCJCOUOLV2KCSRI4AISHA4U4PCFU4UW
  fee_to GAC7QJWV5MAVGXUIG5XFXUFIWAPSRPMYNBPYZ4XBSPKGO6NAPTGZBELQ
  arbiter timeout 1w, windows 1h..60d
wrote $WORK/.refundwin.json

$ refundwin token enable --admin psp-admin --asset USDC
enabled USDC (USDC)
  tx sim-000001-set_token  ledger 1000001  2026-10-01T09:00:00Z

$ refundwin merchant add --admin psp-admin --merchant oaxaca --payout oaxaca-payout --fee-bps 150 --window 14d
merchant GARFK7H2O6RXHH6KBJHW37M2K24ZCRLDNH3A273KH5NZUHR4SBEWK6W2 payout GDEBMPESV5JCF3N3PFNVDN4TAQA7MWADFGOMWAVEHFBBV3CFO2ZUYSHV fee 150 bps window 2w
  tx sim-000002-add_merchant  ledger 1000002  2026-10-01T09:00:00Z

$ refundwin sim fund --to buyer1 --asset USDC --amount 200
minted 200.00 USDC (test asset) to GDCY73JBAI4I63KU5PZP5HGDULW2NEPX7R23N5DHZIOLXQ46PMGQDCHS; balance 200.00

$ refundwin sim fund --to buyer2 --asset USDC --amount 100
minted 100.00 USDC (test asset) to GBSJ6NW3YCFVHO6E53ZILXQZ2SB5BABP4JQX6YGJLYKRADNTNAYA6S6N; balance 100.00

$ refundwin pay --buyer buyer1 --merchant oaxaca --ref ORD-1044 --asset USDC --amount 49.99 --tz -06:00
order_id   fc283e12517f834a06f297eb6a12f3aacacf220479b035b2f834a8f9eee281de
amount     49.99 USDC
release_at 2026-10-15T09:00:00Z  (2026-10-15 03:00 (-06:00))
refunds for this order can only go to: GDCY73JBAI4I63KU5PZP5HGDULW2NEPX7R23N5DHZIOLXQ46PMGQDCHS (the paying wallet)
  tx sim-000003-pay  ledger 1000003  2026-10-01T09:00:00Z

$ refundwin pay --buyer buyer1 --merchant oaxaca --ref ord 1044 --asset USDC --amount 49.99
error: DuplicateOrder (contract error 8)

$ refundwin pay --buyer buyer2 --merchant oaxaca --ref #1045 --asset USDC --amount 64.00 --refund-to buyer2-cold
order_id   80a56446e28f1c1b15016c69ffa71a592c8179640b11086334f1ceb2526c4202
amount     64.00 USDC
release_at 2026-10-15T09:00:00Z  (2026-10-15 09:00 (+00:00))
refunds for this order can only go to: GAP5NPC2JG5BC5ROV35MJ3CK3AHCJOPMA4SO52X5U2GAFAAUP7STC3YS (second wallet, signed at checkout)
  tx sim-000004-pay  ledger 1000004  2026-10-01T09:00:00Z

$ refundwin refund --merchant oaxaca --ref ORD1044 --amount 15.00
error: Refund 15.00 USDC of ORD1044 to GDCY73JBAI4I63KU5PZP5HGDULW2NEPX7R23N5DHZIOLXQ46PMGQDCHS? Refunds are final. Refusing without --yes (stdin is not a terminal).

$ refundwin refund --merchant oaxaca --ref ORD1044 --amount 15.00 --yes
refunded 15.00 USDC to GDCY73JBAI4I63KU5PZP5HGDULW2NEPX7R23N5DHZIOLXQ46PMGQDCHS; state Held, still held 34.99
  tx sim-000005-refund  ledger 1000005  2026-10-01T09:00:00Z

$ refundwin refund --merchant buyer1 --ref ORD1044 --all --yes
error: auth failed: this call must be signed by the merchant (GARFK7H2O6RXHH6KBJHW37M2K24ZCRLDNH3A273KH5NZUHR4SBEWK6W2), not GDCY73JBAI4I63KU5PZP5HGDULW2NEPX7R23N5DHZIOLXQ46PMGQDCHS

$ refundwin sim advance --by 10d
ledger time now 2026-10-11T09:00:00Z

$ refundwin dispute --buyer buyer2 --ref #1045 --reason NOT_RECEIVED --statement $WORK/buyer.txt
dispute opened (NOT_RECEIVED); evidence manifest 69fd47e5a6815dee402448f183d0ea44434e76fca7f90cf94d811a369bd658b6
release is frozen; the arbiter can rule until 2026-10-18T09:00:00Z, after which anyone can trigger a full refund
  tx sim-000006-dispute  ledger 1172806  2026-10-11T09:00:00Z

$ refundwin respond --merchant oaxaca --ref 1045 --statement $WORK/merchant.txt --evidence $WORK/carrier-status.csv
merchant evidence recorded; manifest 2389b8021aec3d1152b21963291372e245759e9b2f6bf6fe03275049bd59b42f
  tx sim-000007-respond  ledger 1172807  2026-10-11T09:00:00Z

$ refundwin brief --ref 1045 --out $WORK/brief.md
brief for 1045 (heuristic) written to $WORK/brief.md; digest 645a899b255c331c0429006a886353628abbfc1a312e2cd21e4d2fe533a89c1e
## Summary

Order 80a56446e28f… paid 64.0000000 USDC on 2026-10-01; release was due 2026-10-15. The buyer opened a NOT_RECEIVED dispute on 2026-10-11; the arbiter can rule until 2026-10-18T09:00, after which the held 64.0000000 is refunded by default. Evidence: buyer 1 item(s), merchant 2 item(s). 1 of 4 checklist items are covered. 1 inconsistency flag(s) need attention.

## Timeline

- 2026-09-11T14:30:00Z [merchant] Carrier status "in transit" (carrier-status.csv)
- 2026-10-01T09:00:00Z [chain] Buyer paid into escrow; refund address fixed
- 2026-10-11T09:00:00Z [chain] Buyer opened the dispute
- 2026-10-11T09:00:00Z [chain] Merchant submitted evidence
- 2026-10-11T09:00:00Z [merchant] Merchant provided carrier-status.csv

## Checklist

| Item | Provided by | Evidence | Why it matters |
|---|---|---|---|
| Tracking number | merchant | carrier-status.csv | Identifies the shipment the merchant says it sent |
| Carrier status showing delivery | none |  | A not-received claim turns on whether the carrier recorded a delivery |
| Delivery address matches the order | none |  | A delivery to another address does not answer the claim |
| Delivery date before the dispute was opened | none |  | A delivery after the dispute may resolve it; one before it contradicts the claim |

## Missing

- Carrier status showing delivery
- Delivery address matches the order
- Delivery date before the dispute was opened

## Inconsistencies

- The merchant's tracking shows "in transit", not a delivery; nothing in the evidence records the item as delivered.

## Questions

Buyer:
- Is the delivery address on the order correct and complete?
- Have you checked with neighbours, building reception or the local carrier office?

$ refundwin resolve --arbiter psp-admin --ref 1045 --refund 25.60 --ruling $WORK/ruling.md --yes
error: auth failed: this call must be signed by the order's snapshot arbiter (GBV67YOEFFOHPZFCVVKWKFQCUOCJCOUOLV2KCSRI4AISHA4U4PCFU4UW), not GDT6UVNSANWB6AJ7KF4DEEKVM5SQ7YHH6B6D6DJIKCKVQ2QYD3VYUMWP

$ refundwin resolve --arbiter psp-arbiter --ref 1045 --refund 25.60 --ruling $WORK/ruling.md --yes
resolved: 25.60 to refund_to, 37.824 net to payout, fee 0.576; ruling 938b56bb34f4651dfc98ad00e4bb3346e9ec3dec90aee888838a22dd602d3178
  tx sim-000008-resolve  ledger 1172808  2026-10-11T09:00:00Z

$ refundwin release --due
0 order(s) released (0 due at 2026-10-11T09:00:00Z)

$ refundwin sim advance --by 4d
ledger time now 2026-10-15T09:00:00Z

$ refundwin keeper --once
2026-10-15T09:00:00Z keeper: released 1 in 1 batch(es), timed out 0, settled 0, pending still owed 0

$ refundwin receipt --ref ORD-1044 --out $WORK/receipt.json
receipt ORD-1044 (Released)  49.9900000 USDC
  refunded 15.0000000  released 34.4651500  fee 0.5248500  held 0.0000000
  refund_to GDCY73JBAI4I63KU5PZP5HGDULW2NEPX7R23N5DHZIOLXQ46PMGQDCHS  payout GDEBMPESV5JCF3N3PFNVDN4TAQA7MWADFGOMWAVEHFBBV3CFO2ZUYSHV
  3 event(s); digest c1c50dc47c575063afcda4810eaa0f7c8aec42dd5a1c2a3aebd781b088e24a65; wrote $WORK/receipt.json

$ refundwin receipt --ref ORD-1044 --verify $WORK/receipt.json
MATCH
  tx sim-000003-pay: found
  tx sim-000005-refund: found
  tx sim-000009-release_many: found

$ refundwin receipt --ref ORD-1044 --verify $WORK/receipt.json
MISMATCH
  digest does not match the receipt body
  refunded: receipt "0.0000000" vs chain "15.0000000"
  tx sim-000003-pay: found
  tx sim-000005-refund: found
  tx sim-000009-release_many: found

$ refundwin express pay --buyer buyer1 --merchant oaxaca --ref PRE-7 --asset USDC --amount 10 --release-in 14d --refund-to buyer2
error: express mode refuses --refund-to: a claimable-balance claimant does not sign, so it could not be proven. Use escrow mode.

$ refundwin fees withdraw --admin psp-admin --asset USDC
withdrew 1.10085 USDC of accrued fees to fee_to
  tx sim-000010-withdraw_fees  ledger 1241930  2026-10-15T09:00:00Z

work dir: $WORK
```

## 4. Dispute briefs for the seed disputes

```bash
cd app
node dist/src/cli.js brief --seed D1                                   # heuristic, as of 1 h after the last evidence
node dist/src/cli.js brief --seed D2 --as-of 2026-09-22T12:00:00Z      # before the merchant's access log: listed as missing
LLM_DISPUTES_ALLOWED=true node dist/src/cli.js brief --seed D1 --provider llm   # replays data/seed/disputes/D1/llm-response.json
LLM_DISPUTES_ALLOWED=true node dist/src/cli.js brief --seed D3 --provider llm   # malformed fixture: one retry, then the heuristic brief
```

The first line of the two LLM runs:

```
llm (replaying a recorded fixture; no API call): 1 attempt(s), summary from llm
llm (replaying a recorded fixture; no API call): 2 attempt(s), fell back to the heuristic brief (no JSON object in the model response)
```

Without `LLM_DISPUTES_ALLOWED=true`, `--provider llm` exits with `--provider llm needs LLM_API_KEY and LLM_DISPUTES_ALLOWED=true`. With a real key and the flag set, the same command calls the Messages API. That path was not exercised here.

## 5. Testnet (not run here)

```bash
scripts/deploy-testnet.sh          # keys, test USDC/EURC + SACs, trustlines, network settings, deploy, merchants
scripts/e2e-testnet.sh             # the full journey with 3-minute windows and a 5-minute arbiter timeout
E2E_BATCH=1 scripts/e2e-testnet.sh # also release_many with 25 orders (verify-first item (d))
```

`e2e-testnet.sh` prints `PASS`/`FAIL` lines for:

- the partial and full refunds, the arbiter split and the timeout refund;
- item (a): a refund to a deauthorised trustline goes pending, then settles after re-authorisation;
- item (b): express predicates (i) reclaim before `T`, (ii) merchant refused before `T`, (iii) merchant claims after `T`, (iv) buyer refused after `T`, (v) the reserve, from `express account` before, during and after;
- item (c): `express status` read through RPC;
- `receipt --verify` for every order.

Record the results in `VALIDATION.md` before any pilot.

### Web checkout (manual, testnet)

1. Run `scripts/deploy-testnet.sh` and copy the printed contract id, issuer and merchant addresses into `web/config.json`.
2. Run `cd app && npm run build:web`, then serve `web/` with any static server.
3. Open `checkout.html?merchant=<M1>&ref=ORD-2001&amount=12.50&asset=USDC` and connect a Freighter or xBull testnet wallet. The page shows "Refunds for this order can only go to: G…XYZ (this wallet)" and the release time in your timezone.
4. Tick "refund to a different wallet I control" and connect a second wallet; it is asked to sign its authorisation entry (`signAuthEntry`). Pay.
5. Check with `refundwin receipt --network testnet --ref ORD-2001 --merchant <M1>`.

For M1, the "Pre-order" option builds the claimable balance instead.
