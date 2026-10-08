#!/usr/bin/env bash
# The whole journey on --network local-sim (the TypeScript model of the
# contract; no network, no keys). Deterministic: fixed start time and
# alias-derived synthetic addresses. Usage: scripts/demo-local.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d)
export REFUNDWIN_DIR="$WORK" REFUNDWIN_HOME="$WORK/home" REFUNDWIN_NETWORK=local-sim
CLI="$ROOT/app/dist/src/cli.js"
[ -f "$CLI" ] || (cd "$ROOT/app" && npm run build >/dev/null)
rw() { echo; echo "\$ refundwin $*"; node "$CLI" "$@"; }

rw init --admin psp-admin --arbiter psp-arbiter --fee-to psp-fees --arbiter-timeout 7d --min-window 1h --max-window 60d --start 2026-10-01T09:00:00Z
rw token enable --admin psp-admin --asset USDC
rw merchant add --admin psp-admin --merchant oaxaca --payout oaxaca-payout --fee-bps 150 --window 14d
rw sim fund --to buyer1 --asset USDC --amount 200
rw sim fund --to buyer2 --asset USDC --amount 100
rw pay --buyer buyer1 --merchant oaxaca --ref "ORD-1044" --asset USDC --amount 49.99 --tz -06:00
rw pay --buyer buyer1 --merchant oaxaca --ref "ord 1044" --asset USDC --amount 49.99 || true
rw pay --buyer buyer2 --merchant oaxaca --ref "#1045" --asset USDC --amount 64.00 --refund-to buyer2-cold
rw refund --merchant oaxaca --ref "ORD1044" --amount 15.00 || true
rw refund --merchant oaxaca --ref "ORD1044" --amount 15.00 --yes
rw refund --merchant buyer1 --ref "ORD1044" --all --yes || true

printf 'Hola, pagué el rebozo y no ha llegado. Mi teléfono es +52 55 1234 5678.\n' > "$WORK/buyer.txt"
printf 'Shipped with Estafeta; tracking attached.\n' > "$WORK/merchant.txt"
cp "$ROOT/data/seed/disputes/D1/carrier-status.csv" "$WORK/carrier-status.csv"
rw sim advance --by 10d
rw dispute --buyer buyer2 --ref "#1045" --reason NOT_RECEIVED --statement "$WORK/buyer.txt"
rw respond --merchant oaxaca --ref 1045 --statement "$WORK/merchant.txt" --evidence "$WORK/carrier-status.csv"
rw brief --ref 1045 --out "$WORK/brief.md"
sed -n '5,40p' "$WORK/brief.md"
printf '# Ruling\nParcel held by customs; 40%% refund to the buyer.\n' > "$WORK/ruling.md"
rw resolve --arbiter psp-admin --ref 1045 --refund 25.60 --ruling "$WORK/ruling.md" --yes || true
rw resolve --arbiter psp-arbiter --ref 1045 --refund 25.60 --ruling "$WORK/ruling.md" --yes
rw release --due
rw sim advance --by 4d
rw keeper --once
rw receipt --ref ORD-1044 --out "$WORK/receipt.json"
rw receipt --ref ORD-1044 --verify "$WORK/receipt.json"
python3 - "$WORK/receipt.json" <<'PY'
import json, sys
p = sys.argv[1]; r = json.load(open(p)); r["refunded"] = "0.0000000"; json.dump(r, open(p, "w"))
PY
rw receipt --ref ORD-1044 --verify "$WORK/receipt.json" || true
rw express pay --buyer buyer1 --merchant oaxaca --ref PRE-7 --asset USDC --amount 10 --release-in 14d --refund-to buyer2 || true
rw fees withdraw --admin psp-admin --asset USDC
echo; echo "work dir: $WORK"
