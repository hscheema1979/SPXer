import Database = require('better-sqlite3');
import type { OvernightData } from './market-narrative';

export interface PreSessionResult {
  overnight: OvernightData;
  narrative: string;
  preMarket: {
    impliedOpen: number;
    auctionRange: [number, number];
  };
  priorDayClose: number;
}

export async function runPreSessionAgent(dbPath: string): Promise<PreSessionResult> {
  const db = new Database(dbPath, { readonly: true });

  try {
    const today = new Date().toISOString().slice(0, 10);

    const esBars = db.prepare(`
      SELECT open, high, low, close, volume
      FROM bars
      WHERE symbol = 'ES'
        AND timeframe = '1m'
        AND ts >= ?
      ORDER BY ts
    `).all(getTodayStartTs()) as { open: number; high: number; low: number; close: number; volume: number }[];

    const spxYesterday = db.prepare(`
      SELECT close
      FROM bars
      WHERE symbol = 'SPX'
        AND timeframe = '1d'
      ORDER BY ts DESC
      LIMIT 1
    `).get() as { close: number } | undefined;

    const vix = await getVIX();

    const esFirstBar = esBars[0];
    const esLastBar = esBars[esBars.length - 1];

    // Handle empty ES bars — use yesterday's SPX close as fallback
    if (!esLastBar) {
      console.warn('[pre-session] No ES bars available — using previous day close');
      const spxClose = spxYesterday?.close ?? 0;
      const preMarket = await getPreMarketData(db, today);
      return {
        overnight: {
          esHigh: spxClose,
          esLow: spxClose,
          esClose: spxClose,
          esChange: 0,
          esRange: 0,
          character: 'choppy',
          vix: vix ?? 0,
          skew: 0.02,
          keyLevels: { support: [spxClose - 25, spxClose - 50], resistance: [spxClose + 25, spxClose + 50] },
        },
        narrative: 'No ES overnight data available — using prior day close.',
        preMarket: {
          impliedOpen: preMarket.impliedOpen,
          auctionRange: preMarket.auctionRange,
        },
        priorDayClose: spxClose,
      };
    }

    const spxClose = spxYesterday?.close ?? esLastBar.close;

    const esChange = esLastBar.close - spxClose;
    const esHigh = Math.max(...esBars.map(b => b.high));
    const esLow = Math.min(...esBars.map(b => b.low));
    const esRange = esHigh - esLow;

    const character = analyzeCharacter(esBars);
    const keyLevels = deriveKeyLevels(esLow, esHigh);
    const preMarket = await getPreMarketData(db, today);

    const overnight: OvernightData = {
      esHigh,
      esLow,
      esClose: esLastBar.close,
      esChange,
      esRange,
      character,
      vix,
      skew: 0.02, // placeholder — would come from options data
      keyLevels,
    };

    const narrative = formatOvernightNarrative(overnight, preMarket);

    return {
      overnight,
      narrative,
      preMarket: {
        impliedOpen: preMarket.impliedOpen,
        auctionRange: preMarket.auctionRange,
      },
      priorDayClose: spxClose,
    };
  } finally {
    db.close();
  }
}

function getTodayStartTs(): number {
  const today = new Date();
  const start = new Date(today);
  start.setHours(18, 0, 0, 0);
  if (today.getHours() < 18) {
    start.setDate(start.getDate() - 1);
  }
  return Math.floor(start.getTime() / 1000);
}

function analyzeCharacter(bars: { high: number; low: number; close: number }[]): OvernightData['character'] {
  if (bars.length < 10) return 'volatile';

  const firstClose = bars[0].close;
  const lastClose = bars[bars.length - 1].close;
  const netMove = lastClose - firstClose;

  let totalRange = 0;
  for (let i = 1; i < bars.length; i++) {
    totalRange += bars[i].high - bars[i].low;
  }
  const avgRange = totalRange / bars.length;
  const rangePercent = avgRange / firstClose;

  if (netMove > 5) {
    return rangePercent > 0.01 ? 'volatile' : 'trend';
  } else if (netMove < -5) {
    return rangePercent > 0.01 ? 'volatile' : 'trend';
  } else {
    return 'choppy';
  }
}

function deriveKeyLevels(
  esLow: number,
  esHigh: number,
): OvernightData['keyLevels'] {
  const roundLevels = [6500, 6525, 6550, 6575, 6600, 6625, 6650];

  const support: number[] = [];
  const resistance: number[] = [];

  for (const level of roundLevels) {
    if (level < esLow) support.push(level);
    if (level > esHigh) resistance.push(level);
  }

  if (support.length === 0) {
    support.push(Math.floor(esLow / 25) * 25);
    support.push(Math.floor(esLow / 25) * 25 - 25);
  }
  if (resistance.length === 0) {
    resistance.push(Math.ceil(esHigh / 25) * 25);
    resistance.push(Math.ceil(esHigh / 25) * 25 + 25);
  }

  return {
    support: support.slice(0, 3),
    resistance: resistance.slice(0, 3),
  };
}

async function getVIX(): Promise<number> {
  return 18.5;
}

async function getPreMarketData(
  db: Database.Database,
  today: string
): Promise<{ impliedOpen: number; auctionRange: [number, number] }> {
  const startTs = Math.floor(new Date(`${today}T09:25:00-04:00`).getTime() / 1000);
  const endTs = startTs + 5 * 60;

  const preMktBars = db.prepare(`
    SELECT close
    FROM bars
    WHERE symbol = 'SPX'
      AND timeframe = '1m'
      AND ts >= ?
      AND ts <= ?
    ORDER BY ts
  `).all(startTs, endTs) as { close: number }[];

  // Get yesterday's close as reference
  const yesterdayClose = db.prepare(`
    SELECT close
    FROM bars
    WHERE symbol = 'SPX'
      AND timeframe = '1d'
    ORDER BY ts DESC
    LIMIT 1
  `).get() as { close: number } | undefined;

  const close = yesterdayClose?.close ?? 6560;
  const lastPreMkt = preMktBars[preMktBars.length - 1]?.close ?? close;

  const impliedOpen = lastPreMkt;
  const auctionRange: [number, number] = [
    Math.round((impliedOpen - 20) / 5) * 5,
    Math.round((impliedOpen + 20) / 5) * 5,
  ];

  return { impliedOpen, auctionRange };
}

function formatOvernightNarrative(overnight: OvernightData, preMarket: { impliedOpen: number; auctionRange: [number, number] }): string {
  const lines: string[] = [];

  lines.push(`ES ranged ${overnight.esLow.toFixed(2)}-${overnight.esHigh.toFixed(2)} (+${overnight.esRange.toFixed(1)} pts)`);
  lines.push(`ES ${overnight.esChange >= 0 ? '+' : ''}${overnight.esChange.toFixed(2)} from 4PM close`);
  lines.push(`Character: ${overnight.character}`);
  lines.push(`VIX: ${overnight.vix.toFixed(1)} ${overnight.vix > 20 ? '(elevated)' : '(normal)'}`);
  lines.push(`Skew: ${(overnight.skew * 100).toFixed(1)}%`);
  lines.push(`Support: ${overnight.keyLevels.support.join('/')}`);
  lines.push(`Resistance: ${overnight.keyLevels.resistance.join('/')}`);

  return lines.join(' | ');
}
