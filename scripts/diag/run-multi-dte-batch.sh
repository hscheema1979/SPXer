#!/usr/bin/env bash
# run-multi-dte-batch.sh — sequential multi-DTE credit-put-spread sweeps for
# NDX + SPX across all DTEs, reading the local flat-file disk cache (no S3).
# Each profile writes scripts/autoresearch/output/spread-sweep-{sym}-{dte}dte.json
# which the Studio Spreads dashboard auto-discovers via /api/profiles.
#
# Usage: bash scripts/diag/run-multi-dte-batch.sh [SHARDS]
set -uo pipefail
cd "$(dirname "$0")/../.."

SHARDS="${1:-3}"
DTES=(1 2 3 5 10 15 20 30 40 60)
SYMBOLS=(NDX SPX)
LOG=/tmp/multi-dte-batch.log
: > "$LOG"

echo "=== multi-DTE batch start $(date) | shards=$SHARDS ===" | tee -a "$LOG"
for sym in "${SYMBOLS[@]}"; do
  for dte in "${DTES[@]}"; do
    echo ">>> $sym ${dte}DTE  $(date +%H:%M:%S)" | tee -a "$LOG"
    npx tsx scripts/diag/sweep-parallel.ts --symbol "$sym" --dte "$dte" \
        --engine multi-dte --shards "$SHARDS" --no-post >> "$LOG" 2>&1
    rc=$?
    out="scripts/autoresearch/output/spread-sweep-${sym,,}-${dte}dte.json"
    if [ -f "$out" ]; then
      sz=$(stat -c%s "$out" 2>/dev/null || echo 0)
      echo "    OK $sym ${dte}DTE → $out (${sz}B) rc=$rc" | tee -a "$LOG"
    else
      echo "    WARN $sym ${dte}DTE → no output file (rc=$rc)" | tee -a "$LOG"
    fi
  done
done
echo "=== multi-DTE batch done $(date) ===" | tee -a "$LOG"
