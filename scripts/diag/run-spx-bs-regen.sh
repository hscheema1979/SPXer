#!/usr/bin/env bash
# Sequential BS-priced multi-DTE regen → -bs files (dashboard untouched). One DTE
# at a time to avoid DuckDB parquet-read contention with live services.
set -uo pipefail
cd /home/ubuntu/SPXer
LOG=logs/bs-regen-driver.log
echo "[$(date '+%H:%M:%S')] BS regen driver start (pid $$)" >> "$LOG"
for DTE in 1 2 5 10 15 20; do
  echo "[$(date '+%H:%M:%S')] BEGIN ${DTE}DTE BS" >> "$LOG"
  SWEEP_ALLOW_SERIAL=1 SWEEP_PRICING=bs nice -n 15 npx tsx scripts/diag/multi-dte-credit-sweep.ts --symbol SPX --dte "$DTE" >> "logs/bs-engine-${DTE}dte.log" 2>&1
  echo "[$(date '+%H:%M:%S')] END ${DTE}DTE BS (exit $?)" >> "$LOG"
done
echo "[$(date '+%H:%M:%S')] BS regen driver DONE" >> "$LOG"
