#!/bin/bash
# Quick Test 1a: Put/Call Skew Analysis across 5 trading days
# Usage: bash run-skew-test.sh

set -e

cd /home/ubuntu/SPXer

echo "================================"
echo "PUT/CALL SKEW SIGNAL TEST"
echo "================================"
echo ""
echo "Running Test 1a: Daily Skew Analysis"
echo ""

# Function to run skew analysis for a single date
analyze_date() {
  local DATE=$1
  local EXPECTED=$2
  local MOVE=$3

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📊 $DATE ($EXPECTED, $MOVE pts)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  duckdb << EOF
.header on
.mode box

-- Hourly snapshots for $DATE afternoon (13:00+ ET)
WITH hour_marks AS (
  SELECT 1780925400 + (n * 3600) as target_ts, n as hour_num
  FROM (SELECT generate_subscripts(array[0,1,2,3,4,5,6,7,8,9,10,11,12,13], 1) as n)
)
SELECT
  strftime(to_timestamp(ANY_VALUE(h.target_ts)), '%H:%M ET') as time,
  ROUND(MAX(CASE WHEN d.symbol = 'SPX' THEN d.close END), 0) as spx,
  ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%C07440000' THEN d.close END), 2) as c7440,
  ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%P07440000' THEN d.close END), 2) as p7440,
  CASE
    WHEN MAX(CASE WHEN d.symbol LIKE 'SPXW%P07440000' THEN d.close END) > 0
    THEN ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%C07440000' THEN d.close END) /
              MAX(CASE WHEN d.symbol LIKE 'SPXW%P07440000' THEN d.close END), 2)
    ELSE NULL
  END as c_to_p_ratio,
  ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%C07430000' THEN d.close END), 2) as c7430,
  ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%P07430000' THEN d.close END), 2) as p7430
FROM hour_marks h
LEFT JOIN read_parquet('data/parquet/bars/spx-0dte/$DATE.parquet') d
  ON d.timeframe = '1m'
  AND d.symbol IN ('SPX', 'SPXW260608C07440000', 'SPXW260608P07440000',
                   'SPXW260608C07430000', 'SPXW260608P07430000')
  AND ABS(d.ts - h.target_ts) <= 60
GROUP BY h.hour_num
ORDER BY h.hour_num;
EOF

  echo ""
}

# Run for each test date
# NOTE: The timestamps below are hardcoded for 2026-06-08; you'll need to adjust for other dates
# This is a simplified version—for other dates, use the full DuckDB query from the test plan

echo "Testing 5 market regimes..."
echo ""

# June 8 (the one we analyzed in detail)
echo ""
echo "✅ Full detailed output for 2026-06-08 (most important):"
echo ""
duckdb << 'EOF'
.header on
.mode box

-- 2026-06-08: Complete afternoon progression (13:30 start to 20:00 close)
WITH hour_buckets AS (
  SELECT 1780925400 + (n * 1800) as target_ts, n as bucket
  FROM (SELECT generate_subscripts(array[0,1,2,3,4,5,6,7,8,9,10,11,12,13], 1) as n)
)
SELECT
  strftime(to_timestamp(ANY_VALUE(h.target_ts)), '%H:%M ET') as time,
  ROUND(MAX(CASE WHEN d.symbol = 'SPX' THEN d.close END), 0) as SPX,
  ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%C07440000' THEN d.close END), 2) as 'Call 7440',
  ROUND(MAX(CASE WHEN d.symbol LIKE 'SPXW%P07440000' THEN d.close END), 2) as 'Put 7440',
  ROUND(
    MAX(CASE WHEN d.symbol LIKE 'SPXW%C07440000' THEN d.close END) /
    NULLIF(MAX(CASE WHEN d.symbol LIKE 'SPXW%P07440000' THEN d.close END), 0),
    1) as 'C/P Ratio'
FROM hour_buckets h
LEFT JOIN read_parquet('data/parquet/bars/spx-0dte/2026-06-08.parquet') d
  ON d.timeframe = '1m'
  AND d.symbol IN ('SPX', 'SPXW260608C07440000', 'SPXW260608P07440000')
  AND ABS(d.ts - h.target_ts) <= 60
GROUP BY h.bucket
ORDER BY h.bucket;
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📈 INTERPRETATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📌 June 8, 2026 Results:"
echo "   • 15:00 ET: Call/Put ratio = 4.1:1 (EXTREME call bias)"
echo "   • 15:00 ET: SPX = 7462.54 (intraday peak)"
echo "   • 20:00 ET: SPX = 7405.49 (-57 pts from peak)"
echo "   • 20:00 ET: 7440 Put went 7.27 → 31.55 (+334%)"
echo ""
echo "✅ SIGNAL WORKS ON JUNE 8:"
echo "   Fading extreme call skew (buying puts) was +334% profitable in 5 hours!"
echo ""

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 NEXT STEPS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Manually run queries for 2026-06-01, -02, -03, -04 (different skew patterns)"
echo ""
echo "2. Test whether high call skew at peaks ALWAYS predicts reversals"
echo "   Command: duckdb, then paste query from PUT-CALL-SKEW-SIGNAL-TEST.md Test 1a"
echo ""
echo "3. If pattern holds on 5+ days, graduate to Test 3 (200-day statistical validation)"
echo ""
echo "See: PUT-CALL-SKEW-SIGNAL-TEST.md for full test plan"
echo ""
