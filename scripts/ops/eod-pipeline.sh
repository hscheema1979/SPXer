#!/usr/bin/env bash
# eod-pipeline.sh — End-of-day pipeline for SPX + NDX.
#
# NIGHTLY (default): backfill TODAY (1 day, ~30s API) → INCREMENTAL sweep:
#   each engine loads its persisted accumulator and replays ONLY today's new
#   date, merges, rewrites the full-history dashboard JSON, re-persists state.
#   The sweep does NOT re-run all ~278 days. Whole thing ≈ a minute.
#
# BOOTSTRAP (--bootstrap, run ONCE or after a config change): sharded full
#   recompute over all history that SEEDS the per-(symbol,engine) state files
#   so every nightly run after it can go incremental. ~12-15 min, 8-way.
#
# Triggers:
#   • nightly cron 15 20,21 * * 1-5 (16:15 ET, DST-safe gate)
#   • CLI now:        bash scripts/ops/eod-pipeline.sh --now   (npm run eod)
#   • CLI bootstrap:  bash scripts/ops/eod-pipeline.sh --now --bootstrap
set -uo pipefail
cd /home/ubuntu/SPXer
LOG=logs/eod-pipeline.log
STATE_DIR=data/sweep-state
mkdir -p logs "$STATE_DIR"
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

FORCE=0 BOOTSTRAP=0
for arg in "$@"; do
  [ "$arg" = "--now" ] && FORCE=1
  [ "$arg" = "--bootstrap" ] && BOOTSTRAP=1
done
[ "${EOD_FORCE:-}" = "1" ] && FORCE=1

# DST-safe gate (skip unless ~16:15 ET) — bypassed by --now.
if [ "$FORCE" != "1" ]; then
  ETHM=$(TZ=America/New_York date +%H%M)
  if [ "$ETHM" -lt 1600 ] || [ "$ETHM" -ge 1700 ]; then
    log "skip — ET $ETHM not in close window (use --now)"; exit 0
  fi
fi
TODAY=$(TZ=America/New_York date +%F)
log "=== EOD pipeline start (ET $(TZ=America/New_York date +%H:%M) | today=$TODAY | bootstrap=$BOOTSTRAP) ==="

# 1. Backfill TODAY only (1 day — seconds).
log "[1] backfill spx-0dte,ndx-0dte $TODAY"
if npx tsx scripts/backfill/eod-backfill.ts "$TODAY" --only=spx-0dte,ndx-0dte --force >> "$LOG" 2>&1; then
  log "[1] backfill OK"
else
  log "[1] backfill FAILED — continuing (sweep skips missing days)"
fi

for SYM in SPX NDX; do
  if [ "$BOOTSTRAP" = "1" ]; then
    log "[$SYM] BOOTSTRAP — sharded full recompute, seeding $STATE_DIR/$SYM-*.json"
    npx tsx scripts/diag/sweep-parallel.ts --symbol "$SYM" --engine both --shards 8 \
      --state-dir "$STATE_DIR" >> "$LOG" 2>&1 \
      && log "[$SYM] bootstrap OK (state seeded)" || log "[$SYM] bootstrap FAILED"
  else
    log "[$SYM] INCREMENTAL — replay only $TODAY into persisted state"
    ok=1
    SWEEP_STATE="$STATE_DIR/$SYM-credit.json"   npx tsx scripts/diag/credit-spread-sweep.ts   --symbol "$SYM" >> "$LOG" 2>&1 || ok=0
    SWEEP_STATE="$STATE_DIR/$SYM-iron.json"     npx tsx scripts/diag/iron-sweep.ts            --symbol "$SYM" >> "$LOG" 2>&1 || ok=0
    npx tsx scripts/diag/curate-risk-targets.ts --symbol "$SYM" >> "$LOG" 2>&1 || ok=0
    SWEEP_STATE="$STATE_DIR/$SYM-concdist.json" npx tsx scripts/diag/concurrent-distribution.ts --symbol "$SYM" >> "$LOG" 2>&1 || ok=0
    [ "$ok" = "1" ] && log "[$SYM] incremental OK (sweep+cap/risk updated for $TODAY)" \
                     || log "[$SYM] incremental had a FAILURE — see log above"
  fi
done

log "=== EOD pipeline done ==="
