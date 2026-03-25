#!/bin/bash

# Last-days replay — focused analysis of recent trading days
# Usage: bash run-last-days-replay.sh [num-days]
#        default: 5 most recent trading days
#        example: bash run-last-days-replay.sh 3  (last 3 days)

NUM_DAYS=${1:-5}

echo "═══════════════════════════════════════════════════════════════════"
echo "  SPXer Last-Days Replay (Last $NUM_DAYS Trading Days)"
echo "  Started: $(date)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# All 22 trading dates in order
all_dates=(
  "2026-02-20"
  "2026-02-23"
  "2026-02-24"
  "2026-02-25"
  "2026-02-26"
  "2026-02-27"
  "2026-03-02"
  "2026-03-03"
  "2026-03-04"
  "2026-03-05"
  "2026-03-06"
  "2026-03-09"
  "2026-03-10"
  "2026-03-11"
  "2026-03-12"
  "2026-03-13"
  "2026-03-16"
  "2026-03-17"
  "2026-03-18"
  "2026-03-19"
  "2026-03-20"
)

# Get last N dates
total=${#all_dates[@]}
start_idx=$((total - NUM_DAYS))
dates=("${all_dates[@]:$start_idx}")

echo "Processing: ${dates[@]}"
echo ""

# Create output directory
mkdir -p replay-logs

# Run each date sequentially with verbose output
total_pnl=0
total_trades=0
total_wins=0

for date in "${dates[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📅 $date"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  npx tsx src/replay/cli.ts run "$date" 2>&1 | tee "replay-logs/$date.log"

  # Extract metrics from output
  if grep -q "SUMMARY:" "replay-logs/$date.log"; then
    trades=$(grep "Trades:" "replay-logs/$date.log" | tail -1 | awk '{print $2}' | tr -d '|')
    winrate=$(grep "Win rate:" "replay-logs/$date.log" | tail -1 | awk '{print $NF}' | tr -d '%')
    pnl=$(grep "Total P&L:" "replay-logs/$date.log" | tail -1 | awk '{print $NF}' | tr -d '$' | sed 's/,//g')

    if [ -n "$trades" ] && [ -n "$pnl" ]; then
      total_trades=$((total_trades + trades))
      total_pnl=$(echo "$total_pnl + $pnl" | bc)
      if [ -n "$winrate" ]; then
        wins=$(echo "$trades * $winrate / 100" | bc)
        total_wins=$((total_wins + wins))
      fi
    fi
  fi

  echo ""
  sleep 2
done

# Final summary
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  $NUM_DAYS-DAY SUMMARY"
echo "═══════════════════════════════════════════════════════════════════"
echo "  Dates: ${dates[0]} → ${dates[-1]}"
echo "  Total Trades: $total_trades"
echo "  Total Wins: $total_wins"
if [ $total_trades -gt 0 ]; then
  win_rate=$(echo "scale=1; $total_wins * 100 / $total_trades" | bc)
  echo "  Overall Win Rate: ${win_rate}%"
fi
echo "  Total P&L: \$$total_pnl"
echo "═══════════════════════════════════════════════════════════════════"
echo "  Finished: $(date)"
echo ""
echo "📁 All daily logs: replay-logs/*.log"
