/**
 * test-backtest-page.ts — Playwright check that the Studio Backtest page
 * (/spxer/studio/dashboard/backtest) renders the long-config sweep with the
 * spreads-style filters. Also verifies the Spreads page has NO long rows.
 *
 * Run: BASE_URL=http://localhost:3800 npx tsx scripts/diag/test-backtest-page.ts
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3800';
const BT_URL = `${BASE}/spxer/studio/dashboard/backtest`;
const SP_URL = `${BASE}/spxer/studio/dashboard/spreads`;
const SHOT_DIR = '/tmp/backtest-page-shots';

async function main() {
  const fs = await import('fs');
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
  const fails: string[] = [];
  const ok = (m: string) => console.log(`  ✓ ${m}`);
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fails.push(m); };
  page.on('pageerror', e => console.log(`  [pageerror] ${e.message}`));

  try {
    // 1. API through the studio proxy
    console.log('\n[1] API: /spxer/backtest/api/long-sweep via studio proxy');
    const apiRes = await page.request.get(`${BASE}/spxer/backtest/api/long-sweep`);
    const arr = await apiRes.json();
    if (Array.isArray(arr) && arr.length > 1000) ok(`long-sweep returned ${arr.length} rows`);
    else bad(`long-sweep returned ${Array.isArray(arr) ? arr.length : 'non-array'}`);
    if (Array.isArray(arr) && arr[0]) {
      const s = arr[0];
      const hasFields = s.signal && s.exit && s.pnl != null && s.wr != null && s.source === 'long';
      if (hasFields) ok(`row shape OK: signal="${s.signal}" exit="${s.exit}" pnl=${s.pnl} wr=${s.wr}`);
      else bad(`row missing fields: ${JSON.stringify(s).slice(0, 200)}`);
    }

    // 2. Backtest page loads + renders a table with long rows
    console.log('\n[2] Backtest page renders long rows');
    await page.goto(BT_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500); // let data fetch + table render
    await page.screenshot({ path: `${SHOT_DIR}/01-backtest.png`, fullPage: false });

    // Table rows present
    const rowCount = await page.locator('table tbody tr').count();
    if (rowCount > 5) ok(`table renders ${rowCount} rows`);
    else bad(`table has only ${rowCount} rows`);

    // A long signal label (e.g. "HMA 3m 3x12") visible somewhere in the table
    const bodyText = await page.locator('table').first().innerText().catch(() => '');
    const hasLongSig = /\b(HMA|DEMA)\b/.test(bodyText) && /TP\/.*SL|TP|\dSL|SL/.test(bodyText);
    if (hasLongSig) ok(`long signal + TP/SL labels visible in table`);
    else bad(`no HMA/DEMA + TP/SL labels found in table text (first 200: ${bodyText.replace(/\s+/g, ' ').slice(0, 200)})`);

    // 3. Filters present (the spreads-style filter UI)
    console.log('\n[3] Filter controls present');
    const filterBtn = page.getByRole('button', { name: /filter/i });
    if (await filterBtn.count()) {
      ok('Filter control present');
      await filterBtn.first().click().catch(() => {});
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SHOT_DIR}/02-filters-open.png`, fullPage: false });
    } else {
      // filters may be inline; check for a Signal/Type select or WR input
      const anySelect = await page.locator('select, [role="combobox"]').count();
      if (anySelect > 0) ok(`${anySelect} filter selects present (inline)`);
      else bad('no filter controls found');
    }

    // 4. Sort by clicking a column header (e.g. WR% or $Net)
    console.log('\n[4] Column sort');
    const sortable = page.locator('table thead button').first();
    if (await sortable.count()) {
      await sortable.click().catch(() => {});
      await page.waitForTimeout(600);
      const after = await page.locator('table tbody tr').count();
      if (after > 5) ok(`table re-rendered after sort (${after} rows)`);
      else bad(`table empty after sort`);
      await page.screenshot({ path: `${SHOT_DIR}/03-sorted.png`, fullPage: false });
    } else {
      bad('no sortable column header buttons found');
    }

    // 5. Spreads page should have NO long rows
    console.log('\n[5] Spreads page is credit/iron only (no long rows)');
    await page.goto(SP_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    const spText = await page.locator('table').first().innerText().catch(() => '');
    // Long rows would show the "long" spread badge; spreads page should show IB/IC/ITM/OTM/ATM instead
    const hasLongBadge = /\blong\b/i.test(spText) && /TP\/\d+SL/.test(spText);
    if (!hasLongBadge) ok('Spreads page shows no long-config rows');
    else bad('Spreads page still shows long rows (should be credit/iron only)');
    await page.screenshot({ path: `${SHOT_DIR}/04-spreads.png`, fullPage: false });

  } catch (e: any) {
    bad(`Exception: ${e.message}`);
    await page.screenshot({ path: `${SHOT_DIR}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Screenshots: ${SHOT_DIR}/`);
  if (!fails.length) { console.log('✓ ALL CHECKS PASSED'); process.exit(0); }
  console.log(`✗ ${fails.length} FAILED:`); fails.forEach(f => console.log(`   - ${f}`));
  process.exit(1);
}
main();
