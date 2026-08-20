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

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1: BACKFILL (critical — candlesticks MUST be downloaded)
# ─────────────────────────────────────────────────────────────────────────────
log "[PHASE 1] backfill spx-0dte,ndx-0dte $TODAY"
if npx tsx scripts/backfill/eod-backfill.ts "$TODAY" --only=spx-0dte,ndx-0dte --force >> "$LOG" 2>&1; then
  log "[PHASE 1] backfill OK — candlesticks downloaded ✓"
else
  log "[PHASE 1] backfill FAILED — CRITICAL, exiting"
  log "=== EOD pipeline ABORTED (backfill required) ==="
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: SWEEPS (optional — aggregation/analysis only, independent of backfill)
# ─────────────────────────────────────────────────────────────────────────────
log "[PHASE 2] sweep aggregation start (independent of backfill)"
# Iron-engine accumulators outgrew the 2048MB default (worker + merge OOMs since
# ~Jul 21). Runs after the close, so the bigger footprint doesn't contend with
# live services. Merge heap defaults to 2x worker inside sweep-parallel.
export SWEEP_HEAP_MB=3072
for SYM in SPX NDX; do
  if [ "$BOOTSTRAP" = "1" ]; then
    log "[$SYM] BOOTSTRAP — sharded full recompute, seeding $STATE_DIR/$SYM-*.json"
    npx tsx scripts/diag/sweep-parallel.ts --symbol "$SYM" --engine both --shards 8 \
      --state-dir "$STATE_DIR" >> "$LOG" 2>&1 \
      && log "[$SYM] bootstrap OK (state seeded)" || log "[$SYM] bootstrap FAILED (non-critical)"
  else
    log "[$SYM] INCREMENTAL — replay only $TODAY into persisted state"
    npx tsx scripts/diag/sweep-parallel.ts --symbol "$SYM" --engine both --shards 4 \
      --state-dir "$STATE_DIR" >> "$LOG" 2>&1 \
      && log "[$SYM] incremental OK (sweep+cap/risk updated for $TODAY)" \
      || log "[$SYM] incremental FAILED (non-critical — candlesticks still available)"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3: MONTHLY REPORTS (optional — per-day contract universe for the studio
# Monthly Contracts page; reads the parquet PHASE 1 just wrote)
#
# Uses the catch-up script rather than generating only $TODAY, so coverage is
# self-healing: any prior day still missing a report (cron didn't fire, server
# was down) gets filled here too. On a normal night the only gap is today, so
# this generates exactly one report per instrument — same cost as before.
# ─────────────────────────────────────────────────────────────────────────────
log "[PHASE 3] monthly report catch-up (fills $TODAY + any prior gaps)"
if bash scripts/ops/monthly-catchup.sh >> "$LOG" 2>&1; then
  log "[PHASE 3] monthly reports OK ✓"
else
  log "[PHASE 3] monthly catch-up FAILED (non-critical)"
fi

log "=== EOD pipeline done ==="
