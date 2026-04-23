#!/usr/bin/env tsx
/**
 * Fix ITM5 configs - Add proper strikeSelector to database
 *
 * Problem: Configs named "itm5" have strikeSelector: null in DB
 * Result: System uses default OTM mode instead of ITM5
 * Fix: Update all itm5 configs with correct strikeSelector
 */

import Database from 'better-sqlite3';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const DB_PATH = 'data/spxer.db';

const db = new Database(DB_PATH);

// Find all configs with "itm5" in the name
const itm5Configs = db.prepare(`
  SELECT id, config_json
  FROM replay_configs
  WHERE id LIKE '%itm5%'
`).all() as Array<{ id: string; config_json: string }>;

console.log(`Found ${itm5Configs.length} itm5 configs to fix`);

for (const row of itm5Configs) {
  try {
    const config = JSON.parse(row.config_json);

    // Check if strikeSelector is null or missing
    if (!config.strikeSelector || Object.keys(config.strikeSelector).length === 0) {
      console.log(`\n[${row.id}] Fixing strikeSelector...`);

      // Add proper ITM5 strikeSelector
      config.strikeSelector = {
        strikeSearchRange: 80,
        contractPriceMin: 0.2,
        contractPriceMax: 9999,
        strikeMode: 'itm' as const,  // ITM mode
      };

      // Set targetOtmDistance to -5 (ITM5) in signals section
      if (!config.signals) config.signals = {} as any;
      config.signals.targetOtmDistance = -5;

      // Update the database
      db.prepare(`
        UPDATE replay_configs
        SET config_json = ?,
            updatedAt = ?
        WHERE id = ?
      `).run(JSON.stringify(config), Date.now(), row.id);

      console.log(`  ✓ Fixed: strikeMode='itm', targetOtmDistance=-5`);
    } else {
      console.log(`\n[${row.id}] Already has strikeSelector, skipping`);
      console.log(`  Current:`, JSON.stringify(config.strikeSelector));
    }
  } catch (e: any) {
    console.error(`\n[${row.id}] ERROR:`, e.message);
  }
}

console.log('\n✅ Done! Restart event handler to pick up new configs.');
console.log('   pm2 restart event-handler');

db.close();
