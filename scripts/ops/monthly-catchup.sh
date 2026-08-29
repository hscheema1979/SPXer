#!/usr/bin/env bash
# monthly-catchup.sh — generate a monthly contract report for every parquet
# date that doesn't already have one. Idempotent and resumable: an interrupted
# run just continues from the next missing date on the next invocation.
#
# This is what makes report coverage self-healing. The nightly EOD pipeline
# calls it, so any day the cron missed (server down, etc.) gets filled the next
# time it runs — not just "today".
#
# Usage:
#   bash scripts/ops/monthly-catchup.sh                  # both SPX and NDX
#   bash scripts/ops/monthly-catchup.sh --instrument SPX # one instrument
#   bash scripts/ops/monthly-catchup.sh --dry-run        # list gaps, generate nothing
set -uo pipefail
cd /home/ubuntu/SPXer
LOG=logs/monthly-catchup.log
mkdir -p logs
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }

INSTRUMENTS="SPX NDX"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instrument) INSTRUMENTS="$2"; shift 2;;
    --dry-run)    DRY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 1;;
  esac
done

TOTAL_GEN=0
for INST in $INSTRUMENTS; do
  lc=$(echo "$INST" | tr 'A-Z' 'a-z')
  pqdir="data/parquet/bars/${lc}-0dte"
  repdir="data/reports/monthly-${lc}"
  mkdir -p "$repdir"
  [ -d "$pqdir" ] || { log "[$INST] no parquet dir $pqdir — skipping"; continue; }

  # Collect parquet dates that have no report yet.
  missing=()
  for f in "$pqdir"/*.parquet; do
    [ -e "$f" ] || continue
    d=$(basename "$f" .parquet)
    echo "$d" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || continue   # skip non-date files
    [ -f "$repdir/$d.json" ] || missing+=("$d")
  done

  n=${#missing[@]}
  log "[$INST] $n missing report(s)"
  [ "$n" -eq 0 ] && continue

  if [ "$DRY" = "1" ]; then
    for d in "${missing[@]}"; do echo "  $INST $d"; done
    continue
  fi

  i=0
  for d in "${missing[@]}"; do
    i=$((i+1))
    if npx tsx scripts/diag/monthly-gen.ts --date "$d" --instrument "$INST" >> "$LOG" 2>&1; then
      log "[$INST] ($i/$n) generated $d ✓"
      TOTAL_GEN=$((TOTAL_GEN+1))
    else
      # Empty/holiday parquet or missing underlying — non-fatal, will retry next run.
      log "[$INST] ($i/$n) FAILED $d (no data?) — skipped"
    fi
  done
done

log "=== monthly-catchup done — generated $TOTAL_GEN report(s) ==="
