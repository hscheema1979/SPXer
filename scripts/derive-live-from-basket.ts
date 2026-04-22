#!/usr/bin/env tsx
/**
 * Derive live single-strike configs from a basket config, plus a PM2 snippet.
 *
 * A basket replay runs N isolated single-strike replays internally. To run that
 * same basket LIVE, we fan out to N parallel agents — one per member — each with
 * its own Tradier OTOCO bracket. This script:
 *
 *   1. Loads a basket config from the store.
 *   2. Derives one single-strike config per member (same logic as replay uses:
 *      strikeMode='atm-offset', atmOffset=member.strikeOffset, basket disabled).
 *   3. Persists each derived config to the store (composite ID "<basket>:<member>").
 *   4. Prints a PM2 app snippet to paste into ecosystem.config.js — one
 *      spxer-agent-<member> app per member, each with AGENT_CONFIG_ID set to
 *      the derived config ID.
 *
 * It does NOT edit ecosystem.config.js or start anything. Review the snippet,
 * paste into ecosystem.config.js, then `pm2 start ecosystem.config.js --only <name>`.
 *
 * Usage:
 *   npx tsx scripts/derive-live-from-basket.ts <basket-config-id>
 *   npx tsx scripts/derive-live-from-basket.ts smoke-basket-5strike
 *
 * IMPORTANT: each derived member agent buys its own OTOCO. If you set
 * member sizing to X% of account, total basket exposure = N × X%. To keep
 * total exposure at X%, the basket config's sizing.sizingValue should
 * already be divided by N. This script does not re-divide — it uses
 * whatever sizing the basket config carries, via deriveMemberConfig.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createStore } from '../src/replay/store';
import { deriveMemberConfig } from '../src/replay/basket-runner';

const basketId = process.argv[2];
if (!basketId) {
  console.error('Usage: npx tsx scripts/derive-live-from-basket.ts <basket-config-id>');
  process.exit(1);
}

const store = createStore();
const basket = store.getConfig(basketId);
if (!basket) {
  console.error(`Config not found: ${basketId}`);
  store.close();
  process.exit(1);
}

if (!basket.basket?.enabled || !basket.basket.members?.length) {
  console.error(`Config ${basketId} is not a basket (basket.enabled must be true and members non-empty).`);
  store.close();
  process.exit(1);
}

const members = basket.basket.members;
const derivedIds: string[] = [];

console.log(`\n  Deriving live configs from basket: ${basketId}`);
console.log(`  ${'─'.repeat(60)}`);
console.log(`  Members: ${members.length}  |  per-member sizing: ${basket.sizing.sizingMode} ${basket.sizing.sizingValue}`);
console.log(`  Total basket exposure: ${members.length} × ${basket.sizing.sizingValue} (check this matches intent)\n`);

for (const m of members) {
  const derived = deriveMemberConfig(basket, m);
  store.saveConfig(derived);
  derivedIds.push(derived.id);
  const offsetLabel = m.strikeOffset === 0 ? 'ATM' : m.strikeOffset > 0 ? `OTM${m.strikeOffset}` : `ITM${-m.strikeOffset}`;
  console.log(`  saved  ${derived.id.padEnd(40)} ${offsetLabel}`);
}
store.close();

// ── PM2 snippet ──
const snippet = derivedIds.map((id, i) => {
  const m = members[i];
  const nameSafe = id.replace(/[^A-Za-z0-9_-]/g, '-');
  const offsetLabel = m.strikeOffset === 0 ? 'ATM' : m.strikeOffset > 0 ? `OTM${m.strikeOffset}` : `ITM${-m.strikeOffset}`;
  return `    {
      name: 'spxer-agent-${nameSafe}',
      script: 'npx',
      args: 'tsx spx_agent.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: false,
      max_restarts: 0,
      min_uptime: '10s',
      restart_delay: 30000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'true',      // START IN PAPER. Flip to 'false' only after verifying behavior.
        AGENT_CONFIG_ID: '${id}',  // ${offsetLabel}, strikeOffset=${m.strikeOffset}
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/spxer-agent-${nameSafe}-error.log',
      out_file: '/home/ubuntu/.pm2/logs/spxer-agent-${nameSafe}-out.log',
      merge_logs: true,
    },`;
}).join('\n');

console.log(`\n  ${'─'.repeat(60)}`);
console.log(`  PM2 snippet — paste into ecosystem.config.js 'apps' array:`);
console.log(`  ${'─'.repeat(60)}\n`);
console.log(snippet);
console.log(`\n  ${'─'.repeat(60)}`);
console.log(`  Next steps:`);
console.log(`    1. Review the snippet above.`);
console.log(`    2. Paste into ecosystem.config.js, keeping AGENT_PAPER='true' for first run.`);
console.log(`    3. pm2 start ecosystem.config.js --only spxer-agent-${derivedIds[0].replace(/[^A-Za-z0-9_-]/g, '-')}`);
console.log(`    4. Watch logs: pm2 logs spxer-agent-${derivedIds[0].replace(/[^A-Za-z0-9_-]/g, '-')}`);
console.log(`    5. Only when happy, flip AGENT_PAPER to 'false' and restart.`);
console.log();
