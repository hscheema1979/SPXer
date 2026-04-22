/**
 * create-ndx-config.ts — Clone SPX 'default' config into an NDX-0DTE variant
 * with execution block pointing at NDX/NDXP/$10 strikes.
 *
 * Usage: npx tsx scripts/backfill/create-ndx-config.ts
 */
import Database from 'better-sqlite3';

const DB_PATH = '/home/ubuntu/SPXer/data/spxer.db';

const db = new Database(DB_PATH);

const row = db.prepare(`SELECT config_json FROM replay_configs WHERE id = 'default'`).get() as { config_json: string } | undefined;
if (!row) {
  console.error('[create-ndx-config] default config not found');
  process.exit(1);
}

const base = JSON.parse(row.config_json);

const ndxConfig = {
  ...base,
  id: 'ndx-default',
  name: 'NDX Default (0DTE)',
  description: 'NDX 0DTE baseline — cloned from SPX default with NDX-aware execution block. Strike interval $10, NDXP prefix, ±$500 sticky band.',
  execution: {
    symbol: 'NDX',
    optionPrefix: 'NDXP',
    strikeDivisor: 1,
    strikeInterval: 10,
    // No accountId — backtest only for now.
  },
  // NDX options are ~10x SPX $-notional. Scale strike search range so the
  // selector considers a $-band comparable to SPX's ±$80.
  strikeSelector: {
    ...base.strikeSelector,
    strikeSearchRange: 500,
  },
  // NDX contract prices are higher; keep a generous band.
  pipeline: {
    ...base.pipeline,
    strikeBand: 500,
    strikeInterval: 10,
  },
  contracts: {
    stickyBandWidth: 500,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

db.prepare(`
  INSERT OR REPLACE INTO replay_configs (id, name, description, config_json, baselineConfigId, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  ndxConfig.id,
  ndxConfig.name,
  ndxConfig.description,
  JSON.stringify(ndxConfig),
  'default',
  ndxConfig.createdAt,
  ndxConfig.updatedAt,
);

console.log(`[create-ndx-config] Upserted config '${ndxConfig.id}': ${ndxConfig.name}`);
console.log(`  execution.symbol=${ndxConfig.execution.symbol}`);
console.log(`  execution.optionPrefix=${ndxConfig.execution.optionPrefix}`);
console.log(`  execution.strikeInterval=${ndxConfig.execution.strikeInterval}`);
console.log(`  strikeSelector.strikeSearchRange=${ndxConfig.strikeSelector.strikeSearchRange}`);

db.close();
