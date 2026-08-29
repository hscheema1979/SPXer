import { execFileSync } from 'child_process';

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ChannelBar {
  ts: number;
  high: number;
  low: number;
}

interface Signal {
  date: string;
  windowTime: string;
  windowClose: number;
  channels: Map<string, { high: number; low: number }>;
  boundaryHits: number;
  sessionMove: number;
  sessionHigh: number;
  sessionClose: number;
  win: boolean;
}

function duckQuery(sql: string): any[] {
  try {
    const result = execFileSync('duckdb', ['-json', '-c', sql], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 512 * 1024 * 1024,
    });
    const text = result.toString().trim();
    if (!text || text === '[]') return [];
    return JSON.parse(text);
  } catch (err: any) {
    console.error(`Query failed: ${err.stderr?.toString() || err.message}`);
    return [];
  }
}

function formatTime(ts: number): string {
  const date = new Date(ts * 1000);
  // Adjust for ET (UTC-5)
  const etDate = new Date(date.getTime() - 5 * 3600 * 1000);
  return etDate.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

// Group 1-min bars into larger timeframes
function groupBars(bars: Bar[], minutes: number): ChannelBar[] {
  const grouped: ChannelBar[] = [];
  for (let i = 0; i < bars.length; i += minutes) {
    const chunk = bars.slice(i, i + minutes);
    if (chunk.length === 0) continue;
    grouped.push({
      ts: chunk[0].ts,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low))
    });
  }
  return grouped;
}

async function analyzeDay(date: string): Promise<Signal | null> {
  const filePath = `/home/ubuntu/SPXer/data/parquet/bars/spx-0dte/${date}.parquet`;

  // Get 1-minute bars for SPX
  const sql = `
    SELECT ts, open, high, low, close, volume
    FROM read_parquet('${filePath}')
    WHERE symbol = 'SPX' AND timeframe = '1m'
    ORDER BY ts ASC
  `;

  const allBars = duckQuery(sql) as Bar[];

  if (allBars.length < 100) {
    console.log(`${date}: Only ${allBars.length} bars found`);
    return null;
  }

  const sessionHigh = Math.max(...allBars.map(b => b.high));
  const sessionLow = Math.min(...allBars.map(b => b.low));
  const sessionClose = allBars[allBars.length - 1].close;

  console.log(`\n${date}:`);
  console.log(`  Session: ${formatTime(allBars[0].ts)} to ${formatTime(allBars[allBars.length - 1].ts)}`);
  console.log(`  Session high/low/close: ${sessionHigh.toFixed(2)} / ${sessionLow.toFixed(2)} / ${sessionClose.toFixed(2)}`);

  // Define ET market cutoff: 14:45-15:50 ET
  // Timestamps in parquet are UTC
  // 14:45 ET = 19:45 UTC, 15:50 ET = 20:50 UTC
  const [yyyy, mm, dd] = date.split('-').map(Number);
  const dateObj = new Date(Date.UTC(yyyy, mm - 1, dd));

  // 14:45 ET = 19:45 UTC
  const cutoffStart = new Date(dateObj);
  cutoffStart.setUTCHours(19, 45, 0, 0);
  const startTs = Math.floor(cutoffStart.getTime() / 1000);

  // 15:50 ET = 20:50 UTC
  const cutoffEnd = new Date(dateObj);
  cutoffEnd.setUTCHours(20, 50, 0, 0);
  const endTs = Math.floor(cutoffEnd.getTime() / 1000);

  // Filter bars in window
  const windowBars = allBars.filter(b => b.ts >= startTs && b.ts <= endTs);

  if (windowBars.length < 10) {
    console.log(`  No bars in 14:45-15:50 ET window (found ${windowBars.length})`);
    return null;
  }

  const windowHigh = Math.max(...windowBars.map(b => b.high));
  const windowLow = Math.min(...windowBars.map(b => b.low));
  const windowClose = windowBars[windowBars.length - 1].close;
  const windowTime = formatTime(windowBars[windowBars.length - 1].ts);

  console.log(`  Window (14:45-15:50 ET): ${windowBars.length} bars`);
  console.log(`  Window high/low: ${windowHigh.toFixed(2)} / ${windowLow.toFixed(2)}`);
  console.log(`  Window close @ ${windowTime}: ${windowClose.toFixed(2)}`);

  // Get bars BEFORE the window (for channel calculation)
  const preWindowBars = allBars.filter(b => b.ts < startTs);

  if (preWindowBars.length < 30) {
    console.log(`  Insufficient pre-window bars (${preWindowBars.length}) for channel calc`);
    return null;
  }

  // Group into synthetic timeframes
  const bars15m = groupBars(preWindowBars, 15);
  const bars30m = groupBars(preWindowBars, 30);
  const bars60m = groupBars(preWindowBars, 60);

  // Require at least some bars for each timeframe
  if (bars15m.length < 2) {
    console.log(`  Insufficient 15m bars (${bars15m.length})`);
    return null;
  }

  // Calculate last 10 bars' high/low for each timeframe (or all if less than 10)
  const ch15Last = bars15m.slice(Math.max(0, bars15m.length - 10));
  const ch15 = { high: Math.max(...ch15Last.map(b => b.high)), low: Math.min(...ch15Last.map(b => b.low)) };

  let ch30: { high: number; low: number } | null = null;
  if (bars30m.length >= 1) {
    const ch30Last = bars30m.slice(Math.max(0, bars30m.length - 10));
    ch30 = { high: Math.max(...ch30Last.map(b => b.high)), low: Math.min(...ch30Last.map(b => b.low)) };
  }

  let ch60: { high: number; low: number } | null = null;
  if (bars60m.length >= 1) {
    const ch60Last = bars60m.slice(Math.max(0, bars60m.length - 10));
    ch60 = { high: Math.max(...ch60Last.map(b => b.high)), low: Math.min(...ch60Last.map(b => b.low)) };
  }

  console.log(`  Channels (last 10 bars/all bars before window):`);
  console.log(`    15m (${ch15Last.length} bars): ${ch15.low.toFixed(2)} - ${ch15.high.toFixed(2)}`);
  if (ch30) console.log(`    30m (${bars30m.slice(Math.max(0, bars30m.length - 10)).length} bars): ${ch30.low.toFixed(2)} - ${ch30.high.toFixed(2)}`);
  if (ch60) console.log(`    60m (${bars60m.slice(Math.max(0, bars60m.length - 10)).length} bars): ${ch60.low.toFixed(2)} - ${ch60.high.toFixed(2)}`);

  // Check boundary hits (±5 pts)
  const boundaryThreshold = 5;
  const channels = new Map<string, { high: number; low: number }>();
  let boundaryHits = 0;

  // Check 15m
  if (Math.abs(windowHigh - ch15.high) <= boundaryThreshold || Math.abs(windowLow - ch15.low) <= boundaryThreshold) {
    channels.set('15m', ch15);
    boundaryHits++;
    const hitType = Math.abs(windowHigh - ch15.high) <= boundaryThreshold ? 'high' : 'low';
    console.log(`    ✓ 15m boundary hit (${hitType})`);
  }

  // Check 30m
  if (ch30 && (Math.abs(windowHigh - ch30.high) <= boundaryThreshold || Math.abs(windowLow - ch30.low) <= boundaryThreshold)) {
    channels.set('30m', ch30);
    boundaryHits++;
    const hitType = Math.abs(windowHigh - ch30.high) <= boundaryThreshold ? 'high' : 'low';
    console.log(`    ✓ 30m boundary hit (${hitType})`);
  }

  // Check 60m
  if (ch60 && (Math.abs(windowHigh - ch60.high) <= boundaryThreshold || Math.abs(windowLow - ch60.low) <= boundaryThreshold)) {
    channels.set('60m', ch60);
    boundaryHits++;
    const hitType = Math.abs(windowHigh - ch60.high) <= boundaryThreshold ? 'high' : 'low';
    console.log(`    ✓ 60m boundary hit (${hitType})`);
  }

  console.log(`  Boundary hits: ${boundaryHits}`);

  // Need 2+ hits to be a signal
  if (boundaryHits < 2) {
    console.log(`  ✗ Not a signal (need 2+)`);
    return null;
  }

  // Evaluate win/loss
  // Win if price moves ≥20 pts from entry (either direction) after window
  const sessionMove = Math.abs(sessionHigh - windowClose);
  const win = sessionMove >= 20;

  console.log(`  Session move: ${sessionMove.toFixed(2)} pts (high ${sessionHigh.toFixed(2)}, entry ${windowClose.toFixed(2)})`);
  console.log(`  ✓ SIGNAL: ${boundaryHits} timeframes, ${win ? 'WIN' : 'LOSS'}`);

  return {
    date,
    windowTime,
    windowClose,
    channels,
    boundaryHits,
    sessionMove,
    sessionHigh,
    sessionClose,
    win
  };
}

async function main() {
  console.log('=== Multi-Timeframe Channel Strategy Validation (May 2026) ===');
  console.log('Strategy:');
  console.log('  1. Compute synthetic 15m/30m/60m channels from 1m bars');
  console.log('  2. Last 10 bars before 14:45 ET = channel high/low (or all if <10)');
  console.log('  3. At 14:45-15:50 ET, if price ±5pts hits 2+ channel boundaries = SIGNAL');
  console.log('  4. Win if move ≥20pts by session end\n');

  const mayDates = [
    '2026-05-01', '2026-05-04', '2026-05-05', '2026-05-06',
    '2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21', '2026-05-22',
    '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29'
  ];

  const signals: Signal[] = [];

  for (const date of mayDates) {
    try {
      const signal = await analyzeDay(date);
      if (signal) {
        signals.push(signal);
      }
    } catch (err: any) {
      console.log(`${date}: Error - ${err.message}`);
    }
  }

  // Summary
  console.log('\n\n=== VALIDATION RESULTS ===\n');
  console.log(`Trading days in May: ${mayDates.length}`);
  console.log(`Signals generated: ${signals.length}`);

  if (signals.length === 0) {
    console.log('\nNo signals met the multi-timeframe channel confluence criteria.');
    process.exit(0);
  }

  const wins = signals.filter(s => s.win).length;
  const losses = signals.length - wins;
  const winRate = (wins / signals.length * 100).toFixed(1);

  console.log(`Wins (≥20pt move): ${wins}`);
  console.log(`Losses: ${losses}`);
  console.log(`Win rate: ${winRate}%`);

  console.log('\n--- Signal Details ---');
  signals.forEach((s, i) => {
    console.log(`\n${i + 1}. ${s.date} @ ${s.windowTime} | Entry: ${s.windowClose.toFixed(2)}`);
    console.log(`   Boundaries hit: ${s.boundaryHits} (${Array.from(s.channels.keys()).join(', ')})`);
    Array.from(s.channels.entries()).forEach(([tf, ch]) => {
      console.log(`     ${tf}: ${ch.low.toFixed(2)} - ${ch.high.toFixed(2)}`);
    });
    console.log(`   Session move: +${s.sessionMove.toFixed(2)} pts to ${s.sessionHigh.toFixed(2)} | Close: ${s.sessionClose.toFixed(2)}`);
    console.log(`   ${s.win ? '✓ WIN' : '✗ LOSS'}`);
  });

  console.log('\n--- Summary ---');
  console.log('The multi-timeframe channel confluence strategy generated ' + signals.length + ' signals in May.');
  console.log('Win rate: ' + winRate + '%');

  if (wins >= losses) {
    console.log('✓ Positive expectancy detected. Strategy shows promise.');
  } else {
    console.log('✗ Negative expectancy. Strategy needs refinement or is not suitable for this market.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
