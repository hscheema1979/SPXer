#!/bin/bash
# etf-long-post-sweep.sh — Automated post-sweep analysis
#
# Runs after the full 74-ticker sweep completes. Generates pairs analysis
# for major inverse-ETF hedging pairs.
#
# Usage:
#   bash scripts/diag/etf-long-post-sweep.sh
#   bash scripts/diag/etf-long-post-sweep.sh --no-pairs  (skip pairs analysis)
#   bash scripts/diag/etf-long-post-sweep.sh --minTrades 50 (filter to high-confidence pairs)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/scripts/autoresearch/output"

# Parse flags
NO_PAIRS=${NO_PAIRS:-false}
MIN_TRADES=${MIN_TRADES:-20}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pairs) NO_PAIRS=true; shift ;;
    --minTrades=*) MIN_TRADES="${1#*=}"; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "  ETF Long-Only Post-Sweep Analysis"
echo "═══════════════════════════════════════════════════════════════"

# Step 1: Verify all 74 tickers have sweep results
echo ""
echo "📊 Verifying sweep results..."
SWEEP_COUNT=$(ls -1 "$OUTPUT_DIR"/etf-long-sweep-*.json 2>/dev/null | wc -l)
echo "  Found $SWEEP_COUNT/74 sweep results"

if [ "$SWEEP_COUNT" -lt 70 ]; then
  echo "  ⚠️  Less than 70 tickers complete. Some pairs will be incomplete."
  echo "  Wait for remaining sweeps to finish."
fi

# Step 2: Verify daily/hourly files
echo ""
echo "📈 Checking heatmap files..."
DAILY_COUNT=$(ls -1 "$OUTPUT_DIR"/etf-long-daily-*.json 2>/dev/null | wc -l)
HOURLY_COUNT=$(ls -1 "$OUTPUT_DIR"/etf-long-hourly-*.json 2>/dev/null | wc -l)
echo "  Daily heatmaps: $DAILY_COUNT/74"
echo "  Hourly heatmaps: $HOURLY_COUNT/74"

if [ "$DAILY_COUNT" -lt "$SWEEP_COUNT" ] || [ "$HOURLY_COUNT" -lt "$SWEEP_COUNT" ]; then
  echo "  ⚠️  Running etf-long-postprocess to regenerate missing heatmaps..."
  cd "$PROJECT_ROOT"
  npx tsx "$SCRIPT_DIR/etf-long-postprocess.ts" 2>&1 | tail -20
fi

# Step 3: Pairs analysis (if enabled and both tickers exist)
if [ "$NO_PAIRS" != "true" ]; then
  echo ""
  echo "🔗 Generating inverse-pairs analysis..."

  # Define major pairs
  declare -a PAIRS=(
    "SOXL,SOXS"      # Semiconductor
    "TQQQ,SQQQ"      # Nasdaq-100
    "TNA,TZA"        # Russell 2000
    "UPRO,DPST"      # S&P 500
    "URTY,SRTY"      # Russell 2000 alt
    "NUGT,DUST"      # Gold miners
    "UGL,GLL"        # Gold
  )

  for PAIR in "${PAIRS[@]}"; do
    IFS=',' read -r T1 T2 <<< "$PAIR"
    T1_LOWER=$(echo "$T1" | tr '[:upper:]' '[:lower:]')
    T2_LOWER=$(echo "$T2" | tr '[:upper:]' '[:lower:]')

    if [ -f "$OUTPUT_DIR/etf-long-sweep-$T1_LOWER.json" ] && [ -f "$OUTPUT_DIR/etf-long-sweep-$T2_LOWER.json" ]; then
      echo "  • $PAIR..."
      cd "$PROJECT_ROOT"
      npx tsx "$SCRIPT_DIR/etf-long-pairs-study.ts" --pair "$PAIR" --minTrades "$MIN_TRADES" --top 10 2>&1 | grep -E "✓|✗|BEST"
    else
      echo "  ⊘ $PAIR (one or both tickers missing)"
    fi
  done
fi

# Step 4: Backtest-server refresh
echo ""
echo "🌐 Backtest-server endpoints ready:"
echo "  GET http://localhost:3700/api/etf-profiles"
echo "  GET http://localhost:3700/api/etf-long-all?by=ratio"
echo "  GET http://localhost:3700/api/etf-long-daily?profile=-soxl"
echo "  GET http://localhost:3700/api/etf-pairs?pair=SOXL-SOXS"

echo ""
echo "✅ Post-sweep analysis complete!"
echo ""
echo "Next steps:"
echo "  1. Check http://localhost:3700/api/etf-long-all for ticker leaderboard"
echo "  2. Wire daily/hourly heatmaps into spxer-studio dashboard"
echo "  3. Export top configs to OptionX format for paper trading"
