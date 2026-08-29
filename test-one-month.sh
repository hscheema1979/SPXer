#!/bin/bash
# NARROW TEST: May 2026 (one month only)
# Question: Does extreme call skew (4:1+) predict reversals?

set -e
cd /home/ubuntu/SPXer

echo "════════════════════════════════════════════════════"
echo "SKEW + GAMMA TEST: MAY 2026 (One Month)"
echo "════════════════════════════════════════════════════"
echo ""
echo "Hypothesis: Extreme call skew (4:1+) at afternoon peaks"
echo "            predicts SPX reversals by close."
echo ""
echo "Test: For each trading day in May, measure:"
echo "  1. Peak time (13:00+ ET) and ratio (call/put)"
echo "  2. SPX move from peak to close"
echo "  3. Put profit from peak to close"
echo ""

# May 2026 trading days (skip weekends, Memorial Day)
DATES=(
  "2026-05-01"
  "2026-05-04"
  "2026-05-05"
  "2026-05-06"
  "2026-05-07"
  "2026-05-08"
  "2026-05-11"
  "2026-05-12"
  "2026-05-13"
  "2026-05-14"
  "2026-05-15"
  "2026-05-18"
  "2026-05-19"
  "2026-05-20"
  "2026-05-21"
  "2026-05-22"
  "2026-05-26"
  "2026-05-27"
  "2026-05-28"
  "2026-05-29"
)

echo "📋 Running narrow test on ${#DATES[@]} trading days..."
echo ""

# Create temp results file
RESULTS_FILE="/tmp/may-skew-test-results.txt"
> "$RESULTS_FILE"

for DATE in "${DATES[@]}"; do
  PARQUET="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/$DATE.parquet"

  if [[ ! -f "$PARQUET" ]]; then
    echo "⚠️  $DATE - Parquet missing, skipping"
    continue
  fi

  echo -n "📊 $DATE ... "

  # Query: Find peak ratio + peak SPX + close SPX
  RESULT=$(duckdb << EOF 2>/dev/null
.mode csv

-- Find peak call/put ratio in afternoon (13:00+ ET)
-- and measure SPX move to close

WITH afternoon_data AS (
  SELECT
    ts,
    strftime(to_timestamp(ts), '%H:%M') as time,
    symbol,
    close,
    ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) as row_num,
    COUNT(*) OVER (PARTITION BY symbol) as total_rows
  FROM read_parquet('$PARQUET')
  WHERE timeframe = '1m' AND ts >= 1717939200  -- 13:00 ET reference (adjust per date)
),
afternoon_hourly AS (
  SELECT DISTINCT ON (symbol, strftime(to_timestamp(ts), '%H:00'))
    symbol,
    strftime(to_timestamp(ts), '%H:%M') as time,
    close as price
  FROM afternoon_data
  WHERE row_num <= total_rows
  ORDER BY symbol, strftime(to_timestamp(ts), '%H:00'), ts DESC
),
-- Get peak SPX and peak ratio
peak_info AS (
  SELECT
    MAX(CASE WHEN symbol = 'SPX' THEN price END) as peak_spx,
    MAX(CASE WHEN symbol LIKE 'SPXW%C07440000' THEN price END) as peak_call,
    MAX(CASE WHEN symbol LIKE 'SPXW%P07440000' THEN price END) as peak_put,
    LAST_VALUE(CASE WHEN symbol = 'SPX' THEN price END)
      OVER (PARTITION BY symbol ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close_spx
  FROM afternoon_data
),
close_data AS (
  SELECT
    LAST_VALUE(CASE WHEN symbol = 'SPX' THEN close END)
      OVER (ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close_spx,
    LAST_VALUE(CASE WHEN symbol LIKE 'SPXW%P07440000' THEN close END)
      OVER (ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) as close_put
  FROM (
    SELECT ts, symbol, close FROM (
      SELECT ts, symbol, close FROM read_parquet('$PARQUET')
      WHERE timeframe = '1m'
    )
  )
)
SELECT
  ROUND(COALESCE((SELECT peak_spx FROM peak_info), 0), 2) as peak_spx,
  ROUND(COALESCE((SELECT peak_call FROM peak_info), 0), 2) as peak_call,
  ROUND(COALESCE((SELECT peak_put FROM peak_info), 0), 2) as peak_put,
  ROUND(COALESCE((SELECT peak_call FROM peak_info), 0) / NULLIF(COALESCE((SELECT peak_put FROM peak_info), 0.01), 0), 1) as ratio,
  ROUND(COALESCE((SELECT close_spx FROM close_data LIMIT 1), 0), 2) as close_spx,
  ROUND(COALESCE((SELECT close_put FROM close_data LIMIT 1), 0), 2) as close_put;
EOF
  )

  if [[ -z "$RESULT" ]]; then
    echo "❌ No data"
    continue
  fi

  # Parse result
  peak_spx=$(echo "$RESULT" | cut -d',' -f1)
  peak_call=$(echo "$RESULT" | cut -d',' -f2)
  peak_put=$(echo "$RESULT" | cut -d',' -f3)
  ratio=$(echo "$RESULT" | cut -d',' -f4)
  close_spx=$(echo "$RESULT" | cut -d',' -f5)
  close_put=$(echo "$RESULT" | cut -d',' -f6)

  # Calculate move and put profit
  move=$(echo "$close_spx - $peak_spx" | bc 2>/dev/null || echo "0")
  put_profit=$(echo "scale=1; ($close_put - $peak_put) / $peak_put * 100" | bc 2>/dev/null || echo "0")

  # Determine if signal fires (ratio >= 4.0)
  signal=$(echo "$ratio >= 4.0" | bc 2>/dev/null || echo "0")

  # Determine if reversal happened (move < -20)
  reversal=$(echo "$move < -20" | bc 2>/dev/null || echo "0")

  # Record result
  printf "%s,%.1f,%.2f,%.2f,%.1f,%.2f,%.2f,%.1f\n" \
    "$DATE" "$ratio" "$peak_spx" "$close_spx" "$move" "$peak_put" "$close_put" "$put_profit" \
    >> "$RESULTS_FILE"

  # Print status
  if [[ $(echo "$ratio >= 4.0" | bc 2>/dev/null) -eq 1 ]]; then
    if [[ $(echo "$move < -20" | bc 2>/dev/null) -eq 1 ]]; then
      echo "✅ SIGNAL HIT: ratio=$ratio, move=${move}pts, put +$(printf "%.0f" $put_profit)%"
    else
      echo "⚠️  Signal fired but no reversal: ratio=$ratio, move=${move}pts"
    fi
  else
    echo "○ No signal: ratio=$ratio"
  fi
done

echo ""
echo "════════════════════════════════════════════════════"
echo "RESULTS SUMMARY"
echo "════════════════════════════════════════════════════"
echo ""

# Parse results
echo "Date,Ratio,Peak_SPX,Close_SPX,Move_pts,Peak_Put,Close_Put,Put_Profit_%" > /tmp/may-results.csv
cat "$RESULTS_FILE" >> /tmp/may-results.csv

# Statistics
echo "📊 May 2026 Statistics:"
echo ""

# Count signal fires (ratio >= 4.0)
signal_fires=$(awk -F',' '$2 >= 4.0 {count++} END {print count+0}' "$RESULTS_FILE")
total_days=$(wc -l < "$RESULTS_FILE")
echo "  Total trading days tested: $total_days"
echo "  Days with extreme skew (ratio ≥ 4.0): $signal_fires"
echo ""

if [[ $signal_fires -gt 0 ]]; then
  # For signal days, count reversals (move < -20)
  reversals=$(awk -F',' '$2 >= 4.0 && $5 < -20 {count++} END {print count+0}' "$RESULTS_FILE")
  win_rate=$(echo "scale=1; $reversals * 100 / $signal_fires" | bc)

  echo "  When signal fired (ratio ≥ 4.0):"
  echo "    - Reversals (move < -20 pts): $reversals"
  echo "    - Win rate: ${win_rate}%"
  echo ""

  # Average put profit on signal days
  avg_put_profit=$(awk -F',' '$2 >= 4.0 {sum+=$8; count++} END {if(count>0) printf "%.1f", sum/count; else print "0"}' "$RESULTS_FILE")
  echo "    - Avg put profit on signal days: ${avg_put_profit}%"
fi

echo ""
echo "📈 Detailed Results:"
echo ""
column -t -s',' /tmp/may-results.csv

echo ""
echo "════════════════════════════════════════════════════"
echo "VERDICT"
echo "════════════════════════════════════════════════════"
echo ""

if [[ $signal_fires -eq 0 ]]; then
  echo "❌ No extreme skew days in May 2026"
  echo "   (Ratio never reached 4.0+)"
  echo "   → Signal doesn't fire often enough"
elif [[ $(echo "$win_rate > 50" | bc 2>/dev/null) -eq 1 ]]; then
  echo "✅ SIGNAL WORKS: ${win_rate}% win rate on $signal_fires signal days"
  echo "   → Proceed to TEST QUARTER (July-Sept 2026)"
else
  echo "❌ SIGNAL FAILS: ${win_rate}% win rate"
  echo "   → Not profitable, abandon or revise"
fi

echo ""
echo "📁 Full results saved to: /tmp/may-results.csv"
echo ""
