#!/usr/bin/env python3
"""
NARROW TEST: July 2025 - One month validation
Test: Does extreme call skew (4:1+) predict reversals?
"""

import duckdb
import glob
import os

os.chdir('/home/ubuntu/SPXer')

print("════════════════════════════════════════════════")
print("NARROW TEST: July 2025 (One Month)")
print("════════════════════════════════════════════════")
print("")

# Get all July 2025 parquet files
july_files = sorted(glob.glob('data/parquet/bars/spx-0dte/2025-07-*.parquet'))

print(f"Found {len(july_files)} July 2025 days\n")

results = []
signal_count = 0
reversal_count = 0

for parquet_path in july_files:
    date = os.path.basename(parquet_path).replace('.parquet', '')

    try:
        # Query to get peak SPX, close SPX, and peak call/put ratio
        query = f"""
        WITH spx_data AS (
          SELECT
            MAX(close) as peak_spx,
            (SELECT close FROM read_parquet('{parquet_path}') WHERE symbol = 'SPX' ORDER BY ts DESC LIMIT 1) as close_spx
          FROM read_parquet('{parquet_path}')
          WHERE symbol = 'SPX' AND timeframe = '1m'
        ),
        contracts AS (
          SELECT
            (SELECT peak_spx FROM spx_data LIMIT 1) as peak_spx,
            (SELECT close_spx FROM spx_data LIMIT 1) as close_spx,
            COUNT(DISTINCT symbol) as contract_count
          FROM read_parquet('{parquet_path}')
          WHERE timeframe = '1m' AND symbol LIKE 'SPXW%'
        )
        SELECT peak_spx, close_spx, contract_count FROM contracts LIMIT 1;
        """

        conn = duckdb.connect(':memory:')
        result = conn.execute(query).fetchall()

        if not result or not result[0]:
            print(f"⚠️  {date} - No data")
            continue

        peak_spx, close_spx, contract_count = result[0]

        if peak_spx is None or close_spx is None:
            print(f"⚠️  {date} - Missing SPX data")
            continue

        # Now find ATM strike (round to nearest 5)
        atm_strike = round(peak_spx / 5) * 5
        call_strike = int(atm_strike) * 1000
        put_strike = int(atm_strike) * 1000

        # Query for call/put prices at that strike
        option_query = f"""
        SELECT
          ROUND(MAX(CASE WHEN symbol LIKE 'SPXW%C%{str(call_strike).zfill(8)}' THEN close END), 2) as peak_call,
          ROUND(MAX(CASE WHEN symbol LIKE 'SPXW%P%{str(put_strike).zfill(8)}' THEN close END), 2) as peak_put
        FROM read_parquet('{parquet_path}')
        WHERE timeframe = '1m';
        """

        conn2 = duckdb.connect(':memory:')
        opt_result = conn2.execute(option_query).fetchall()

        if opt_result and opt_result[0]:
            peak_call, peak_put = opt_result[0]

            if peak_call and peak_put and peak_put > 0:
                ratio = peak_call / peak_put
                spx_move = close_spx - peak_spx

                # Check if signal fired
                signal = ratio >= 4.0
                reversal = spx_move < -20

                results.append({
                    'date': date,
                    'peak_spx': peak_spx,
                    'close_spx': close_spx,
                    'peak_call': peak_call,
                    'peak_put': peak_put,
                    'ratio': ratio,
                    'spx_move': spx_move,
                    'signal': signal,
                    'reversal': reversal
                })

                if signal:
                    signal_count += 1
                    if reversal:
                        reversal_count += 1
                        status = "✅✅"
                    else:
                        status = "✅"
                else:
                    status = "○"

                print(f"{status} {date}: SPX {peak_spx:.0f}→{close_spx:.0f} ({spx_move:+.0f}pts), ratio={ratio:.2f}")
            else:
                print(f"⚠️  {date} - Invalid option prices")
        else:
            print(f"⚠️  {date} - No option data")

    except Exception as e:
        print(f"❌ {date} - Error: {str(e)[:50]}")
        continue

print("\n════════════════════════════════════════════════")
print("RESULTS")
print("════════════════════════════════════════════════\n")

if results:
    print(f"{'Date':<12} {'Peak SPX':<10} {'Close SPX':<10} {'Ratio':<8} {'Move':<8} {'Result':<10}")
    print("-" * 60)
    for r in results:
        result_str = "REVERSAL" if (r['signal'] and r['reversal']) else ("SIGNAL" if r['signal'] else "None")
        print(f"{r['date']:<12} {r['peak_spx']:<10.0f} {r['close_spx']:<10.0f} {r['ratio']:<8.2f} {r['spx_move']:<8.1f} {result_str:<10}")

print(f"\nVERDICT")
print("-------")
print(f"Days tested:                     {len(results)}")
print(f"Extreme skew days (ratio ≥ 4.0): {signal_count}")
print(f"Confirmed reversals:             {reversal_count}/{signal_count}")

if signal_count > 0:
    wr = (reversal_count / signal_count) * 100
    print(f"Win rate:                        {wr:.0f}%\n")

    if wr > 50:
        print("✅ SIGNAL WORKS!")
        print("   → Proceed to test August 2025")
    else:
        print("❌ SIGNAL FAILS (<50% win rate)")
        print("   → Revise or abandon signal")
else:
    print(f"\n❌ Signal never fired in July")
    print("   → Try lower threshold (ratio ≥ 2.0)?")

print("")
