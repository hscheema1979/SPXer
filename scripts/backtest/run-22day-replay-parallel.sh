#!/bin/bash

# Parallel 22-day backtest suite
# Runs multiple dates in parallel to speed up backtesting
# Usage: bash run-22day-replay-parallel.sh [max-parallel-jobs]

MAX_JOBS=${1:-3}  # Default to 3 parallel jobs (can be passed as arg)

echo "═══════════════════════════════════════════════════════════════════"
echo "  SPXer 22-Day Backtest Suite (PARALLEL)"
echo "  Max parallel jobs: $MAX_JOBS"
echo "  Started: $(date)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Array of all trading dates (22 days)
dates=(
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

# Create output directory
mkdir -p replay-logs

# Track job count
job_count=0
completed=0
total=${#dates[@]}

# Function to run a replay and save output
run_replay() {
  local date=$1
  local logfile="replay-logs/$date.log"

  echo "▶ [$date] Starting..." > "$logfile"
  echo "---" >> "$logfile"

  npx tsx src/replay/cli.ts run "$date" >> "$logfile" 2>&1

  if [ $? -eq 0 ]; then
    echo "✅ [$date] COMPLETE" | tee -a "$logfile"
  else
    echo "❌ [$date] FAILED" | tee -a "$logfile"
  fi
}

# Run replays in parallel with job limiting
for date in "${dates[@]}"; do
  # Wait if we've hit max parallel jobs
  while [ $(jobs -r | wc -l) -ge $MAX_JOBS ]; do
    sleep 1
  done

  # Start replay in background
  echo "🚀 Starting $date..."
  run_replay "$date" &
  job_count=$((job_count + 1))
done

# Wait for all jobs to complete
echo ""
echo "Waiting for all ${#dates[@]} days to complete..."
wait

# Summary
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  BACKTEST SUITE COMPLETE"
echo "  Finished: $(date)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Extract summary from all logs
echo "📊 SUMMARY BY DAY:"
echo ""
for date in "${dates[@]}"; do
  logfile="replay-logs/$date.log"
  if [ -f "$logfile" ]; then
    if grep -q "SUMMARY:" "$logfile"; then
      trades=$(grep "Trades:" "$logfile" | tail -1 | awk '{print $2}')
      winrate=$(grep "Win rate:" "$logfile" | tail -1 | awk '{print $NF}')
      pnl=$(grep "Total P&L:" "$logfile" | tail -1 | awk '{print $NF}')
      echo "$date: Trades=$trades | Win Rate=$winrate | P&L=$pnl"
    else
      echo "$date: (incomplete or error - check replay-logs/$date.log)"
    fi
  fi
done

echo ""
echo "📁 Full logs: replay-logs/*.log"
