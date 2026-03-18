import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { getExpiredContracts, deleteBarsBySymbols } from './queries';
import { config } from '../config';

const MAX_RETRIES = 3;

export async function archiveExpired(): Promise<void> {
  const expired = getExpiredContracts();
  if (expired.length === 0) return;

  const symbols = expired.map(c => c.symbol);
  const date = new Date().toISOString().split('T')[0];
  const tmpPath = `/tmp/spxer_archive_${date}.parquet`;

  console.log(`[archiver] Archiving ${symbols.length} expired contracts...`);

  try {
    await exportToParquet(symbols, tmpPath);
    await uploadWithRetry(tmpPath, date, MAX_RETRIES);
    deleteBarsBySymbols(symbols);
    console.log(`[archiver] Archived and evicted ${symbols.length} contracts`);
  } catch (e) {
    console.error('[archiver] Failed — parquet left in /tmp for manual recovery:', e);
  }
}

async function exportToParquet(symbols: string[], outPath: string): Promise<void> {
  let duckdb: any;
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — duckdb is optional; graceful fallback below if not installed
    duckdb = await import('duckdb');
  } catch {
    console.log('[archiver] duckdb not available, skipping parquet export');
    return;
  }

  const db = new duckdb.Database(':memory:');
  await new Promise<void>((resolve, reject) => {
    db.run('INSTALL sqlite; LOAD sqlite;', (err: Error | null) => err ? reject(err) : resolve());
  });
  await new Promise<void>((resolve, reject) => {
    db.run(`ATTACH '${config.dbPath}' AS spxer (TYPE sqlite);`, (err: Error | null) => err ? reject(err) : resolve());
  });
  const symbolList = symbols.map(s => `'${s}'`).join(',');
  const sql = `
    COPY (
      SELECT symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type,
             json_extract(indicators, '$.hma5')     AS hma5,
             json_extract(indicators, '$.hma19')    AS hma19,
             json_extract(indicators, '$.hma25')    AS hma25,
             json_extract(indicators, '$.ema9')     AS ema9,
             json_extract(indicators, '$.ema21')    AS ema21,
             json_extract(indicators, '$.rsi14')    AS rsi14,
             json_extract(indicators, '$.bbUpper')  AS bb_upper,
             json_extract(indicators, '$.bbLower')  AS bb_lower,
             json_extract(indicators, '$.bbWidth')  AS bb_width,
             json_extract(indicators, '$.atr14')    AS atr14,
             json_extract(indicators, '$.vwap')     AS vwap,
             json_extract(indicators, '$.macd')     AS macd,
             json_extract(indicators, '$.adx14')    AS adx14
      FROM spxer.bars WHERE symbol IN (${symbolList})
    ) TO '${outPath}' (FORMAT PARQUET, COMPRESSION ZSTD);
  `;
  await new Promise<void>((resolve, reject) => {
    db.run(sql, (err: Error | null) => err ? reject(err) : resolve());
  });
  db.close();
}

async function uploadWithRetry(localPath: string, date: string, retries: number): Promise<void> {
  if (!existsSync(localPath)) throw new Error(`Parquet not found: ${localPath}`);
  const [year, month] = date.split('-');
  const remote = `${config.gdriveRemote}/${year}/${month}/`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      execSync(`rclone copy ${localPath} ${remote} --config ~/.config/rclone/rclone.conf`, { timeout: 60000 });
      return;
    } catch (e) {
      console.warn(`[archiver] rclone attempt ${attempt}/${retries} failed`, e);
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, attempt * 5000));
    }
  }
}
