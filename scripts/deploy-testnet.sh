#!/usr/bin/env bash
# Deploys refund_escrow to Stellar testnet with self-issued test assets.
#
# NOT EXECUTED in the environment this project was built in: the sandbox could
# not reach soroban-testnet.stellar.org, horizon or friendbot. The script
# follows the documented stellar-cli 28 flow and is expected to work from a
# machine with network access. Review before running.
#
# What it does:
#   1. creates and funds (Friendbot) the PSP, merchant, buyer and keeper keys;
#   2. issues test USDC and EURC from a revocable issuer (so a buyer's
#      trustline can be deauthorised to test verify-first item (a)) and
#      deploys their Stellar Asset Contracts;
#   3. opens trustlines and mints test balances;
#   4. records `stellar network settings` (max entry TTL, per-tx limits) in
#      target/network-settings.json (items (c)/(d), TTL cap);
#   5. deploys and constructs refund_escrow, then attaches the app to it
#      (app/.refundwin.json), enables the assets and adds merchants M1 and M2.
#
# Requires: stellar-cli 28, Node 22 (app built with `npm ci && npm run build`).
# Env overrides: ARBITER_TIMEOUT (s, default 604800), MIN_WINDOW (s, 3600),
#   MAX_WINDOW (s, 5184000), M1_WINDOW / M2_WINDOW (durations, 14d / 3d).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NETWORK="${NETWORK:-testnet}"
ARBITER_TIMEOUT="${ARBITER_TIMEOUT:-604800}"
MIN_WINDOW="${MIN_WINDOW:-3600}"
MAX_WINDOW="${MAX_WINDOW:-5184000}"
M1_WINDOW="${M1_WINDOW:-14d}"
M2_WINDOW="${M2_WINDOW:-3d}"
WASM="$ROOT/target/wasm32v1-none/release/refund_escrow.wasm"
RW="node $ROOT/app/dist/src/cli.js --network testnet"
export REFUNDWIN_DIR="$ROOT/app"

[ -f "$WASM" ] || stellar contract build
[ -f "$ROOT/app/dist/src/cli.js" ] || (cd "$ROOT/app" && npm ci && npm run build)

# 1. Identities (idempotent).
KEYS="rw-admin rw-arbiter rw-fees rw-issuer rw-keeper rw-m1 rw-m1-payout rw-m2 rw-m2-payout rw-b1 rw-b2 rw-b3 rw-b4 rw-b2-cold"
for k in $KEYS; do
  stellar keys address "$k" >/dev/null 2>&1 || stellar keys generate "$k" --network "$NETWORK" --fund
done
addr() { stellar keys address "$1"; }
ISSUER=$(addr rw-issuer)

# 2. Test assets: revocable issuer, SACs.
stellar tx new set-options --source-account rw-issuer --set-revocable --network "$NETWORK" >/dev/null
declare -A SAC
for code in USDC EURC; do
  SAC[$code]=$(stellar contract asset deploy --asset "$code:$ISSUER" --source-account rw-issuer --network "$NETWORK" 2>/dev/null \
    || stellar contract id asset --asset "$code:$ISSUER" --network "$NETWORK")
  echo "asset $code:$ISSUER  SAC ${SAC[$code]}  (self-issued test asset, not real $code)"
done

# 3. Trustlines and test balances (amounts in stroops: 1000 units).
for k in rw-fees rw-m1 rw-m1-payout rw-m2 rw-m2-payout rw-b1 rw-b2 rw-b3 rw-b4 rw-b2-cold; do
  for code in USDC EURC; do
    stellar tx new change-trust --source-account "$k" --line "$code:$ISSUER" --network "$NETWORK" >/dev/null
  done
done
for k in rw-b1 rw-b2 rw-b3 rw-b4; do
  for code in USDC EURC; do
    stellar tx new payment --source-account rw-issuer --destination "$(addr $k)" --asset "$code:$ISSUER" --amount 10000000000 --network "$NETWORK" >/dev/null
  done
done

# 4. Network limits (TTL cap for orders; per-transaction resources for MAX_BATCH).
mkdir -p "$ROOT/target"
stellar network settings --network "$NETWORK" --output json > "$ROOT/target/network-settings.json" || true
echo "network settings saved to target/network-settings.json (check max entry TTL >= max_window + arbiter_timeout + 14d)"

# 5. Contract.
CONTRACT_ID=$(stellar contract deploy --wasm "$WASM" --source-account rw-admin --network "$NETWORK" -- \
  --admin "$(addr rw-admin)" --arbiter "$(addr rw-arbiter)" --fee_to "$(addr rw-fees)" \
  --arbiter_timeout "$ARBITER_TIMEOUT" --min_window "$MIN_WINDOW" --max_window "$MAX_WINDOW")
echo "refund_escrow $CONTRACT_ID"

$RW init --contract "$CONTRACT_ID" --admin rw-admin --arbiter rw-arbiter --fee-to rw-fees \
  --arbiter-timeout "$ARBITER_TIMEOUT" --min-window "$MIN_WINDOW" --max-window "$MAX_WINDOW"
for code in USDC EURC; do $RW token enable --admin rw-admin --asset "$code:$ISSUER"; done
$RW merchant add --admin rw-admin --merchant rw-m1 --payout rw-m1-payout --fee-bps 150 --window "$M1_WINDOW"
$RW merchant add --admin rw-admin --merchant rw-m2 --payout rw-m2-payout --fee-bps 125 --window "$M2_WINDOW"

cat <<MSG

Deployed. For the web checkout, put these into web/config.json:
  contractId          $CONTRACT_ID
  assets.USDC.issuer  $ISSUER
  assets.EURC.issuer  $ISSUER
  merchants           $(addr rw-m1) (M1, express on), $(addr rw-m2) (M2)
Then: cd app && npm run build:web && npx serve ../web  (open checkout.html?merchant=…&ref=ORD-1&amount=49.99&asset=USDC)
MSG
