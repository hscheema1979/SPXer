/**
 * merge-long-shards.ts — fold per-shard sweep files into the one the studio reads.
 *
 * Sharded grid runs write long-sweep-<ticker>.shardN.json each (a shared file
 * would be clobbered by 8 concurrent read-modify-writes). This merges them into
 * long-sweep-<ticker>.json, last-writer-wins per configId, and reports how many
 * rows came from where.
 *
 *   npx tsx scripts/diag/merge-long-shards.ts --ticker spx-0dte [--keep-shards]
 */
import * as fs from 'fs';
import * as path from 'path';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const TICKER = arg('ticker', 'spx-0dte');
const KEEP = process.argv.includes('--keep-shards');
const DIR = path.join(process.cwd(), 'scripts/autoresearch/output');
const target = path.join(DIR, `long-sweep-${TICKER}.json`);

const byId = new Map<string, any>();
let existing = 0;
if (fs.existsSync(target)) {
  try {
    for (const r of JSON.parse(fs.readFileSync(target, 'utf8'))) { byId.set(r.configId, r); existing++; }
  } catch { /* corrupt/partial — start from the shards */ }
}

const shards = fs.readdirSync(DIR)
  .filter(f => new RegExp(`^long-sweep-${TICKER}\\.shard\\d+\\.json$`).test(f))
  .sort();
if (!shards.length) { console.error(`no shard files for ${TICKER} in ${DIR}`); process.exit(1); }

let added = 0, replaced = 0;
for (const f of shards) {
  let rows: any[] = [];
  try { rows = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e: any) {
    console.error(`  ${f}: unreadable (${e.message}) — skipped`);
    continue;
  }
  for (const r of rows) {
    if (byId.has(r.configId)) replaced++; else added++;
    byId.set(r.configId, r);
  }
  console.error(`  ${f}: ${rows.length} rows`);
}

const merged = [...byId.values()];
fs.writeFileSync(target, JSON.stringify(merged, null, 2));
console.error(`\n${path.basename(target)}: ${existing} existing + ${added} new (${replaced} replaced) = ${merged.length} rows`);
if (!KEEP) {
  for (const f of shards) fs.unlinkSync(path.join(DIR, f));
  console.error(`removed ${shards.length} shard files (--keep-shards to keep them)`);
}
