#!/usr/bin/env bash
# eod-pipeline.sh — End-of-day automated pipeline for SPX + NDX.
#
#   1. Backfill the day's 1m parquet (underlying + option band) — Polygon-only
#   2. SPX full sweep (credit + iron, 8-way parallel) → auto curate +
#      concurrent-distribution (cap [1..15,uncap] + risk distribution)
#   3. NDX full sweep, same.
#
# sweep-parallel.ts --engine both auto-runs pipeline steps 4-5
# (curate-risk-targets → concurrent-distribution), so cap/risk data is always
# fresh — no manual step. Idempotent: backfill skips days already written
# (no --force); re-running is safe.
#
# Cron (installed): 30 22 * * 1-5  (22:30 UTC weekdays ≈ 17:30/18:30 ET,
# well after the 16:00 ET close + 0DTE settle).
set -uo pipefail
cd /home/ubuntu/SPXer
LOG=logs/eod-pipeline.log
mkdir -p logs
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

log "=== EOD pipeline start ==="

# 1. Backfill SPX + NDX (last weekday by default; idempotent)
log "[1/3] backfill spx-0dte,ndx-0dte"
if npx tsx scripts/backfill/eod-backfill.ts --only=spx-0dte,ndx-0dte >> "$LOG" 2>&1; then
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
