#!/bin/bash
# run-backtest.sh — Run replay across multiple dates with configurable parallelism.
#
# Usage:
#   ./scripts/backtest/run-backtest.sh                        # all 22 days, default config
#   ./scripts/backtest/run-backtest.sh --config=aggressive    # preset config
#   ./scripts/backtest/run-backtest.sh --parallel=4           # 4 concurrent replays
#   ./scripts/backtest/run-backtest.sh --no-judge             # deterministic only (fast)
#   ./scripts/backtest/run-backtest.sh --dates="2026-03-18,2026-03-19,2026-03-20"
#
set -euo pipefail

cd "$(dirname "$0")/../.."

PARALLEL=${PARALLEL:-3}
CONFIG=""
NO_JUDGE=""
QUIET="--quiet"
CUSTOM_DATES=""

for arg in "$@"; do
  case $arg in
    --parallel=*) PARALLEL="${arg#*=}" ;;
    --config=*) CONFIG="--config=${arg#*=}" ;;
    --config-id=*) CONFIG="--config-id=${arg#*=}" ;;
    --no-judge) NO_JUDGE="--no-judge" ;;
    --verbose) QUIET="" ;;
    --dates=*) CUSTOM_DATES="${arg#*=}" ;;
  esac
done

# Default: all 22 backfilled trading days
if [[ -n "$CUSTOM_DATES" ]]; then
  IFS=',' read -ra DATES <<< "$CUSTOM_DATES"
else
  DATES=(
    2026-02-20
    2026-02-23 2026-02-24 2026-02-25 2026-02-26 2026-02-27
    2026-03-02 2026-03-03 2026-03-04 2026-03-05 2026-03-06
    2026-03-09 2026-03-10 2026-03-11 2026-03-12 2026-03-13
    2026-03-16 2026-03-17 2026-03-18 2026-03-19 2026-03-20
  )
fi

mkdir -p replay-logs

echo "=========================================="
echo "  BACKTEST: ${#DATES[@]} days | parallel=$PARALLEL"
echo "  Config: ${CONFIG:-default} ${NO_JUDGE:+| no-judge}"
echo "=========================================="

RUNNING=0
COMPLETED=0
FAILED=0

for date in "${DATES[@]}"; do
  # Wait if at concurrency limit
  while [[ $RUNNING -ge $PARALLEL ]]; do
    wait -n 2>/dev/null || true
    RUNNING=$((RUNNING - 1))
  done

  logfile="replay-logs/${date}.log"
  (
    npx tsx src/replay/cli.ts run "$date" $CONFIG $NO_JUDGE $QUIET > "$logfile" 2>&1
    echo "  Done: $date ($(tail -1 "$logfile" | grep -oP 'totalPnl":\K[^,}]+' || echo '?'))"
  ) &
  RUNNING=$((RUNNING + 1))
done

wait

echo ""
echo "=========================================="
echo "  BACKTEST COMPLETE"
echo "=========================================="

# Print summary from store
echo ""
echo "Results saved to replay-logs/ and data/spxer.db"
echo "View results: npx tsx scripts/backtest/view-results.ts"
