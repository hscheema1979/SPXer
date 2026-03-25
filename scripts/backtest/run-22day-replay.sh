#!/bin/bash
echo "=== 22-DAY BACKTEST SUITE ===" 
echo "Started: $(date)"

for date in 2026-02-{20,23,24,25,26,27} 2026-03-{02,03,04,05,06,09,10,11,12,13,16,17,18,19,20}; do
  echo ""
  echo "=== Testing $date ==="
  npx tsx src/replay/cli.ts run "$date" 2>&1 | tail -20
  sleep 3
done

echo ""
echo "=== SUITE COMPLETE ==="
echo "Finished: $(date)"
