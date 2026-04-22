#!/bin/bash
# Queue replay batch runs 3 at a time, polling until all complete
# Usage: bash scripts/queue-batch-runs.sh

API="http://localhost:3601/replay/api"
DATES=$(curl -s "$API/dates")
MAX_CONCURRENT=3

# Configs that need running (< 267 days)
QUEUE=(
  "spx-hma3x12-otm10-tp115x-sl25-3m-25c-\$10000"
  "spx-hma3x12-otm10-tp115x-sl25-5m-25c-\$10000"
  "spx-hma3x12-otm5-tp115x-sl25-5m-25c-\$10000"
  "spx-hma3x19-otm10-tp115x-sl25-3m-25c-\$10000"
  "spx-hma3x19-otm10-tp115x-sl25-5m-25c-\$10000"
  "spx-hma3x19-otm10-tp125x-sl25-3m-25c-\$10000"
  "spx-hma3x19-otm10-tp125x-sl25-5m-25c-\$10000"
  "spx-hma3x19-otm5-tp115x-sl25-3m-25c-\$10000"
  "spx-hma3x19-otm5-tp115x-sl25-5m-25c-\$10000"
  "spx-hma3x19-otm5-tp125x-sl25-3m-25c-\$10000"
  "spx-hma3x19-otm5-tp125x-sl25-5m-25c-\$10000"
  "spx-hma3x21-otm10-tp115x-sl25-3m-25c-\$10000"
  "spx-hma3x21-otm10-tp115x-sl25-5m-25c-\$10000"
  "spx-hma3x21-otm10-tp125x-sl25-3m-25c-\$10000"
  "spx-hma3x21-otm10-tp125x-sl25-5m-25c-\$10000"
  "spx-hma3x21-otm5-tp115x-sl25-3m-25c-\$10000"
  "spx-hma3x21-otm5-tp115x-sl25-5m-25c-\$10000"
  "spx-hma3x21-otm5-tp125x-sl25-3m-25c-\$10000"
  "spx-hma3x21-otm5-tp125x-sl25-5m-25c-\$10000"
  "spx-hma3x25-otm10-tp115x-sl25-3m-25c-\$10000"
  "spx-hma3x25-otm10-tp115x-sl25-5m-25c-\$10000"
)

QUEUE_IDX=0
TOTAL=${#QUEUE[@]}

echo "=== Batch Queue: $TOTAL configs to run ==="

while true; do
  # Count active jobs
  ACTIVE=$(curl -s "$API/jobs" | python3 -c "
import sys, json
jobs = json.load(sys.stdin)
active = [j for j in jobs if j.get('status') in ('running', 'pending')]
print(len(active))
for j in active:
    pct = round(100*j.get('completed',0)/max(j.get('total',267),1),1)
    print(f'  {j[\"configId\"]} {j.get(\"completed\",0)}/{j.get(\"total\",267)} ({pct}%)', file=sys.stderr)
" 2>&1)

  ACTIVE_COUNT=$(echo "$ACTIVE" | head -1)
  echo "$ACTIVE" | tail -n +2

  # Queue new jobs if slots available
  SLOTS=$((MAX_CONCURRENT - ACTIVE_COUNT))
  while [ $SLOTS -gt 0 ] && [ $QUEUE_IDX -lt $TOTAL ]; do
    CONFIG="${QUEUE[$QUEUE_IDX]}"

    # Check if already has 267 results
    DONE=$(sqlite3 /home/ubuntu/SPXer/data/spxer.db "SELECT COUNT(*) FROM replay_results WHERE configId='$CONFIG'")
    if [ "$DONE" -ge 267 ]; then
      echo "SKIP (already done): $CONFIG"
      QUEUE_IDX=$((QUEUE_IDX + 1))
      continue
    fi

    echo "QUEUE [$((QUEUE_IDX+1))/$TOTAL]: $CONFIG"
    curl -s -X POST "$API/run-batch" \
      -H 'Content-Type: application/json' \
      -d "{\"configId\":\"$CONFIG\",\"dates\":$DATES}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  -> {d.get(\"jobId\",\"?\")[:8]}... {d.get(\"status\",d.get(\"error\",\"?\"))}')" 2>/dev/null || echo "  -> queued"

    QUEUE_IDX=$((QUEUE_IDX + 1))
    SLOTS=$((SLOTS - 1))
  done

  # Check if we're done
  if [ $QUEUE_IDX -ge $TOTAL ] && [ "$ACTIVE_COUNT" -eq 0 ]; then
    echo "=== ALL DONE ==="
    break
  fi

  echo "--- $(date '+%H:%M:%S') | Queued: $QUEUE_IDX/$TOTAL | Active: $ACTIVE_COUNT ---"
  sleep 30
done
