/**
 * test-backtest-filters.ts — DEEP filter-interaction test for the Studio
 * Backtest page (long-config sweep). For each filter it applies the control,
 * asserts the "X of Y variants" count narrows, and asserts the visible rows
 * actually match. Long-mode columns: Signal|Type|TF|TP%|SL%|$Net|$/trade|
 * Trades|WR%|R-Mult|HoldMin|+days.
 *
 * Run: BASE_URL=http://localhost:3800 npx tsx scripts/diag/test-backtest-filters.ts
 */
import { chromium, Page, Locator } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3800';
const URL = `${BASE}/spxer/studio/dashboard/backtest`;
const SHOT = '/tmp/backtest-filter-shots';

const fails: string[] = [];
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { console.log(`  ✗ ${m}`); fails.push(m); };

// The filter panel (CollapsibleContent) — scope all control lookups here so
// filter Labels don't collide with identically-named column headers.
function panel(page: Page): Locator {
  // The grid of filter controls lives in the div after the Filters trigger.
  return page.locator('div.grid').filter({ has: page.getByText('Signal TF', { exact: true }) }).first();
}

async function variantCount(page: Page): Promise<number> {
  const txt = await page.getByText(/of [\d,]+ variants/).first().innerText().catch(() => '');
  const m = txt.replace(/,/g, '').match(/([\d]+)\s+of\s+([\d]+)\s+variants/);
  return m ? parseInt(m[1], 10) : -1;
}

async function openFilters(page: Page) {
  const tfVisible = await page.getByText('Signal TF', { exact: true }).isVisible().catch(() => false);
  if (!tfVisible) { await page.getByRole('button', { name: /^Filters/ }).click(); await page.waitForTimeout(500); }
}

// Drive a shadcn Select inside the filter panel, identified by its Label.
async function selectByLabel(page: Page, label: string, optionLabel: string) {
  const group = panel(page).locator('div.space-y-1', { has: page.getByText(label, { exact: true }) }).first();
  const trigger = group.getByRole('combobox');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await page.waitForTimeout(300);
  await page.getByRole('option', { name: optionLabel, exact: true }).first().click();
  await page.waitForTimeout(500);
}

// Header index for a column label (long columns).
async function colIndex(page: Page, label: string): Promise<number> {
  const headers = await page.locator('table thead th').allInnerTexts();
  return headers.findIndex(h => h.trim() === label || h.trim().startsWith(label));
}

// Read column `idx` for the first `max` visible rows.
async function colValues(page: Page, idx: number, max = 40): Promise<string[]> {
  return page.locator('table tbody tr').evaluateAll((trs, i) =>
    trs.slice(0, 40).map(tr => (tr.querySelectorAll('td')[i]?.textContent || '').trim()), idx);
}

async function clearAll(page: Page) {
  const reset = page.getByRole('button', { name: /reset all/i });
  if (await reset.count()) { await reset.first().click(); await page.waitForTimeout(500); }
}

async function main() {
  const fs = await import('fs');
  fs.mkdirSync(SHOT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  page.on('pageerror', e => console.log(`  [pageerror] ${e.message}`));

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);
    await openFilters(page);

    const base = await variantCount(page);
    console.log(`\nBaseline: ${base} variants`);
    base > 5000 ? ok(`baseline ${base}`) : bad(`baseline too low: ${base}`);

    const idxType = await colIndex(page, 'Type');
    const idxTF   = await colIndex(page, 'TF');
    const idxTP   = await colIndex(page, 'TP%');
    const idxSL   = await colIndex(page, 'SL%');
    const idxWR   = await colIndex(page, 'WR%');
    const idxSig  = await colIndex(page, 'Signal');
    console.log(`  col idx: Type=${idxType} TF=${idxTF} TP=${idxTP} SL=${idxSL} WR=${idxWR} Sig=${idxSig}`);

    // ── Type = DEMA ──
    console.log('\n[Type = DEMA]');
    await selectByLabel(page, 'Type', 'DEMA');
    const c1 = await variantCount(page);
    (c1 > 0 && c1 < base) ? ok(`narrowed ${base} → ${c1}`) : bad(`Type=DEMA didn't narrow (${c1})`);
    let vals = await colValues(page, idxType);
    vals.length && vals.every(v => v === 'DEMA') ? ok(`all ${vals.length} rows Type=DEMA`) : bad(`Type leak: ${[...new Set(vals)].join(',')}`);
    await page.screenshot({ path: `${SHOT}/01-type-dema.png` });
    await clearAll(page); await openFilters(page);
    (await variantCount(page)) === base ? ok('reset restored baseline') : bad('reset did not restore');

    // ── Signal TF = 3m (single-TF only) ──
    console.log('\n[Signal TF = 3m]');
    await selectByLabel(page, 'Signal TF', '3m');
    const c2 = await variantCount(page);
    (c2 > 0 && c2 < base) ? ok(`narrowed ${base} → ${c2}`) : bad(`TF=3m didn't narrow (${c2})`);
    vals = await colValues(page, idxTF);
    vals.length && vals.every(v => v === '3m') ? ok(`all ${vals.length} rows TF=3m`) : bad(`TF leak: ${[...new Set(vals)].join(',')}`);
    await clearAll(page); await openFilters(page);

    // ── Signal TF = multi ──
    console.log('\n[Signal TF = multi]');
    await selectByLabel(page, 'Signal TF', 'multi');
    const c3 = await variantCount(page);
    (c3 > 0 && c3 < base) ? ok(`narrowed ${base} → ${c3}`) : bad(`TF=multi didn't narrow (${c3})`);
    vals = await colValues(page, idxTF);
    vals.length && vals.every(v => v === 'multi') ? ok(`all ${vals.length} rows TF=multi`) : bad(`TF leak: ${[...new Set(vals)].join(',')}`);
    await clearAll(page); await openFilters(page);

    // ── TP% = 500 ──
    console.log('\n[TP% = 500]');
    await selectByLabel(page, 'TP%', '500%');
    const c4 = await variantCount(page);
    (c4 > 0 && c4 < base) ? ok(`narrowed ${base} → ${c4}`) : bad(`TP%=500 didn't narrow (${c4})`);
    vals = await colValues(page, idxTP);
    vals.length && vals.every(v => v === '500%') ? ok(`all ${vals.length} rows TP=500%`) : bad(`TP leak: ${[...new Set(vals)].join(',')}`);
    await clearAll(page); await openFilters(page);

    // ── SL% = 20 ──
    console.log('\n[SL% = 20]');
    await selectByLabel(page, 'SL%', '20%');
    const c5 = await variantCount(page);
    (c5 > 0 && c5 < base) ? ok(`narrowed ${base} → ${c5}`) : bad(`SL%=20 didn't narrow (${c5})`);
    vals = await colValues(page, idxSL);
    vals.length && vals.every(v => v === '20%') ? ok(`all ${vals.length} rows SL=20%`) : bad(`SL leak: ${[...new Set(vals)].join(',')}`);
    await clearAll(page); await openFilters(page);

    // ── Strike = 25ITM ──
    console.log('\n[Strike = 25ITM]');
    const idxStrike = await colIndex(page, 'Strike');
    await selectByLabel(page, 'Strike', '25ITM');
    const cStrike = await variantCount(page);
    (cStrike > 0 && cStrike < base) ? ok(`narrowed ${base} → ${cStrike}`) : bad(`Strike=25ITM didn't narrow (${cStrike})`);
    vals = await colValues(page, idxStrike);
    vals.length && vals.every(v => v === '25ITM') ? ok(`all ${vals.length} rows Strike=25ITM`) : bad(`Strike leak: ${[...new Set(vals)].join(',')}`);
    await clearAll(page); await openFilters(page);

    // ── Min WR% = 50 ──
    console.log('\n[Min WR% = 50]');
    {
      const grp = panel(page).locator('div.space-y-1', { has: page.getByText('Min WR%', { exact: true }) }).first();
      await grp.getByRole('spinbutton').fill('50');
      await page.waitForTimeout(600);
    }
    const c6 = await variantCount(page);
    (c6 > 0 && c6 < base) ? ok(`narrowed ${base} → ${c6}`) : bad(`Min WR%=50 didn't narrow (${c6})`);
    vals = await colValues(page, idxWR);
    const belowWr = vals.map(v => parseFloat(v)).filter(v => !isNaN(v) && v < 50);
    belowWr.length === 0 ? ok(`all visible rows WR ≥ 50`) : bad(`${belowWr.length} rows below WR 50 (e.g. ${belowWr[0]})`);
    await page.screenshot({ path: `${SHOT}/02-minwr.png` });
    await clearAll(page); await openFilters(page);

    // ── Specific Signal from dropdown ──
    console.log('\n[Signal = specific]');
    {
      const grp = panel(page).locator('div.space-y-1', { has: page.getByText('Signal', { exact: true }) }).first();
      await grp.getByRole('combobox').click();
      await page.waitForTimeout(300);
      const opts = page.getByRole('option');
      const chosen = (await opts.nth(1).innerText()).trim();
      await opts.nth(1).click();
      await page.waitForTimeout(500);
      const c7 = await variantCount(page);
      (c7 > 0 && c7 < base) ? ok(`Signal="${chosen}" narrowed ${base} → ${c7}`) : bad(`Signal filter didn't narrow (${c7})`);
      vals = await colValues(page, idxSig);
      vals.length && vals.every(v => v === chosen) ? ok(`all ${vals.length} rows match`) : bad(`signal leak: ${[...new Set(vals)].slice(0,3).join(' | ')}`);
    }
    await clearAll(page); await openFilters(page);

    // ── Combined: Type=HMA + TF=multi + TP=500 ──
    console.log('\n[Combined: HMA + multi + TP500]');
    await selectByLabel(page, 'Type', 'HMA');
    await selectByLabel(page, 'Signal TF', 'multi');
    await selectByLabel(page, 'TP%', '500%');
    const c8 = await variantCount(page);
    const tCol = await colValues(page, idxType), fCol = await colValues(page, idxTF), pCol = await colValues(page, idxTP);
    const comboOk = tCol.length > 0 && tCol.every(v => v === 'HMA') && fCol.every(v => v === 'multi') && pCol.every(v => v === '500%');
    (c8 > 0 && c8 < base && comboOk) ? ok(`combined: ${c8} rows, all HMA+multi+TP500`) : bad(`combined wrong: count=${c8} type=${[...new Set(tCol)]} tf=${[...new Set(fCol)]} tp=${[...new Set(pCol)]}`);
    await page.screenshot({ path: `${SHOT}/03-combined.png` });

  } catch (e: any) {
    bad(`Exception: ${e.message}`);
    await page.screenshot({ path: `${SHOT}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n${'='.repeat(50)}\nScreenshots: ${SHOT}/`);
  if (!fails.length) { console.log('✓ ALL FILTER CHECKS PASSED'); process.exit(0); }
  console.log(`✗ ${fails.length} FAILED:`); fails.forEach(f => console.log(`   - ${f}`));
  process.exit(1);
}
main();
