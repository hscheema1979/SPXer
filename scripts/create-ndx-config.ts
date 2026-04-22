/**
 * Create an NDX 0DTE replay config by cloning `default` and overriding:
 *   - execution.{symbol, optionPrefix, strikeInterval} (routes replay to NDX data)
 *   - strikeSelector.strikeSearchRange (NDX strikes are $10 apart, band is ±$500)
 *   - pipeline.{strikeBand, strikeInterval}
 *   - contracts.stickyBandWidth
 *   - sizing (placeholder — NDX premiums are ~10x SPX, tune after first run)
 *
 * Usage: npx tsx scripts/create-ndx-config.ts
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH || '/home/ubuntu/SPXer/data/spxer.db';
const SOURCE_ID = 'spx-default';
const TARGET_ID = 'ndx-default';

const db = new Database(DB_PATH);

const row = db.prepare(`SELECT config_json FROM replay_configs WHERE id=?`).get(SOURCE_ID) as { config_json: string } | undefined;
if (!row) {
  console.error(`Source config '${SOURCE_ID}' not found`);
  process.exit(1);
}

const cfg = JSON.parse(row.config_json);
cfg.id = TARGET_ID;
cfg.name = 'NDX 0DTE Default';
cfg.description = 'NDX 0DTE 1m baseline — cloned from default SPX, routed to NDX underlying + NDXP options (±$500 band, $10 strike interval).';
cfg.createdAt = Date.now();
cfg.updatedAt = Date.now();

// Route replay engine to NDX data via execution block
cfg.execution = {
  symbol: 'NDX',
  optionPrefix: 'NDXP',
  strikeDivisor: 1,
  strikeInterval: 10,
  // no accountId — backtest-only, no live trading yet
};

// Contract band scales with instrument price (NDX ≈ 20,000 vs SPX ≈ 5,000 = 4x-ish)
cfg.pipeline = cfg.pipeline || {};
cfg.pipeline.strikeBand = 500;
cfg.pipeline.strikeInterval = 10;

cfg.contracts = cfg.contracts || {};
cfg.contracts.stickyBandWidth = 500;

// Strike selector searches wider range (ATM ± 400 in $10 steps = 80 strikes)
cfg.strikeSelector = cfg.strikeSelector || {};
cfg.strikeSelector.strikeSearchRange = 400;
cfg.strikeSelector.contractPriceMin = 1.0;   // NDXP bid-ask is wider; filter junk under $1
cfg.strikeSelector.contractPriceMax = 9999;

// Sizing placeholder — NDX premiums are ~10x SPX; start small until validated
cfg.sizing = cfg.sizing || {};
cfg.sizing.baseDollarsPerTrade = 1000;
cfg.sizing.minContracts = 1;
cfg.sizing.maxContracts = 5;

const json = JSON.stringify(cfg);
const now = Date.now();

db.prepare(`
  INSERT INTO replay_configs (id, name, description, config_json, baselineConfigId, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,
    description=excluded.description,
    config_json=excluded.config_json,
    baselineConfigId=excluded.baselineConfigId,
    updatedAt=excluded.updatedAt
`).run(TARGET_ID, cfg.name, cfg.description, json, SOURCE_ID, now, now);

db.close();

console.log(`✓ Upserted replay config '${TARGET_ID}'`);
console.log(`  execution: ${JSON.stringify(cfg.execution)}`);
console.log(`  pipeline.{strikeBand, strikeInterval}: ${cfg.pipeline.strikeBand}, ${cfg.pipeline.strikeInterval}`);
console.log(`  strikeSelector.strikeSearchRange: ${cfg.strikeSelector.strikeSearchRange}`);
console.log(`  sizing.baseDollarsPerTrade: ${cfg.sizing.baseDollarsPerTrade}`);
