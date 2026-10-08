#!/usr/bin/env bash
# Full testnet journey, including the express-mode predicate tests and the
# verify-first items. NOT EXECUTED in the environment this project was built
# in (no testnet access). Review before running. Takes ~20 minutes because it
# waits for real deadlines: windows of 3 minutes, arbiter timeout of 5 minutes.
#
#   1. deploy (scripts/deploy-testnet.sh with short test deadlines);
#   2. four escrow orders: partial refund, full refund, dispute -> resolve,
#      dispute -> timeout; release after T; plus a refund to a deauthorised
#      trustline -> refund_pending -> settle (item (a));
#   3. express predicates (i)-(v) (item (b)) and `express status` through RPC
#      getLedgerEntries (item (c));
#   4. optional (E2E_BATCH=1): release_many with 25 orders (item (d));
#   5. `receipt --verify` for every order.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK=testnet
export ARBITER_TIMEOUT=300 MIN_WINDOW=60 M1_WINDOW=3m M2_WINDOW=3m
"$ROOT/scripts/deploy-testnet.sh"
export REFUNDWIN_DIR="$ROOT/app"
RW="node $ROOT/app/dist/src/cli.js --network testnet"
ISSUER=$(stellar keys address rw-issuer)
M1=$(stellar keys address rw-m1)
M2=$(stellar keys address rw-m2)
TMP=$(mktemp -d)
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; exit 1; }
expect_fail() { if "$@" >"$TMP/out" 2>&1; then fail "expected failure: $*"; else pass "refused as expected: $(tail -1 "$TMP/out")"; fi; }

echo "== 2. escrow orders"
$RW pay --buyer rw-b1 --merchant "$M1" --ref "E2E-1" --asset USDC --amount 49.99
$RW pay --buyer rw-b2 --merchant "$M1" --ref "E2E-2" --asset USDC --amount 120 --refund-to rw-b2-cold
$RW pay --buyer rw-b3 --merchant "$M2" --ref "E2E-3" --asset USDC --amount 29.00
$RW pay --buyer rw-b4 --merchant "$M1" --ref "E2E-4" --asset EURC --amount 37.80
$RW pay --buyer rw-b1 --merchant "$M2" --ref "E2E-5" --asset USDC --amount 15.00
expect_fail $RW pay --buyer rw-b1 --merchant "$M1" --ref "e2e 1" --asset USDC --amount 49.99

$RW refund --merchant rw-m1 --ref E2E-1 --amount 15.00 --yes && pass "partial refund"
$RW refund --merchant rw-m1 --ref E2E-2 --all --yes && pass "full refund to the co-signed cold wallet"
expect_fail $RW refund --merchant rw-m2 --ref E2E-1 --all --yes

printf 'Course login link never worked.\n' > "$TMP/b3.txt"
printf 'Access log shows no login.\n' > "$TMP/m2.txt"
$RW dispute --buyer rw-b3 --ref E2E-3 --reason DIGITAL_NOT_DELIVERED --statement "$TMP/b3.txt"
$RW respond --merchant rw-m2 --ref E2E-3 --statement "$TMP/m2.txt"
$RW brief --ref E2E-3 --out "$TMP/brief.md"
printf '40%% refund\n' > "$TMP/ruling.md"
$RW resolve --arbiter rw-arbiter --ref E2E-3 --refund 11.60 --ruling "$TMP/ruling.md" --yes && pass "arbiter split"

printf 'Not received.\n' > "$TMP/b4.txt"
$RW dispute --buyer rw-b4 --ref E2E-4 --reason NOT_RECEIVED --statement "$TMP/b4.txt"

echo "-- item (a): refund to a deauthorised trustline"
stellar tx new set-trustline-flags --source-account rw-issuer --trustor "$(stellar keys address rw-b1)" --asset "USDC:$ISSUER" --clear-authorize --network $NETWORK
$RW refund --merchant rw-m2 --ref E2E-5 --all --yes | tee "$TMP/pending.txt"
grep -q PENDING "$TMP/pending.txt" && pass "refund recorded as pending (try_transfer caught the failure)" || echo "NOTE  refund did not go pending: record the behaviour for item (a)"
expect_fail $RW settle-refund --ref E2E-5 --caller rw-keeper
stellar tx new set-trustline-flags --source-account rw-issuer --trustor "$(stellar keys address rw-b1)" --asset "USDC:$ISSUER" --set-authorize --network $NETWORK
$RW settle-refund --ref E2E-5 --caller rw-keeper && pass "pending refund settled after re-authorisation"

echo "== 3. express predicates (window 3 minutes)"
acct() { $RW express account --who "$1"; }
acct rw-b1 | tee "$TMP/reserve0.json"
A=$($RW express pay --buyer rw-b1 --merchant "$M1" --ref PRE-A --asset USDC --amount 5 --release-in 3m | awk '/claimable balance/{print $3}')
B=$($RW express pay --buyer rw-b1 --merchant "$M1" --ref PRE-B --asset USDC --amount 5 --release-in 3m | awk '/claimable balance/{print $3}')
C=$($RW express pay --buyer rw-b1 --merchant "$M1" --ref PRE-C --asset USDC --amount 5 --release-in 3m | awk '/claimable balance/{print $3}')
acct rw-b1 | tee "$TMP/reserve1.json"   # (v) reserve locked while the balances exist
$RW express status --id "$A"               # item (c): read through RPC getLedgerEntries
$RW express reclaim --id "$A" --buyer rw-b1 && pass "(i) buyer reclaims before T"
expect_fail $RW express claim --id "$B" --merchant rw-m1   # (ii) CLAIM_CLAIMABLE_BALANCE_CANNOT_CLAIM
echo "waiting for T…"; sleep 200
$RW express claim --id "$B" --merchant rw-m1 && pass "(iii) merchant claims after T"
expect_fail $RW express reclaim --id "$C" --buyer rw-b1   # (iv) buyer after T
$RW express claim --id "$C" --merchant rw-m1
acct rw-b1 | tee "$TMP/reserve2.json"   # (v) reserve returned after the claims
echo "reserve (v): compare xlm/subentries in reserve0/1/2 above and record the figure in VALIDATION.md"

echo "== release and timeout"
$RW release --due --caller rw-keeper && pass "release after T"
echo "waiting for the 5-minute arbiter timeout…"; sleep 120
expect_fail $RW resolve --arbiter rw-arbiter --ref E2E-4 --refund 1 --ruling "$TMP/ruling.md" --yes
$RW timeout --due --caller rw-keeper && pass "timeout refund"

if [ "${E2E_BATCH:-0}" = "1" ]; then
  echo "== 4. item (d): release_many with 25 orders"
  for i in $(seq 1 25); do $RW pay --buyer rw-b3 --merchant "$M2" --ref "BATCH-$i" --asset USDC --amount 0.5 >/dev/null; done
  sleep 190
  $RW release --due --caller rw-keeper && pass "release_many(25) within per-transaction limits"
fi

echo "== 5. receipts"
for r in E2E-1 E2E-2 E2E-3 E2E-4 E2E-5; do
  $RW receipt --ref "$r" --out "$TMP/$r.json" >/dev/null
  $RW receipt --ref "$r" --verify "$TMP/$r.json" | head -1 | grep -q MATCH && pass "receipt $r MATCH" || fail "receipt $r"
done
echo "done; artefacts in $TMP"
