#!/usr/bin/env bash
# Starts the Masumi Standard API (127.0.0.1:4200, paid mode) and the Sokosumi Coworker worker.
# Run from the bulkhead/ folder after `pnpm dev:stable` is up (engine on 127.0.0.1:4000) and the
# dedicated MPS is healthy (127.0.0.1:3901). Tokens are read from .local files and never printed.
# Logs: apps/sokosumi-worker/.local/{standard-api,worker}.log
set -euo pipefail
cd "$(dirname "$0")/.."
LOCAL=apps/sokosumi-worker/.local

# MPS_RUNTIME_TOKEN (ReadAndPay, scoped to the Selling wallet)
set -a; . "$LOCAL/mps-runtime.env"; set +a
AGENT_ID=$(node -e 'const s=require("./'"$LOCAL"'/registration-state.json");const f=o=>o&&typeof o==="object"?(o.agentIdentifier||Object.values(o).map(f).find(Boolean)):undefined;process.stdout.write(f(s)||"")')
[ -n "$AGENT_ID" ] || { echo "agentIdentifier not found in $LOCAL/registration-state.json" >&2; exit 1; }

# Preprod tUSDM (CIP-68 333), 6 decimals; 2500000 = 2.5 tUSDM.
TUSDM_UNIT=16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d

STANDARD_MPS_URL=http://127.0.0.1:3901 \
STANDARD_MPS_TOKEN="$MPS_RUNTIME_TOKEN" \
STANDARD_MPS_AGENT_IDENTIFIER="$AGENT_ID" \
STANDARD_MPS_PAYMENT_SOURCE_INDEX=0 \
STANDARD_MPS_PRICE_UNIT="${STANDARD_MPS_PRICE_UNIT:-$TUSDM_UNIT}" \
STANDARD_MPS_PRICE_AMOUNT="${STANDARD_MPS_PRICE_AMOUNT:-2500000}" \
  nohup pnpm --filter @bulkhead/engine exec tsx --env-file-if-exists="$PWD/.env" scripts/standard-api-server.ts \
  > "$LOCAL/standard-api.log" 2> "$LOCAL/standard-api.err.log" &
echo "standard-api pid $!"

[ -n "${ONLY_STANDARD_API:-}" ] && exit 0
nohup pnpm --filter @bulkhead/sokosumi-worker start > "$LOCAL/worker.log" 2> "$LOCAL/worker.err.log" &
echo "worker pid $!"
