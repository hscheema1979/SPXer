#!/usr/bin/env npx tsx
/**
 * Generate monthly contract reports from parquet data.
 * Usage: npx tsx scripts/diag/monthly-gen.ts --date 2026-06-01
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

const args = parseArgs({
  options: {
    date: { type: 'string' },
  },
});

const date = args.values.date as string;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Error: --date YYYY-MM-DD required');
  process.exit(1);
}

// DuckDB query helper
function duckQuery(sql: string): any[] {
  const { execFileSync } = require('child_process') as typeof import('child_process');
  try {
    const result = execFileSync('duckdb', ['-json', '-c', sql], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const text = result.toString().trim();
    if (!text || text === '[]') return [];
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function generateReport(targetDate: string) {
  const parquetRoot = path.resolve(process.cwd(), 'data/parquet/bars');

  // Query SPX bars to get open price
  const spxBarPath = path.join(parquetRoot, 'spx-0dte', `${targetDate}.parquet`);
  if (!fs.existsSync(spxBarPath)) {
    console.error(`No parquet data for ${targetDate}`);
    process.exit(1);
  }

  const dayStart = Math.floor(new Date(targetDate + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400;

  // Get SPX bars to find market open
  const spxBars = duckQuery(`
    SELECT ts, open, high, low, close, volume
    FROM read_parquet('${spxBarPath}')
    WHERE symbol = 'SPX' AND ts >= ${dayStart} AND ts <= ${dayEnd}
    ORDER BY ts ASC
    LIMIT 1000
  `);

  if (spxBars.length === 0) {
    console.error(`No bars found for ${targetDate}`);
    process.exit(1);
  }

  const spxOpen = spxBars[0].open;
  const atmStrike = Math.round(spxOpen / 5) * 5;

  // Get ET offset (calculate as -4 or -5 depending on DST)
  // June is always EDT (UTC-4)
  const etOffsetSec = -4 * 3600;

  // Get all contracts for this date
  const contracts = duckQuery(`
    SELECT DISTINCT symbol,
           CASE WHEN symbol LIKE '%C%' THEN 'call' ELSE 'put' END as type,
           CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike
    FROM read_parquet('${spxBarPath}')
    WHERE symbol LIKE 'SPXW%' AND ts >= ${dayStart} AND ts <= ${dayEnd}
    ORDER BY strike ASC
  `);

  // For each contract, get the bars
  const contractData = [];
  for (const contract of contracts) {
    const bars = duckQuery(`
      SELECT ts, open, high, low, close, volume
      FROM read_parquet('${spxBarPath}')
      WHERE symbol = '${contract.symbol}' AND ts >= ${dayStart} AND ts <= ${dayEnd}
      ORDER BY ts ASC
    `);

    if (bars.length === 0) continue;

    const offset = Math.round((contract.strike - atmStrike) / 5) * 5;
    contractData.push({
      symbol: contract.symbol,
      type: contract.type,
      strike: contract.strike,
      offset,
      bars: bars.map(b => [b.ts, b.open, b.high, b.low, b.close, b.volume]),
    });
  }

  const report = {
    date: targetDate,
    spxOpen,
    atmStrike,
    etOffset: etOffsetSec,
    contracts: contractData,
  };

  // Write report file
  const reportsDir = path.resolve(process.cwd(), 'data/reports/monthly');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const reportPath = path.join(reportsDir, `${targetDate}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report));

  // Update manifest
  const manifestPath = path.join(reportsDir, 'manifest.json');
  let manifest: any[] = [];
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  // Remove existing entry for this date
  manifest = manifest.filter(e => e.date !== targetDate);

  // Add new entry
  manifest.push({
    date: targetDate,
    spxOpen,
    atmStrike,
    contractCount: contractData.length,
  });

  // Sort by date
  manifest.sort((a, b) => a.date.localeCompare(b.date));

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Generated report for ${targetDate}: ${contractData.length} contracts`);
}

generateReport(date).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
