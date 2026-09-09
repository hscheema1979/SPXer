#!/usr/bin/env bash
# Regenerate the full multi-day credit grid for SPX 3DTE then 5DTE.
# Detached driver — survives session boundaries (launched via setsid nohup).
set -uo pipefail
cd /home/ubuntu/SPXer
LOG=logs/sweep-multidte-spx-35.log

echo "[$(date '+%H:%M:%S')] DRIVER START (pid $$)" >> "$LOG"

for DTE in 3 5; do
  echo "[$(date '+%H:%M:%S')] ===== BEGIN SPX ${DTE}DTE =====" >> "$LOG"
  npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --dte "$DTE" --engine multi-dte --shards 6 >> "$LOG" 2>&1
  rc=$?
  echo "[$(date '+%H:%M:%S')] ===== END SPX ${DTE}DTE (exit $rc) =====" >> "$LOG"
done

echo "[$(date '+%H:%M:%S')] DRIVER DONE" >> "$LOG"
