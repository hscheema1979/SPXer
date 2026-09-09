#!/bin/bash
# NARROW TEST: July 2025, using ATM ±10 strikes
# For each day: peak C/P ratio at ATM → did SPX reverse?

set -e
cd /home/ubuntu/SPXer

echo "════════════════════════════════════════════════"
echo "NARROW TEST: July 2025 (One Month, ATM ±10)"
echo "════════════════════════════════════════════════"
echo ""
echo "Test: For each day in July 2025:"
echo "  1. Find SPX peak price"
echo "  2. Get ATM ±10 strike pair (call & put)"
echo "  3. Compute peak ratio"
echo "  4. Check if extreme skew (ratio 4:1+) predicted reversal"
echo ""

DATES=(
  "2025-07-01" "2025-07-02" "2025-07-03"
  "2025-07-07" "2025-07-08" "2025-07-09" "2025-07-10" "2025-07-11"
  "2025-07-14" "2025-07-15" "2025-07-16" "2025-07-17" "2025-07-18"
  "2025-07-21" "2025-07-22" "2025-07-23" "2025-07-24" "2025-07-25"
  "2025-07-28" "2025-07-29" "2025-07-30" "2025-07-31"
)

signal_hits=0
reversals=0

echo "Running test..."
echo ""

for DATE in "${DATES[@]}"; do
  PARQUET="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/$DATE.parquet"

  if [[ ! -f "$PARQUET" ]]; then
    continue
  fi

  # Query: Get SPX peak, find ATM+10/-10 strikes, compute peak C/P ratio
  RESULT=$(duckdb 2>&1 << EOFQ
-- Find peak SPX, then find nearest strikes at that peak
WITH spx_peak AS (
  SELECT
    MAX(close) as peak_price,
    (SELECT close FROM read_parquet('$PARQUET') WHERE symbol = 'SPX' AND timeframe = '1m' ORDER BY ts DESC LIMIT 1) as close_price
  FROM read_parquet('$PARQUET')
  WHERE symbol = 'SPX' AND timeframe = '1m'
),
-- Find the ATM+10 and ATM-10 strikes at peak
atm_strikes AS (
  SELECT
    p.peak_price,
    p.close_price,
    ROUND(p.peak_price / 5) * 5 as atm_strike,  -- Round to nearest 5
    (ROUND(p.peak_price / 5) * 5) + 10 as call_strike,  -- +10 for call
    (ROUND(p.peak_price / 5) * 5) - 10 as put_strike    -- -10 for put
  FROM spx_peak p
),
-- Get max call/put prices during the day at those strikes
contracts AS (
  SELECT
    ROUND(MAX(CASE WHEN symbol LIKE CONCAT('%C', LPAD(CAST(CAST(a.call_strike AS INT) * 1000 AS VARCHAR), 8, '0'), '%') THEN close END), 2) as peak_call,
    ROUND(MAX(CASE WHEN symbol LIKE CONCAT('%P', LPAD(CAST(CAST(a.put_strike AS INT) * 1000 AS VARCHAR), 8, '0'), '%') THEN close END), 2) as peak_put,
    a.peak_price,
    a.close_price
  FROM read_parquet('$PARQUET') b, atm_strikes a
  WHERE b.timeframe = '1m' AND (
    b.symbol LIKE CONCAT('%C', LPAD(CAST(CAST(a.call_strike AS INT) * 1000 AS VARCHAR), 8, '0'), '%') OR
    b.symbol LIKE CONCAT('%P', LPAD(CAST(CAST(a.put_strike AS INT) * 1000 AS VARCHAR), 8, '0'), '%')
  )
  GROUP BY a.peak_price, a.close_price
)
SELECT
  ROUND(peak_price, 0) as peak_spx,
  ROUND(close_price, 0) as close_spx,
  peak_call,
  peak_put,
  ROUND(peak_call / NULLIF(peak_put, 0), 2) as ratio
FROM contracts;
EOFQ
  )

  peak_spx=$(echo "$RESULT" | tail -1 | awk -F'|' '{print $2}' | xargs)
  close_spx=$(echo "$RESULT" | tail -1 | awk -F'|' '{print $3}' | xargs)
  peak_call=$(echo "$RESULT" | tail -1 | awk -F'|' '{print $4}' | xargs)
  peak_put=$(echo "$RESULT" | tail -1 | awk -F'|' '{print $5}' | xargs)
  ratio=$(echo "$RESULT" | tail -1 | awk -F'|' '{print $6}' | xargs)

  [[ -z "$peak_spx" ]] && continue

  spx_move=$(awk "BEGIN {printf \"%.1f\", $close_spx - $peak_spx}")

  # Check if signal fired
  if (( $(echo "$ratio >= 4.0" | bc -l 2>/dev/null) )); then
    ((signal_hits++))

    # Check if reversal happened (-20 or more)
    if (( $(echo "$spx_move < -20" | bc -l 2>/dev/null) )); then
      ((reversals++))
      echo "✅ $DATE: ratio=$ratio → move=${spx_move}pts (REVERSAL CONFIRMED)"
    else
      echo "⚠️  $DATE: ratio=$ratio → move=${spx_move}pts (signal but no big reversal)"
    fi
  else
    echo "○ $DATE: ratio=$ratio (no signal)"
  fi
done

echo ""
echo "════════════════════════════════════════════════"
echo "VERDICT: JULY 2025"
echo "════════════════════════════════════════════════"
echo ""
echo "Extreme skew days (ratio ≥ 4.0):  $signal_hits"
echo "Confirmed reversals:              $reversals / $signal_hits"

if [[ $signal_hits -gt 0 ]]; then
  wr=$(awk "BEGIN {printf \"%.0f\", ($reversals / $signal_hits) * 100}")
  echo "Win rate:                         ${wr}%"
  echo ""

  if [[ $wr -gt 50 ]]; then
    echo "✅ SIGNAL WORKS!"
    echo "   → Proceed to next month (August 2025)"
  else
    echo "❌ SIGNAL FAILS (<50%)"
    echo "   → Revise threshold or abandon"
  fi
else
  echo "❌ Signal never fired (0 extreme skew days)"
  echo "   → Test with lower threshold? (ratio ≥ 2.0)"
fi

echo ""
