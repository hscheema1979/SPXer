/**
 * test-backtest-tabs.ts — exercises the Backtest page beyond filters: selects a
 * few long configs and clicks through every analysis tab (Equity/Drawdown/
 * Hourly/Coverage/Regime/Correlation), watching for runtime errors and empty
 * renders. Catches tabs that silently break for long-source rows.
 */
import { chromium, Page } from 'playwright';
const BASE = process.env.BASE_URL || 'http://localhost:3800';
const URL = `${BASE}/spxer/studio/dashboard/backtest`;
const SHOT = '/tmp/backtest-tab-shots';

const fails: string[] = [];
const consoleErrs: string[] = [];
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => { console.log(`  ✗ ${m}`); fails.push(m); };

async function main() {
  const fs = await import('fs'); fs.mkdirSync(SHOT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  page.on('pageerror', e => { consoleErrs.push(`pageerror: ${e.message}`); });
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(`console.error: ${m.text()}`); });

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500);

    // Select the first 3 rows (checkboxes) so secondary tabs have data.
    console.log('\n[Select 3 rows]');
    const boxes = page.locator('table tbody tr input[type="checkbox"]');
    const nBox = await boxes.count();
    for (let i = 0; i < Math.min(3, nBox); i++) await boxes.nth(i).click().catch(() => {});
    await page.waitForTimeout(800);
    const selText = await page.getByText(/selected/i).first().innerText().catch(() => '');
    ok(`selection UI: "${selText.replace(/\s+/g, ' ').slice(0, 40)}"`);

    // Click through every tab; assert no crash + something renders.
    const tabs = ['Equity Curve', 'Daily Heatmap', 'Hourly Heatmap', 'Risk Analysis', 'Coverage Grid', 'Regime', 'Correlation'];
    for (const tab of tabs) {
      const t = page.getByRole('tab', { name: new RegExp(tab, 'i') });
      if (!(await t.count())) { console.log(`  – tab "${tab}" not present (skip)`); continue; }
      const before = consoleErrs.length;
      await t.first().click();
      await page.waitForTimeout(1800);
      const newErrs = consoleErrs.slice(before);
      // content present? (canvas chart, table, or any non-empty panel text)
      const hasCanvas = await page.locator('canvas').count();
      const panelText = (await page.locator('[role="tabpanel"], .tab-content, main').first().innerText().catch(() => '')).trim();
      const rendered = hasCanvas > 0 || panelText.length > 20;
      if (newErrs.length) bad(`tab "${tab}" threw: ${newErrs[0].slice(0, 120)}`);
      else if (!rendered) bad(`tab "${tab}" rendered empty`);
      else ok(`tab "${tab}" OK (${hasCanvas} canvas, ${panelText.length} chars)`);
      await page.screenshot({ path: `${SHOT}/${tab.replace(/\s+/g, '-')}.png` }).catch(() => {});
    }

    // Back to table tab, confirm it still renders.
    const tableTab = page.getByRole('tab', { name: /^Table/i });
    if (await tableTab.count()) { await tableTab.first().click(); await page.waitForTimeout(800); }
    const rows = await page.locator('table tbody tr').count();
    rows > 5 ? ok(`Table tab still renders (${rows} rows)`) : bad(`Table tab broken (${rows} rows)`);

  } catch (e: any) {
    bad(`Exception: ${e.message}`);
    await page.screenshot({ path: `${SHOT}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }

  if (consoleErrs.length) {
    console.log(`\n[${consoleErrs.length} console/page errors total]`);
    [...new Set(consoleErrs)].slice(0, 8).forEach(e => console.log(`   ! ${e.slice(0, 140)}`));
  }
  console.log(`\n${'='.repeat(50)}\nScreenshots: ${SHOT}/`);
  if (!fails.length) { console.log('✓ ALL TAB CHECKS PASSED'); process.exit(0); }
  console.log(`✗ ${fails.length} FAILED:`); fails.forEach(f => console.log(`   - ${f}`));
  process.exit(1);
}
main();
