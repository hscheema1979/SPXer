#!/usr/bin/env bash
# eod-pipeline.sh — End-of-day automated pipeline for SPX + NDX.
#
#   1. Backfill the day's 1m parquet (underlying + FULL option band) Polygon-only
#   2. SPX full sweep (credit + iron, 8-way parallel) → auto curate +
#      concurrent-distribution (cap [1..15,uncap] + risk distribution)
#   3. NDX full sweep, same.
#
# Trigger:
#   • CLI (run now):   bash scripts/ops/eod-pipeline.sh --now    (or: npm run eod)
#   • Cron (15 min after the 16:00 ET close): fires 20:15 AND 21:15 UTC Mon-Fri;
#     the built-in ET gate lets exactly ONE through at 16:15 ET (DST-safe — the
#     off-DST fire no-ops). Idempotent: backfill skips days already written.
set -uo pipefail
cd /home/ubuntu/SPXer
LOG=logs/eod-pipeline.log
mkdir -p logs
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

FORCE=0
[ "${1:-}" = "--now" ] && FORCE=1
[ "${EOD_FORCE:-}" = "1" ] && FORCE=1

# DST-safe gate: only run at ~16:15 ET (15 min after the 16:00 close). Cron
# fires at both 20:15 and 21:15 UTC; only the one that maps to 16:xx ET passes.
if [ "$FORCE" != "1" ]; then
  ETHM=$(TZ=America/New_York date +%H%M)
  if [ "$ETHM" -lt 1600 ] || [ "$ETHM" -ge 1700 ]; then
    log "skip — ET $ETHM not in close window (use --now to force)"
    exit 0
  fi
fi

log "=== EOD pipeline start (ET $(TZ=America/New_York date +%H:%M), force=$FORCE) ==="

# 1. Backfill SPX + NDX for today (idempotent unless --force semantics differ).
log "[1/3] backfill spx-0dte,ndx-0dte"
if npx tsx scripts/backfill/eod-backfill.ts "$(TZ=America/New_York date +%F)" --only=spx-0dte,ndx-0dte --force >> "$LOG" 2>&1; then
  log "[1/3] backfill OK"
else
  log "[1/3] backfill FAILED — continuing to sweep stale-safe (skips missing days)"
fi

# 2-3. Full parallel sweep + auto curate/concurrent-distribution, per symbol.
for SYM in SPX NDX; do
  log "[$SYM] sweep-parallel --engine both (8-way) + auto curate/concurrent-distribution"
  if npx tsx scripts/diag/sweep-parallel.ts --symbol "$SYM" --engine both --shards 8 >> "$LOG" 2>&1; then
    log "[$SYM] sweep + cap/risk OK"
  else
    log "[$SYM] sweep FAILED — see log above"
  fi
done

log "=== EOD pipeline done ==="
