#!/bin/bash
# SIMPLE NARROW TEST: May 2026
# For each day: peak C/P ratio → did SPX reverse?

cd /home/ubuntu/SPXer

echo "════════════════════════════════════════════════"
echo "NARROW TEST: May 2026 (One Month, Simple)"
echo "════════════════════════════════════════════════"
echo ""

# May 2026 trading days
DATES=(
  "2026-05-01"
  "2026-05-04" "2026-05-05" "2026-05-06" "2026-05-07" "2026-05-08"
  "2026-05-11" "2026-05-12" "2026-05-13" "2026-05-14" "2026-05-15"
  "2026-05-18" "2026-05-19" "2026-05-20" "2026-05-21" "2026-05-22"
  "2026-05-26" "2026-05-27" "2026-05-28" "2026-05-29"
)

RESULTS_FILE="/tmp/may-test.csv"
echo "Date,Peak_SPX,Peak_7440C,Peak_7440P,C_P_Ratio,Close_SPX,Close_7440P,SPX_Move,Put_Profit_Pct" > "$RESULTS_FILE"

echo "Testing ${#DATES[@]} days from May 2026..."
echo ""

for DATE in "${DATES[@]}"; do
  PARQUET="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/$DATE.parquet"

  if [[ ! -f "$PARQUET" ]]; then
    echo "⚠️  $DATE - Missing"
    continue
  fi

  # Simple query: get max SPX + max C/P ratio + close values
  OUTPUT=$(duckdb << EOF 2>&1
SELECT
  ROUND(MAX(CASE WHEN symbol = 'SPX' THEN close END), 2) as peak_spx,
  ROUND(MAX(CASE WHEN symbol LIKE '%C07440000' THEN close END), 2) as peak_call,
  ROUND(MAX(CASE WHEN symbol LIKE '%P07440000' THEN close END), 2) as peak_put,
  (SELECT close FROM read_parquet('$PARQUET') WHERE symbol = 'SPX' AND timeframe = '1m' ORDER BY ts DESC LIMIT 1) as close_spx,
  (SELECT close FROM read_parquet('$PARQUET') WHERE symbol LIKE '%P07440000' AND timeframe = '1m' ORDER BY ts DESC LIMIT 1) as close_put
FROM read_parquet('$PARQUET')
WHERE symbol IN ('SPX', 'SPXW%C07440000', 'SPXW%P07440000') AND timeframe = '1m' AND ts >= 1717939200;
EOF
  )

  # Parse results
  peak_spx=$(echo "$OUTPUT" | grep -oP '(?<=\|)[^|]*' | head -1 | xargs)
  peak_call=$(echo "$OUTPUT" | grep -oP '(?<=\|)[^|]*' | sed -n '2p' | xargs)
  peak_put=$(echo "$OUTPUT" | grep -oP '(?<=\|)[^|]*' | sed -n '3p' | xargs)
  close_spx=$(echo "$OUTPUT" | grep -oP '(?<=\|)[^|]*' | sed -n '4p' | xargs)
  close_put=$(echo "$OUTPUT" | grep -oP '(?<=\|)[^|]*' | sed -n '5p' | xargs)

  if [[ -z "$peak_spx" ]]; then
    echo "⚠️  $DATE - No data"
    continue
  fi

  # Compute metrics
  ratio=$(awk "BEGIN {if($peak_put > 0) printf \"%.2f\", $peak_call / $peak_put; else print \"N/A\"}")
  spx_move=$(awk "BEGIN {printf \"%.2f\", $close_spx - $peak_spx}")

  if [[ ! "$peak_put" =~ ^[0-9] ]] || [[ "$peak_put" == "NULL" ]] || [[ -z "$peak_put" ]]; then
    put_profit="N/A"
  else
    put_profit=$(awk "BEGIN {if($peak_put > 0) printf \"%.1f\", ($close_put - $peak_put) / $peak_put * 100; else print \"N/A\"}")
  fi

  # Log result
  printf "%s,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%s\n" \
    "$DATE" "$peak_spx" "$peak_call" "$peak_put" "$ratio" "$close_spx" "$close_put" "$spx_move" "$put_profit" \
    >> "$RESULTS_FILE"

  # Print status
  if (( $(echo "$ratio >= 4.0" | bc -l 2>/dev/null) )); then
    if (( $(echo "$spx_move < -20" | bc -l 2>/dev/null) )); then
      echo "✅ $DATE: ratio=$ratio → move=${spx_move}pts, put +${put_profit}%"
    else
      echo "⚠️  $DATE: ratio=$ratio (signal) but move=${spx_move}pts (no reversal)"
    fi
  else
    echo "○ $DATE: ratio=$ratio (no signal)"
  fi
done

echo ""
echo "════════════════════════════════════════════════"
echo "RESULTS"
echo "════════════════════════════════════════════════"
echo ""

cat "$RESULTS_FILE" | column -t -s','

echo ""
echo "📊 Summary:"
grep -E "^2026" "$RESULTS_FILE" | awk -F',' '
BEGIN {
  print "\nExtremes call skew days (ratio >= 4.0):"
}
$4 >= 4.0 {
  count++
  printf "  %s: ratio=%.2f, move=%.1f pts, put_profit=%s\n", $1, $4, $8, $9
  if ($8 < -20) reversals++
}
END {
  if (count > 0) {
    wr = (reversals / count) * 100
    printf "\n  Total signal days: %d\n  Reversals: %d\n  Win rate: %.0f%%\n", count, reversals, wr
    if (wr > 50) print "  ✅ SIGNAL WORKS!"
    else print "  ❌ SIGNAL FAILS"
  } else {
    print "  No extreme skew days in May"
  }
}
'

echo ""
echo "📁 Full data: $RESULTS_FILE"
echo ""
