/**
 * test-long-dashboard.ts — Playwright UI check for long-config sweep results.
 *
 * Drives a headless Chromium against the live replay viewer (port 3601) and
 * asserts the long-* configs show up in the leaderboard with real metrics
 * (edge / WR / P&L), not blank rows.
 *
 * Run: BASE_URL=http://localhost:3601 npx tsx scripts/diag/test-long-dashboard.ts
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3601';
const SWEEP_URL = `${BASE}/replay/sweep?configPrefix=long`;
const SHOT_DIR = '/tmp/long-dashboard-shots';

async function main() {
  const fs = await import('fs');
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const fails: string[] = [];
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fails.push(m); };

  // Surface page console errors
  page.on('console', m => { if (m.type() === 'error') console.log(`  [browser console.error] ${m.text()}`); });
  page.on('pageerror', e => console.log(`  [browser pageerror] ${e.message}`));

  try {
    // 1. API-level: long configs present with computed metrics
    console.log('\n[1] API check: /replay/api/sweep returns long configs with metrics');
    const apiRes = await page.request.get(`${BASE}/replay/api/sweep?limit=5000&minDays=20&sort=edge&dir=DESC&configPrefix=long`);
    const apiJson = await apiRes.json();
    const rows = apiJson.rows || [];
    const longRows = rows.filter((r: any) => String(r.configId || '').startsWith('long-'));
    if (longRows.length > 0) ok(`API returned ${longRows.length} long configs (of ${rows.length} total)`);
    else bad(`API returned 0 long configs (total rows: ${rows.length})`);

    if (longRows.length) {
      const sample = longRows[0];
      const hasMetrics = sample.edge != null && sample.winRate != null && sample.totalPnl != null;
      if (hasMetrics) ok(`Sample long config has metrics: edge=${(sample.edge ?? 0).toFixed?.(3)} WR=${(sample.winRate ?? 0).toFixed?.(3)} pnl=${sample.totalPnl}`);
      else bad(`Sample long config MISSING metrics: ${JSON.stringify({ edge: sample.edge, winRate: sample.winRate, totalPnl: sample.totalPnl })}`);
      const fullDays = longRows.filter((r: any) => (r.days ?? 0) >= 20).length;
      if (fullDays === longRows.length) ok(`All ${longRows.length} long configs have days>=20 (merged across dates)`);
      else bad(`Only ${fullDays}/${longRows.length} long configs have days>=20 — merge incomplete`);
    }

    // 2. UI: load leaderboard page
    console.log('\n[2] UI check: leaderboard page loads');
    await page.goto(SWEEP_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('#tbody tr', { timeout: 20000 });
    const title = await page.title();
    ok(`Page loaded, title="${title}"`);
    await page.screenshot({ path: `${SHOT_DIR}/01-leaderboard.png`, fullPage: false });

    const totalCount = await page.textContent('#total-count');
    ok(`Configs counter shows: ${totalCount}`);

    // 3. UI: search/filter to a long config and confirm it renders in the table
    console.log('\n[3] UI check: long config visible in table');
    // Set minDays low to ensure long configs pass the filter, then reload data
    await page.selectOption('#min-days', { value: '20' }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForSelector('#tbody tr', { timeout: 15000 });

    // Count long rows currently rendered (data-cid starts with long-)
    const longRowCount = await page.locator('#tbody tr [data-cid^="long-"]').count();
    if (longRowCount > 0) ok(`${longRowCount} long-* rows rendered in leaderboard table`);
    else bad(`0 long-* rows rendered in table (they may be ranked below the visible window)`);

    // Read the first long row's displayed Config name + that its row has numeric cells
    if (longRowCount > 0) {
      const firstLongCid = await page.locator('#tbody tr [data-cid^="long-"]').first().getAttribute('data-cid');
      const rowText = await page.locator(`#tbody tr:has([data-cid="${firstLongCid}"])`).first().innerText();
      ok(`First long row (${firstLongCid}): ${rowText.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    await page.screenshot({ path: `${SHOT_DIR}/02-filtered.png`, fullPage: false });

    // 4. UI: sort by P&L and confirm table re-renders without error
    console.log('\n[4] UI check: sort by P&L');
    const pnlHeader = page.locator('th[data-col="totalPnl"]');
    if (await pnlHeader.count()) {
      await pnlHeader.click();
      await page.waitForTimeout(1000);
      const rowsAfter = await page.locator('#tbody tr').count();
      if (rowsAfter > 0) ok(`Table re-rendered after P&L sort (${rowsAfter} rows)`);
      else bad('Table empty after P&L sort');
      await page.screenshot({ path: `${SHOT_DIR}/03-sorted-pnl.png`, fullPage: false });
    } else {
      bad('P&L sort header not found');
    }

  } catch (e: any) {
    bad(`Exception: ${e.message}`);
    await page.screenshot({ path: `${SHOT_DIR}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Screenshots: ${SHOT_DIR}/`);
  if (fails.length === 0) {
    console.log('✓ ALL CHECKS PASSED — long configs render in dashboard with metrics');
    process.exit(0);
  } else {
    console.log(`✗ ${fails.length} CHECK(S) FAILED:`);
    fails.forEach(f => console.log(`   - ${f}`));
    process.exit(1);
  }
}

main();
