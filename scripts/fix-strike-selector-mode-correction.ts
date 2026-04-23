#!/usr/bin/env tsx
/**
 * Migration: Correct strikeMode for configs with mismatched targetOtmDistance
 *
 * Bug: Some configs have strikeMode='otm' but targetOtmDistance=-5 (ITM).
 * This migration corrects the strikeMode to match the targetOtmDistance.
 *
 * Usage: npx tsx scripts/fix-strike-selector-mode-correction.ts
 */

import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'spxer.db');
const db = new Database(DB_PATH, { readonly: false });

interface Config {
  strikeSelector: {
    strikeMode?: string;
    strikeSearchRange: number;
    contractPriceMin: number;
    contractPriceMax: number;
    targetOtmDistance?: number | null;
  };
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

  const { targetOtmDistance } = config.signals || {};
  const currentMode = config.strikeSelector?.strikeMode;

  // Determine correct strikeMode
  let correctMode: 'itm' | 'otm' | 'atm' | 'any' = 'otm';  // default

  if (targetOtmDistance != null) {
    if (targetOtmDistance < 0) {
      correctMode = 'itm';  // Negative = ITM
    } else if (targetOtmDistance === 0) {
      correctMode = 'atm';  // Zero = ATM
    } else {
      correctMode = 'otm';  // Positive = OTM
    }
  }

  // Check if correction needed
  if (currentMode === correctMode) {
    console.log(`[skip] ${row.id}: already correct (${currentMode})`);
    skippedCount++;
    continue;
  }

  // Update config
  if (!config.strikeSelector) {
    config.strikeSelector = {
      strikeSearchRange: 100,
      contractPriceMin: 0.2,
      contractPriceMax: 15.0,
    };
  }

  config.strikeSelector.strikeMode = correctMode;

  // Save to database
  const updatedJson = JSON.stringify(config);
  db.prepare('UPDATE replay_configs SET config_json = ?, updatedAt = ? WHERE id = ?')
    .run(updatedJson, Math.floor(Date.now() / 1000), row.id);

  console.log(`[fix] ${row.id}: ${row.name}`);
  console.log(`  → ${currentMode} → ${correctMode} (targetOtmDistance=${targetOtmDistance})`);
  updatedCount++;
}

console.log(`\n[migration] Complete: ${updatedCount} fixed, ${skippedCount} skipped`);

db.close();
