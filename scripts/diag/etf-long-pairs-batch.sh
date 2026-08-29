#!/bin/bash
# etf-long-pairs-batch.sh — Run all major inverse-pair analyses in sequence
#
# Usage:
#   bash scripts/diag/etf-long-pairs-batch.sh [--minTrades 20] [--top 10]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Parse flags
MIN_TRADES=${MIN_TRADES:-20}
TOP_N=${TOP_N:-10}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --minTrades=*) MIN_TRADES="${1#*=}"; shift ;;
    --top=*) TOP_N="${1#*=}"; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "  Running ETF Inverse-Pairs Analysis (minTrades=$MIN_TRADES, top=$TOP_N)"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Core pairs: must-run
declare -a CORE_PAIRS=(
  "SOXL,SOXS"      # Semiconductor
  "TQQQ,SQQQ"      # Nasdaq-100
  "TNA,TZA"        # Russell 2000
)

# Secondary pairs: worth checking
declare -a SECONDARY_PAIRS=(
  "UPRO,DPST"      # S&P 500
  "URTY,SRTY"      # Russell 2000 alt
  "NUGT,DUST"      # Gold miners
  "UGL,GLL"        # Gold
)

OUTPUT_DIR="$PROJECT_ROOT/scripts/autoresearch/output"
t0=$(date +%s)

run_pair() {
  local PAIR="$1"
  IFS=',' read -r T1 T2 <<< "$PAIR"
  T1_LOWER=$(echo "$T1" | tr '[:upper:]' '[:lower:]')
  T2_LOWER=$(echo "$T2" | tr '[:upper:]' '[:lower:]')

  if [ ! -f "$OUTPUT_DIR/etf-long-sweep-$T1_LOWER.json" ]; then
    echo "  ⊘ $PAIR — $T1 sweep missing"
    return 1
  fi
  if [ ! -f "$OUTPUT_DIR/etf-long-sweep-$T2_LOWER.json" ]; then
    echo "  ⊘ $PAIR — $T2 sweep missing"
    return 1
  fi

  echo "  ► $PAIR..."
  cd "$PROJECT_ROOT"
  npx tsx "scripts/diag/etf-long-pairs-study.ts" --pair "$PAIR" --minTrades "$MIN_TRADES" --top "$TOP_N" 2>&1 | \
    grep -E "✓|✗|BEST" | sed 's/^/    /'
}

echo "🔗 CORE PAIRS:"
for PAIR in "${CORE_PAIRS[@]}"; do
  run_pair "$PAIR" || true
done

echo ""
echo "🔗 SECONDARY PAIRS:"
for PAIR in "${SECONDARY_PAIRS[@]}"; do
  run_pair "$PAIR" || true
done

t1=$(date +%s)
elapsed=$((t1 - t0))

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Pairs analysis complete (${elapsed}s)"
echo ""
echo "  Results written to:"
ls -lh "$OUTPUT_DIR"/etf-long-pairs-*.json 2>/dev/null | awk '{print "    " $9 " (" $5 ")"}'
echo ""
echo "  Query results:"
echo "    curl 'http://localhost:3700/api/etf-pairs?pair=SOXL-SOXS' | jq ."
echo "═══════════════════════════════════════════════════════════════"
