#!/usr/bin/env bash
# sweep-reaper.sh — kill stale SPXer EOD/sweep process trees (FR-001).
#
# THIRD layer of process-lifecycle defense; the first two are:
#   1. sweep-parallel.ts per-step timeouts (worker 45 min / merge 15 min,
#      SWEEP_WORKER_TIMEOUT_S / SWEEP_MERGE_TIMEOUT_S)
#   2. eod-pipeline.sh flock + 2h-per-symbol `timeout` wrapper
# This script catches whatever escaped both — e.g. a wrapper that was SIGKILLd
# outright, orphaning its detached workers (the 2026-07-31..08-19 leak stacked
# ~4-6 orphaned processes/day that way; see .termchat/specs/FR-001.md).
#
# Match rule: cmdline contains a sweep-family script path AND elapsed time
# exceeds MAX_AGE_H. 6h mirrors pruneStaleShards()'s staleness threshold in
# sweep-parallel.ts — no legitimate pipeline component has ever exceeded ~35
# minutes (eod-pipeline.log history), so anything older is leaked by
# definition. Deliberately NEVER matches editors/pagers/agents that merely
# reference these filenames, nor backtest-studio, live-capture, or OptionX.
#
# Usage:  sweep-reaper.sh [--dry-run]
# Cron:   13,43 * * * * /home/ubuntu/SPXer/scripts/ops/sweep-reaper.sh >> /home/ubuntu/SPXer/logs/sweep-reaper.log 2>&1
set -uo pipefail

ROOT=/home/ubuntu/SPXer
LOG_DIR="$ROOT/logs"
MAX_AGE_H="${SWEEP_REAP_AGE_H:-6}"
MAX_AGE_S=$(( MAX_AGE_H * 3600 ))
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
STAMP(){ date -u +%Y-%m-%dT%H:%M:%SZ; }

# Exact script path fragments — anchored to repo-relative paths so unrelated
# processes (a user's own iron-sweep study in another checkout) still match by
# AGE only if they use these same scripts, which is the intent.
PATTERN='(scripts/ops/eod-pipeline\.sh|scripts/diag/sweep-parallel\.ts|scripts/diag/credit-spread-sweep\.ts|scripts/diag/iron-sweep\.ts|scripts/diag/broken-wing-butterfly-sweep\.ts|scripts/diag/concurrent-distribution\.ts|scripts/diag/curate-risk-targets\.ts)'

# descendants(pid) → pid plus every recursive child (npx/tsx/esbuild chain).
descendants(){ local p=$1 c; echo "$p"; for c in $(pgrep -P "$p" 2>/dev/null); do descendants "$c"; done; }

mkdir -p "$LOG_DIR"
for PID in $(pgrep -f "$PATTERN" | sort -un); do
  [ "$PID" = "$$" ] && continue
  CMD=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null)
  [ -n "$CMD" ] || continue                                   # zombie/ kernel thread
  case "$CMD" in                                              # mere holders, never kill
    *vi\ *|*vim\ *|*nano\ *|*less\ *|*more\ *|*tail\ *|*head\ *|*grep\ *|*claude\ *|*sweep-reaper*|*shell-snapshots*) continue ;;
  esac
  ET=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' ')
  { [ -n "$ET" ] && [ "$ET" -ge "$MAX_AGE_S" ]; } || continue
  TREE=$(descendants "$PID" | sort -un)
  FLAT=$(echo "$TREE" | tr '\n' ',' | sed 's/,$//')
  if [ "$DRY_RUN" = "1" ]; then
    echo "[$(STAMP)] DRY-RUN would kill pids $FLAT (age ${ET}s): $CMD"
    continue
  fi
  echo "[$(STAMP)] REAPING pids $FLAT (age ${ET}s): $CMD"
  # TERM first (sweep-parallel's handler then kills its own detached groups),
  # KILL the survivors after a grace period.
  kill -TERM $TREE 2>/dev/null
  sleep 5
  kill -KILL $TREE 2>/dev/null
done
[ "$DRY_RUN" = "1" ] && echo "[$(STAMP)] dry-run complete — no processes were killed"
exit 0
