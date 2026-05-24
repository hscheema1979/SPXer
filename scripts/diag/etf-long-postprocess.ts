/**
 * etf-long-postprocess.ts — aggregate ETF long sweep results into daily/hourly P&L heatmaps.
 *
 * Reads all etf-long-sweep-{ticker}.json files, extracts per-trade details (entry/exit times,
 * P&L), and emits:
 *   - etf-long-daily.json: { dates: string[], series: { configId: { [date]: pnl } } }
 *   - etf-long-hourly.json: { hours: string[], series: { configId: { [hour]: pnl } } }
 *
 * Usage:
 *   npx tsx scripts/diag/etf-long-postprocess.ts [--symbol TQQQ] [--minTrades 10]
 */
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.resolve(process.cwd(), 'scripts/autoresearch/output');

function argVal(name: string): string | undefined {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : undefined;
}

// Load all etf-long-sweep-{ticker}.json files (or filter by --symbol)
function loadSweepFiles(): Map<string, any[]> {
  const result = new Map<string, any[]>();
  const filterSymbol = argVal('symbol')?.toUpperCase();

  const files = fs.readdirSync(OUT_DIR)
    .filter(f => f.startsWith('etf-long-sweep-') && f.endsWith('.json'))
    .sort();

  for (const file of files) {
    const match = file.match(/^etf-long-sweep-(.+)\.json$/);
    if (!match) continue;

    const ticker = match[1].toUpperCase();
    if (filterSymbol && ticker !== filterSymbol) continue;

    try {
      const path_ = path.join(OUT_DIR, file);
      const data = JSON.parse(fs.readFileSync(path_, 'utf8'));
      result.set(ticker, Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(`  Failed to load ${file}: ${e}`);
    }
  }

  return result;
}

// Group trade rows by config and aggregate by date/hour
interface TradeRow {
  configId: string;
  symbol: string;
  date?: string;
  entryTime?: string;
  exitTime?: string;
  entryDate?: string;
  pnl?: number;
  pnlPct?: number;
  n?: number;
}

interface DailyVariant {
  [date: string]: number;
}

interface HourlyVariant {
  [hour: string]: number;
}

function postprocess() {
  const minTrades = parseInt(argVal('minTrades') || '0', 10);
  const sweeps = loadSweepFiles();

  if (!sweeps.size) {
    console.error('  ✗ No etf-long-sweep-*.json files found');
    process.exit(1);
  }

  console.error(`  Loading ${sweeps.size} sweep files...`);

  // Aggregate by config across all tickers
  const dailyByConfig = new Map<string, DailyVariant>();
  const hourlyByConfig = new Map<string, HourlyVariant>();
  const allDates = new Set<string>();
  const allHours = new Set<string>();

  let totalTrades = 0;

  for (const [ticker, rows] of sweeps) {
    console.error(`    ${ticker}: ${rows.length} configs`);

    for (const row of rows) {
      const configId = row.configId || `${ticker}-${row.maType}-${row.tfClass}-${row.fast}x${row.slow}`;

      // Skip low-trade configs if filtering
      if (minTrades && (row.n || 0) < minTrades) continue;

      // Extract date from symbol or infer from entry date if available
      let tradeDate = row.entryDate || row.date;
      if (!tradeDate && row.configId) {
        // If no explicit date, trades are distributed across the backtest period
        // For heatmap purposes, we'll skip per-trade aggregation and only do config summary
        continue;
      }

      if (tradeDate) {
        allDates.add(tradeDate);

        if (!dailyByConfig.has(configId)) {
          dailyByConfig.set(configId, {});
        }
        const daily = dailyByConfig.get(configId)!;
        daily[tradeDate] = (daily[tradeDate] || 0) + (row.pnl || row.pnlPct || 0);

        // Extract hour from entryTime
        if (row.entryTime) {
          const [hh] = row.entryTime.split(':');
          const hour = `${hh}:00`;
          allHours.add(hour);

          if (!hourlyByConfig.has(configId)) {
            hourlyByConfig.set(configId, {});
          }
          const hourly = hourlyByConfig.get(configId)!;
          hourly[hour] = (hourly[hour] || 0) + (row.pnl || row.pnlPct || 0);
        }

        totalTrades++;
      }
    }
  }

  console.error(`  Aggregated ${totalTrades} trades across ${dailyByConfig.size} configs`);
  console.error(`  Date range: ${allDates.size} unique dates | Hour range: ${allHours.size} unique hours`);

  // Build output
  const dates = Array.from(allDates).sort();
  const hours = Array.from(allHours).sort();

  const dailySeries: Record<string, DailyVariant> = {};
  const hourlySeries: Record<string, HourlyVariant> = {};

  for (const [configId, daily] of dailyByConfig) {
    dailySeries[configId] = daily;
  }

  for (const [configId, hourly] of hourlyByConfig) {
    hourlySeries[configId] = hourly;
  }

  // Write outputs (following spreads schema)
  const dailyPath = path.join(OUT_DIR, 'etf-long-daily.json');
  const hourlyPath = path.join(OUT_DIR, 'etf-long-hourly.json');

  try {
    fs.writeFileSync(dailyPath, JSON.stringify({ dates, series: dailySeries }, null, 2));
    console.error(`  ✓ Wrote ${dates.length} dates × ${Object.keys(dailySeries).length} variants to etf-long-daily.json`);
  } catch (e) {
    console.error(`  ✗ Failed to write daily: ${e}`);
  }

  try {
    fs.writeFileSync(hourlyPath, JSON.stringify({ hours, series: hourlySeries }, null, 2));
    console.error(`  ✓ Wrote ${hours.length} hours × ${Object.keys(hourlySeries).length} variants to etf-long-hourly.json`);
  } catch (e) {
    console.error(`  ✗ Failed to write hourly: ${e}`);
  }
}

postprocess();
