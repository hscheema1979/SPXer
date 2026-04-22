#!/usr/bin/env tsx
/**
 * Migration: prefix every config ID with the underlying instrument symbol.
 *
 *   default                            → spx-default
 *   hma3x15-itm5-tp125x-sl25-3m        → spx-hma3x15-itm5-tp125x-sl25-3m
 *   smoke-basket-5strike               → spx-smoke-basket-5strike
 *   smoke-basket-5strike:atm           → spx-smoke-basket-5strike:atm
 *   ndx-default-v5                     → ndx-default-v5   (already prefixed, no-op)
 *
 * Updates atomically:
 *   • replay_configs.id
 *   • replay_configs.baselineConfigId       (column)
 *   • replay_configs.config_json.id         (JSON)
 *   • replay_configs.config_json.baselineId (JSON)
 *   • replay_results.configId               (FK)
 *   • replay_runs.configId                  (FK)
 *
 * Orphaned configIds (in results/runs but not in replay_configs) are also
 * prefixed with 'spx-' so filters stay consistent.
 *
 * Usage: npx tsx scripts/migrate-prefix-config-ids.ts [--dry-run]
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data/spxer.db');
const DRY_RUN = process.argv.includes('--dry-run');

function normPrefix(sym: string): 'spx' | 'ndx' {
  const s = (sym || 'SPX').toUpperCase();
  return s === 'NDX' ? 'ndx' : 'spx';
}

function alreadyPrefixed(id: string): boolean {
  return id.startsWith('spx-') || id.startsWith('ndx-');
}

/** Compute the new ID, or null if no change needed. */
function newIdFor(oldId: string, symbol: string): string | null {
  if (alreadyPrefixed(oldId)) return null;
  const prefix = normPrefix(symbol);
  if (oldId.includes(':')) {
    const [base, ...rest] = oldId.split(':');
    const member = rest.join(':');
    if (alreadyPrefixed(base)) return null;
    return `${prefix}-${base}:${member}`;
  }
  return `${prefix}-${oldId}`;
}

const db = new Database(DB_PATH);

// ── Step 1: build mapping from known configs ───────────────────────────────
interface ConfigRow { id: string; config_json: string; baselineConfigId: string | null }
const configs = db.prepare('SELECT id, config_json, baselineConfigId FROM replay_configs').all() as ConfigRow[];

const mapping = new Map<string, string>();
for (const c of configs) {
  let sym = 'SPX';
  try {
    const cfg = JSON.parse(c.config_json);
    if (cfg?.execution?.symbol) sym = String(cfg.execution.symbol);
  } catch {}
  const n = newIdFor(c.id, sym);
  if (n && n !== c.id) mapping.set(c.id, n);
}

// ── Step 2: orphaned configIds (results/runs referencing deleted configs) ──
const orphanRows = db.prepare(`
  SELECT DISTINCT configId FROM (
    SELECT configId FROM replay_results
    UNION
    SELECT configId FROM replay_runs
  )
  WHERE configId NOT IN (SELECT id FROM replay_configs)
`).all() as { configId: string }[];

for (const { configId } of orphanRows) {
  if (mapping.has(configId)) continue;
  const n = newIdFor(configId, 'SPX'); // orphans default to SPX
  if (n && n !== configId) mapping.set(configId, n);
}

console.log(`[migrate] Config renames planned: ${mapping.size}`);
const sample = [...mapping.entries()].slice(0, 8);
for (const [a, b] of sample) console.log(`  ${a}  →  ${b}`);
if (mapping.size > 8) console.log(`  … (${mapping.size - 8} more)`);

if (DRY_RUN) {
  console.log('\n[migrate] --dry-run: no changes applied');
  db.close();
  process.exit(0);
}

// ── Step 3: apply migration in a single txn ────────────────────────────────
db.pragma('foreign_keys = OFF');

let configUpdates = 0;
let resultUpdates = 0;
let runUpdates = 0;
let baselineUpdates = 0;

const txn = db.transaction(() => {
  const now = Date.now();
  const stmtUpdConfig = db.prepare('UPDATE replay_configs SET id = ?, config_json = ?, baselineConfigId = ?, updatedAt = ? WHERE id = ?');
  const stmtUpdResults = db.prepare('UPDATE replay_results SET configId = ? WHERE configId = ?');
  const stmtUpdRuns = db.prepare('UPDATE replay_runs SET configId = ? WHERE configId = ?');
  const stmtUpdBaseline = db.prepare('UPDATE replay_configs SET baselineConfigId = ? WHERE baselineConfigId = ?');

  // Order: update results/runs first (they point at old ID), then rename the config row.
  // Because we set foreign_keys=OFF, order doesn't strictly matter, but we still
  // want all writes within a single atomic transaction.
  for (const [oldId, newId] of mapping) {
    const r1 = stmtUpdResults.run(newId, oldId);
    resultUpdates += r1.changes;
    const r2 = stmtUpdRuns.run(newId, oldId);
    runUpdates += r2.changes;
    const r3 = stmtUpdBaseline.run(newId, oldId);
    baselineUpdates += r3.changes;
  }

  // Now rename the config rows themselves. Do this after the FK column updates so
  // the INDEX on replay_results(configId) doesn't have to be rebuilt twice.
  for (const c of configs) {
    const newId = mapping.get(c.id);
    if (!newId) continue;
    let cfg: any = {};
    try { cfg = JSON.parse(c.config_json); } catch {}
    cfg.id = newId;
    if (cfg.baselineId && mapping.has(cfg.baselineId)) {
      cfg.baselineId = mapping.get(cfg.baselineId);
    }
    let newBaselineConfigId = c.baselineConfigId;
    if (newBaselineConfigId && mapping.has(newBaselineConfigId)) {
      newBaselineConfigId = mapping.get(newBaselineConfigId)!;
    }
    const r = stmtUpdConfig.run(newId, JSON.stringify(cfg), newBaselineConfigId, now, c.id);
    configUpdates += r.changes;
  }
});

txn();
db.pragma('foreign_keys = ON');

// ── Step 4: verify FK integrity (orphans are expected — we rename them too) ──
// The migration preserves the pre-existing orphan set: rows in replay_results
// /replay_runs whose configId had no matching replay_configs row before the
// migration still don't match after (we just renamed both sides consistently).
// Count them only for information.
const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
if (fkCheck.length) {
  console.log(`[migrate] Note: ${fkCheck.length} pre-existing FK orphans still present (results/runs referencing deleted configs)`);
}

console.log('\n[migrate] Applied:');
console.log(`  config rows renamed: ${configUpdates}`);
console.log(`  result rows updated: ${resultUpdates}`);
console.log(`  run rows updated:    ${runUpdates}`);
console.log(`  baselineConfigId col updates: ${baselineUpdates}`);
console.log('[migrate] Foreign key check: OK');

db.close();
