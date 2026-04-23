#!/usr/bin/env tsx
/**
 * Fix strikeMode: Set to 'itm' for ITM configs (targetOtmDistance < 0)
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
  };
  signals: {
    targetOtmDistance?: number;
  };
}

console.log('[fix] Reading configs...');
const rows = db.prepare('SELECT id, name, config_json FROM replay_configs').all() as any[];

let fixedCount = 0;

for (const row of rows) {
  const config: Config = JSON.parse(row.config_json);

  if (!config.signals || config.signals.targetOtmDistance === undefined) {
    continue;
  }

  const target = config.signals.targetOtmDistance;
  let correctMode: string;

  if (target < 0) {
    correctMode = 'itm';
  } else if (target === 0) {
    correctMode = 'atm';
  } else {
    correctMode = 'otm';
  }

  const currentMode = config.strikeSelector?.strikeMode;

  if (currentMode !== correctMode) {
    if (!config.strikeSelector) {
      config.strikeSelector = {
        strikeSearchRange: 100,
        contractPriceMin: 0.2,
        contractPriceMax: 15.0,
      };
    }

    config.strikeSelector.strikeMode = correctMode;

    db.prepare('UPDATE replay_configs SET config_json = ?, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(config), Math.floor(Date.now() / 1000), row.id);

    console.log(`[fix] ${row.id}: ${currentMode || 'null'} → ${correctMode} (targetOtmDistance=${target})`);
    fixedCount++;
  }
}

console.log(`\n[fix] Fixed ${fixedCount} configs`);
db.close();
