#!/usr/bin/env tsx
/**
 * Migration: Add missing strikeMode field to strikeSelector configs
 *
 * Bug: Configs created without strikeSelector.strikeMode default to 'otm',
 * causing ITM5 configs to pick OTM or deep-ITM strikes.
 *
 * Usage: npx tsx scripts/fix-strike-selector-mode.ts
 */

import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'spxer.db');
const db = new Database(DB_PATH, { readonly: false });

interface StrikeSelector {
  strikeMode?: 'itm' | 'otm' | 'atm' | 'any';
  strikeSearchRange: number;
  contractPriceMin: number;
  contractPriceMax: number;
  targetOtmDistance?: number | null;
  targetContractPrice?: number | null;
}

interface Config {
  strikeSelector: StrikeSelector;
  signals: {
    targetOtmDistance?: number;
  };
}

interface ConfigRow {
  id: string;
  name: string;
  config_json: string;
}

console.log('[migration] Reading configs from database...');
const rows = db.prepare('SELECT id, name, config_json FROM replay_configs').all() as ConfigRow[];

console.log(`[migration] Found ${rows.length} configs\n`);

let updatedCount = 0;
let skippedCount = 0;

for (const row of rows) {
  let config: Config;
  try {
    config = JSON.parse(row.config_json);
  } catch (e) {
    console.error(`[migration] ERROR: Failed to parse config ${row.id}: ${e}`);
    continue;
  }

  // Skip if already has strikeMode
  if (config.strikeSelector?.strikeMode) {
    console.log(`[skip] ${row.id} already has strikeMode: ${config.strikeSelector.strikeMode}`);
    skippedCount++;
    continue;
  }

  // Determine correct strikeMode
  let strikeMode: 'itm' | 'otm' | 'atm' | 'any' = 'otm';  // default
  const { targetOtmDistance } = config.signals || {};

  if (targetOtmDistance != null) {
    if (targetOtmDistance < 0) {
      strikeMode = 'itm';  // Negative = ITM
    } else if (targetOtmDistance === 0) {
      strikeMode = 'atm';  // Zero = ATM
    } else {
      strikeMode = 'otm';  // Positive = OTM
    }
  } else if (row.id.includes('itm')) {
    strikeMode = 'itm';
  } else if (row.id.includes('atm')) {
    strikeMode = 'atm';
  } else if (row.id.includes('otm')) {
    strikeMode = 'otm';
  }

  // Update config
  if (!config.strikeSelector) {
    config.strikeSelector = {
      strikeSearchRange: 100,
      contractPriceMin: 0.2,
      contractPriceMax: 15.0,
    };
  }

  config.strikeSelector.strikeMode = strikeMode;

  // Save to database
  const updatedJson = JSON.stringify(config);
  db.prepare('UPDATE replay_configs SET config_json = ?, updatedAt = ? WHERE id = ?')
    .run(updatedJson, Math.floor(Date.now() / 1000), row.id);

  console.log(`[update] ${row.id}: ${row.name}`);
  console.log(`  → strikeMode: ${strikeMode} (inferred from targetOtmDistance=${targetOtmDistance}, id="${row.id}")`);
  updatedCount++;
}

console.log(`\n[migration] Complete: ${updatedCount} updated, ${skippedCount} skipped`);

db.close();
