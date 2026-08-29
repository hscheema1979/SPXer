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

# ─────────────────────────────────────────────────────────────────────────────
# ONE PIPELINE AT A TIME (FR-001). Before this lock, overlapping generations
# (cron + manual --now + other agent sessions) stacked hung sweep trees until
# 37 leaked processes OOM-killed unrelated services. The lock is held by fd 9
# for the script's lifetime and auto-releases on ANY exit, including crashes.
# ─────────────────────────────────────────────────────────────────────────────
LOCK="$STATE_DIR/eod.lock"
exec 9<>"$LOCK"
if ! flock -n 9; then
  log "skip — previous run still active (holder pid $(cat "$LOCK" 2>/dev/null || echo '?')); not overlapping"
  exit 0
fi
echo $$ > "$LOCK"

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
# Per-worker wall-clock (FR-001): single-day incremental iron shards peak at
# ~30 min, but a catch-up run replaying several missed days (e.g. NDX after
# the 2026-08-19 leak, ~11 days stale) legitimately needs more — 90 min keeps
# the bound real without false kills on multi-day recovery runs.
export SWEEP_WORKER_TIMEOUT_S=5400
# Outer wall-clock bound (FR-001): legitimate max observed is ≈70 min/symbol
# (credit 7m + iron 29m + bwb 23m + post 4m + slack); 2h is a backstop for a
# hung sweep-parallel WRAPPER (inner per-worker/merge timeouts live in
# sweep-parallel.ts). timeout signals the whole process group; -k escalates
# to SIGKILL after 60s grace.
SWEEP_TIMEOUT=(timeout -k 60s 7200s)
for SYM in SPX NDX; do
  if [ "$BOOTSTRAP" = "1" ]; then
    log "[$SYM] BOOTSTRAP — sharded full recompute, seeding $STATE_DIR/$SYM-*.json"
    if "${SWEEP_TIMEOUT[@]}" npx tsx scripts/diag/sweep-parallel.ts --symbol "$SYM" --engine both --shards 8 \
      --state-dir "$STATE_DIR" >> "$LOG" 2>&1; then
      log "[$SYM] bootstrap OK (state seeded)"
    else
      RC=$?
      [ "$RC" = "124" ] || [ "$RC" = "137" ] \
        && log "[$SYM] bootstrap TIMED OUT after 2h (tree killed — non-critical)" \
        || log "[$SYM] bootstrap FAILED rc=$RC (non-critical)"
    fi
  else
    log "[$SYM] INCREMENTAL — replay only $TODAY into persisted state"
    if "${SWEEP_TIMEOUT[@]}" npx tsx scripts/diag/sweep-parallel.ts --symbol "$SYM" --engine both --shards 4 \
      --state-dir "$STATE_DIR" >> "$LOG" 2>&1; then
      log "[$SYM] incremental OK (sweep+cap/risk updated for $TODAY)"
    else
      RC=$?
      [ "$RC" = "124" ] || [ "$RC" = "137" ] \
        && log "[$SYM] incremental TIMED OUT after 2h (tree killed — non-critical — candlesticks still available)" \
        || log "[$SYM] incremental FAILED rc=$RC (non-critical — candlesticks still available)"
    fi
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
