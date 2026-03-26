/**
 * query-results.ts — Query optimizer results for the agent to inspect.
 * All output is JSON to stdout.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/optimizer/query-results.ts --summary
 *   npx tsx scripts/autoresearch/optimizer/query-results.ts --dimension=stopLoss
 *   npx tsx scripts/autoresearch/optimizer/query-results.ts --top=10
 *   npx tsx scripts/autoresearch/optimizer/query-results.ts --baseline
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { OptimizerStore } from './store';

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const eq = a.indexOf('=');
  if (eq > 0) {
    flags[a.slice(2, eq)] = a.slice(eq + 1);
  } else {
    flags[a.replace(/^--/, '')] = 'true';
  }
}

const store = new OptimizerStore();

try {
  if (flags.summary) {
    console.log(JSON.stringify(store.getSummary(), null, 2));
  } else if (flags.dimension) {
    console.log(JSON.stringify(store.getByDimension(flags.dimension), null, 2));
  } else if (flags.top) {
    console.log(JSON.stringify(store.getTopN(parseInt(flags.top), flags.phase), null, 2));
  } else if (flags.baseline) {
    const bl = store.getBaseline();
    console.log(JSON.stringify(bl, null, 2));
  } else {
    console.log(JSON.stringify({
      usage: [
        '--summary     All dimensions explored + top 5 + baseline',
        '--dimension=X All results for dimension X',
        '--top=N       Top N results by composite score',
        '--baseline    The baseline result',
      ],
    }, null, 2));
  }
} finally {
  store.close();
}
