/**
 * sweep-manager.ts — single entry point for the per-ticker / per-day sweep
 * data lifecycle. Replaces the ad-hoc /tmp/*.sh scripts.
 *
 *   npx tsx scripts/diag/sweep-manager.ts <cmd> --symbol SPY --dte 1 [opts]
 *
 * Commands
 *   list                                 registry + per-profile status
 *   verify   --symbol X --dte N          integrity: parquet gaps, sweep rows,
 *                                         illegal/stale geometry, risk count
 *   validate --symbol X --dte N [--days K] fresh small sweep + concurrent-
 *                                         distribution EXACT-MATCH proof
 *   execute  --symbol X --dte N [--days K] clean slate -> credit -> iron ->
 *                                         curate -> concurrent-distribution
 *   backfill --symbol X --dte N --days K  K recent trading days -> parquet
 *   delete   --symbol X --dte N [--bars --date D]   remove outputs / one day
 *   onboard  --symbol X --dte N --days K  register? + backfill+verify+validate+execute
 *   <any>    --all                       iterate registry (skips protected SPX
 *                                         unless --force-spx)
 *
 * SPX (profile suffix '') is protected: destructive ops abort without
 * --force-spx. Per-ticker suffixes mean an ETF op physically cannot touch SPX
 * files. All paths come from resolveSymbolTarget()+outPath() (proven).
 *
 * Data vendor: Polygon ONLY (underlying + options), all profiles. ThetaData
 * was removed 2026-05-17. backfill/onboard work for the 4 existing profiles
 * (spx-0dte, ndx-0dte, spy-1dte, qqq-1dte) AND for genuinely new tickers:
 * `onboard` calls discoverProfile() (Polygon) to auto-fill the registry
 * (class, strikeInterval, optionPrefix, underlyingPolygonTicker, band) — the
 * 3 historical blockers (resolveTarget switch, getUnderlyingDay 0DTE-parquet
 * dependency, sweep-symbol BASES) are all registry-driven now. CLI overrides:
 * --class --strike-interval --option-prefix --underlying-ticker --band.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { resolveSymbolTarget, listDatesFor, outPath, SymbolTarget } from './sweep-symbol';
import { discoverProfile, DiscoveryError } from '../../src/instruments/discovery';

const ROOT = process.cwd();
const REGISTRY = path.join(__dirname, 'sweep-registry.json');
const OUT_DIR = path.join(ROOT, 'scripts/autoresearch/output');

interface RegProfile {
  symbol: string; dte: number; strikeInterval: number; optionPrefix: string;
  protected: boolean; note?: string;
  class?: 'index' | 'etf';
  underlyingPolygonTicker?: string;   // Polygon agg ticker (I: for indices)
  bandHalfWidthDollars?: number;      // strike band = lastClose ± this
}
// Register a COMPLETE entry (all fields backfill needs) so a genuinely new
// ticker resolves with zero code edits. CLI overrides: --class, --strike-interval,
// --option-prefix, --underlying-ticker, --band. Defaults derive from class.
function ensureRegistered(symbol: string, dte: number): RegProfile {
  const reg = loadRegistry();
  let p = reg.find(r => r.symbol === symbol && r.dte === dte);
  if (p) return p;
  const cls = (arg('class') as 'index' | 'etf') || (['SPX', 'NDX', 'RUT', 'VIX', 'XSP'].includes(symbol) ? 'index' : 'etf');
  const si = Number(arg('strike-interval')) || (cls === 'index' ? 5 : 1);
  p = {
    symbol, dte, class: cls, strikeInterval: si,
    optionPrefix: arg('option-prefix') || symbol,
    underlyingPolygonTicker: arg('underlying-ticker') || (cls === 'index' ? `I:${symbol}` : symbol),
    bandHalfWidthDollars: Number(arg('band')) || (cls === 'index' ? 100 : 10),
    protected: false, note: 'added via onboard',
  };
  reg.push(p); saveRegistry(reg);
  console.log(`  registered ${symbol}-${dte}dte: class=${p.class} SI=${p.strikeInterval} prefix=${p.optionPrefix} polyTk=${p.underlyingPolygonTicker} band=±$${p.bandHalfWidthDollars}`);
  return p;
}

/**
 * Discovery-backed registration (preferred path for `onboard`). For a
 * genuinely new ticker, query Polygon via discoverProfile() so class /
 * strikeInterval / optionPrefix / underlyingPolygonTicker / band come from the
 * REAL option chain — GCD-inferred strike interval, avg-daily-range band,
 * SPXW/NDXP prefix overrides — instead of the crude class heuristic in
 * ensureRegistered(). CLI flags (--class --strike-interval --option-prefix
 * --underlying-ticker --band) always override discovery. Offline / unknown
 * ticker / no POLYGON_API_KEY → fall back to the sync heuristic. Idempotent:
 * a ticker already in the registry returns immediately (no network call).
 */
async function discoverAndRegister(symbol: string, dte: number): Promise<RegProfile> {
  const existing = loadRegistry().find(r => r.symbol === symbol && r.dte === dte);
  if (existing) return existing;

  let disc;
  try {
    disc = await discoverProfile(symbol);
  } catch (e: any) {
    const code = e instanceof DiscoveryError ? e.code : 'API_ERROR';
    console.log(`  ⚠ Polygon discovery failed for ${symbol} (${code}: ${e.message}) — falling back to class heuristic`);
    return ensureRegistered(symbol, dte);
  }

  // RegProfile.class is index|etf; discovery AssetClass also has 'equity'.
  // Equity and ETF share the tight liquid-width cap in the sweeps, so an
  // equity is registered as 'etf' for width-cap purposes (its bare Polygon
  // underlying ticker — no I: prefix — is preserved via vendorRouting).
  const discClass: 'index' | 'etf' = disc.assetClass === 'index' ? 'index' : 'etf';
  const cls = (arg('class') as 'index' | 'etf') || discClass;
  const si = Number(arg('strike-interval')) || disc.strikeInterval || (cls === 'index' ? 5 : 1);
  const polyTk = arg('underlying-ticker') || disc.vendorRouting.underlying.ticker;
  const band = Number(arg('band')) || disc.bandHalfWidthDollars || (cls === 'index' ? 100 : 10);
  const prefix = arg('option-prefix') || disc.optionPrefix || symbol;

  const p: RegProfile = {
    symbol, dte, class: cls, strikeInterval: si,
    optionPrefix: prefix,
    underlyingPolygonTicker: polyTk,
    bandHalfWidthDollars: band,
    protected: false,
    note: `onboarded via Polygon discovery (${disc.displayName}; cadences ${disc.expiryCadences.join('/')})`,
  };
  const reg = loadRegistry(); reg.push(p); saveRegistry(reg);

  // Tradeable-horizon hint: daily-expiry chains (SPX/NDX-like) → 0DTE;
  // weekly/monthly-only (most single stocks / physically-settled ETFs) → 1DTE
  // to dodge near-expiry assignment/broker blocks. Informational only — the
  // operator still passes --dte (the Studio UI will surface this suggestion).
  const suggestedDte = disc.expiryCadences.includes('daily') ? 0 : 1;
  console.log(`  discovered ${symbol}: assetClass=${disc.assetClass} → class=${cls} SI=${si} prefix=${prefix} polyTk=${polyTk} band=±$${band}`);
  console.log(`  expiry cadences: ${disc.expiryCadences.join(', ')} → suggested DTE=${suggestedDte} (onboarding at --dte ${dte})`);
  if (suggestedDte !== dte) console.log(`  ⚠ requested --dte ${dte} differs from cadence-suggested ${suggestedDte}`);
  for (const w of disc.warnings) console.log(`  ⚠ ${w}`);
  console.log(`  registered ${symbol}-${dte}dte via discovery`);
  return p;
}
function loadRegistry(): RegProfile[] {
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).profiles;
}
function saveRegistry(profiles: RegProfile[]) {
  const j = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  j.profiles = profiles;
  fs.writeFileSync(REGISTRY, JSON.stringify(j, null, 2) + '\n');
}

// All files owned by a profile (suffix from outPath). SPX suffix '' .
function profilePaths(t: SymbolTarget) {
  const sweep  = outPath(path.join(OUT_DIR, 'spread-sweep.json'), t);
  const daily  = outPath(path.join(OUT_DIR, 'spread-daily.json'), t);
  const hourly = outPath(path.join(OUT_DIR, 'spread-hourly.json'), t);
  const risk   = outPath(path.join(OUT_DIR, 'risk-analysis.json'), t);
  const tmpSweep = outPath('/tmp/credit_spread_sweep.json', t);
  const tmpDaily = outPath('/tmp/credit_spread_daily.json', t);
  return { sweep, daily, hourly, risk, tmpSweep, tmpDaily,
           all: [sweep, daily, hourly, risk, tmpSweep, tmpDaily],
           barsDir: path.join(ROOT, 'data/parquet/bars', t.profileId) };
}

function isProtected(t: SymbolTarget): boolean {
  // SPX-0dte (suffix '') OR registry protected flag.
  if (t.outSuffix === '') return true;
  const reg = loadRegistry().find(p => p.symbol === t.symbol && p.dte === t.dte);
  return !!(reg && reg.protected);
}

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

function run(script: string, args: string[], env: Record<string, string> = {}) {
  console.log(`  $ tsx ${script} ${args.join(' ')}${env.SWEEP_DAYS ? `  (SWEEP_DAYS=${env.SWEEP_DAYS})` : ''}`);
  execFileSync('npx', ['tsx', path.join(ROOT, script), ...args], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env },
  });
}

// ── trading-day gap detection (weekday-only; holidays not modeled) ───────────
function listMissingWeekdays(dates: string[]): string[] {
  if (dates.length < 2) return [];
  const have = new Set(dates);
  const miss: string[] = [];
  const d = new Date(dates[0] + 'T12:00:00Z');
  const end = new Date(dates[dates.length - 1] + 'T12:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const s = d.toISOString().slice(0, 10);
      if (!have.has(s)) miss.push(s);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return miss;
}

// ── illegal / stale sweep-row geometry ──────────────────────────────────────
// ETF directional butterflies max wing = 3 strikes, static = 5 (sweep-symbol
// DIR_WING_S=[1,2,3], WING_WIDTHS_S=[1..5] for ETF). Anything wider == a stale
// pre-fix row that the old isIron bug failed to purge.
function illegalRows(rows: any[], t: SymbolTarget): { spread: string; n: number }[] {
  const etf = t.symbol === 'SPY' || t.symbol === 'QQQ';
  if (!etf) return [];
  const bad = new Map<string, number>();
  for (const r of rows) {
    const s: string = r.spread || '';
    let m;
    if ((m = /^IB±\d+ w(\d+)$/.exec(s)) && +m[1] > 3 * t.strikeInterval) bad.set(s, (bad.get(s) || 0) + 1);
    else if ((m = /^IB w(\d+)$/.exec(s)) && +m[1] > 5 * t.strikeInterval) bad.set(s, (bad.get(s) || 0) + 1);
  }
  return [...bad].map(([spread, n]) => ({ spread, n }));
}

function statusLine(t: SymbolTarget): string {
  const p = profilePaths(t);
  const dates = listDatesFor(t);
  const gaps = listMissingWeekdays(dates);
  let sweepN = 0, iron = 0, credit = 0, illegal = 0, riskN = 0;
  if (fs.existsSync(p.sweep)) {
    try {
      const rows = JSON.parse(fs.readFileSync(p.sweep, 'utf8'));
      sweepN = rows.length;
      iron = rows.filter((r: any) => /^I[BC]/.test(r.spread)).length;
      credit = sweepN - iron;
      illegal = illegalRows(rows, t).reduce((a, b) => a + b.n, 0);
    } catch {}
  }
  if (fs.existsSync(p.risk)) { try { riskN = Object.keys(JSON.parse(fs.readFileSync(p.risk, 'utf8'))).length; } catch {} }
  const dr = dates.length ? `${dates[0]}..${dates[dates.length - 1]}` : '(none)';
  return `${(t.symbol + '-' + t.dte + 'dte').padEnd(9)} ${isProtected(t) ? '🔒' : '  '} `
    + `bars=${String(dates.length).padStart(4)} ${dr} gaps=${gaps.length} | `
    + `sweep=${sweepN} (iron ${iron}/credit ${credit}${illegal ? `, ⚠ ${illegal} STALE` : ''}) risk=${riskN}`;
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdList() {
  console.log('Registry & per-profile status:\n');
  for (const reg of loadRegistry()) {
    const t = resolveSymbolTarget(['--symbol', reg.symbol, '--dte', String(reg.dte)]);
    console.log('  ' + statusLine(t));
  }
}

function cmdVerify(t: SymbolTarget): boolean {
  console.log(`\n── verify ${t.symbol}-${t.dte}dte ──`);
  const p = profilePaths(t);
  const dates = listDatesFor(t);
  const gaps = listMissingWeekdays(dates);
  let ok = true;
  console.log(`  parquet days: ${dates.length} ${dates.length ? `(${dates[0]}..${dates[dates.length - 1]})` : ''}`);
  if (!dates.length) { console.log('  ✗ NO parquet bars'); ok = false; }
  if (gaps.length) { console.log(`  ⚠ ${gaps.length} weekday gaps (first: ${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? '…' : ''})`); }
  if (!fs.existsSync(p.sweep)) { console.log('  ✗ no sweep output'); ok = false; }
  else {
    const rows = JSON.parse(fs.readFileSync(p.sweep, 'utf8'));
    const iron = rows.filter((r: any) => /^I[BC]/.test(r.spread)).length;
    console.log(`  sweep rows: ${rows.length} (iron ${iron} / credit ${rows.length - iron})`);
    const ill = illegalRows(rows, t);
    if (ill.length) {
      ok = false;
      console.log(`  ✗ ${ill.reduce((a, b) => a + b.n, 0)} STALE/illegal-geometry rows: ${ill.slice(0, 6).map(x => `${x.spread}×${x.n}`).join(', ')}`);
      console.log('    → run: sweep-manager execute (clean regen purges these)');
    } else console.log('  ✓ geometry clean (no stale rows)');
  }
  console.log(`  risk-analysis: ${fs.existsSync(p.risk) ? Object.keys(JSON.parse(fs.readFileSync(p.risk, 'utf8'))).length + ' variants' : '✗ missing'}`);
  console.log(ok ? '  RESULT: PASS' : '  RESULT: FAIL');
  return ok;
}

// Deletes ONLY this resolved target's namespaced files. SPX (suffix '') is
// reachable only when the caller explicitly passed --symbol SPX; an ETF/equity
// target's suffix ('-spy-1dte', '-qqq-1dte', '-nvda', …) can never collide
// with SPX's unsuffixed paths, so working on one ticker provably cannot delete
// another's data. --dry-run prints the exact file set and deletes nothing.
function cleanSlate(t: SymbolTarget) {
  const p = profilePaths(t);
  const files = [p.sweep, p.daily, p.hourly, p.risk, p.tmpSweep, p.tmpDaily];
  // Defensive invariant: every path must carry this target's suffix (or be the
  // SPX unsuffixed set ONLY when this target IS SPX). Guards against any future
  // path-derivation regression silently crossing tickers.
  const sfx = t.outSuffix;
  for (const f of files) {
    const base = path.basename(f);
    const crosses = sfx
      ? !base.includes(sfx)                                  // ETF/equity: must contain its suffix
      : /-(spy|qqq|ndx|nvda|tsla|mu|avgo|iwm)/.test(base);   // SPX: must NOT contain another ticker's
    if (crosses) throw new Error(`SAFETY ABORT: ${base} is not in ${t.symbol}-${t.dte}dte's scope (suffix '${sfx || '∅'}'). Refusing to delete cross-ticker data.`);
  }
  console.log(`  scope = ${t.symbol}-${t.dte}dte ONLY (suffix '${sfx || '∅ = SPX-unsuffixed'}')`);
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    if (hasFlag('dry-run')) { console.log(`  [dry-run] would rm ${f}`); continue; }
    fs.unlinkSync(f); console.log(`  rm ${f}`);
  }
}

function cmdExecute(t: SymbolTarget) {
  const days = arg('days');
  const env = days ? { SWEEP_DAYS: String(days) } : {};
  console.log(`\n── execute ${t.symbol}-${t.dte}dte ${days ? `(last ${days} days)` : '(full history)'} ──`);
  console.log('  [clean slate]');
  cleanSlate(t);
  if (hasFlag('dry-run')) { console.log('  [dry-run] would run credit→iron→long→curate→concurrent-distribution; stopping.'); return; }
  const sym = ['--symbol', t.symbol, '--dte', String(t.dte)];
  // long-sweep refuses SPX (its legacy last-run.json is owned by the Backtest
  // Studio /api/run). For ETF/other profiles it's a full pipeline peer.
  const doLong = t.outSuffix !== '' && !hasFlag('no-long');
  console.log('  [1/5] credit-spread sweep');     run('scripts/diag/credit-spread-sweep.ts', sym, env);
  console.log('  [2/5] iron sweep');               run('scripts/diag/iron-sweep.ts', sym, env);
  if (doLong) { console.log('  [3/5] long sweep'); run('scripts/diag/long-sweep.ts', sym, env); }
  else console.log(`  [3/5] long sweep — SKIP (${hasFlag('no-long') ? '--no-long' : 'SPX legacy last-run.json owned by Backtest Studio'})`);
  console.log('  [4/5] curate risk targets');      run('scripts/diag/curate-risk-targets.ts', sym, env);
  console.log('  [5/5] concurrent-distribution');  run('scripts/diag/concurrent-distribution.ts', sym, env);
  console.log(`  ✓ ${t.symbol}-${t.dte}dte execute complete`);
  cmdVerify(t);
}

function cmdValidate(t: SymbolTarget): boolean {
  const days = arg('days') || '10';
  console.log(`\n── validate ${t.symbol}-${t.dte}dte (SWEEP_DAYS=${days}, exact-match proof) ──`);
  cmdExecute(t); // clean small run via --days (reuses argv)
  // Pull top HMA iron + credit TP-only variants, feed EXACT specs to cd, assert match.
  const p = profilePaths(t);
  const rows = JSON.parse(fs.readFileSync(p.sweep, 'utf8'));
  const pick = (f: (r: any) => boolean) => rows.filter(f).sort((a: any, b: any) => b.n - a.n)[0];
  const iron = pick((r: any) => /^HMA/.test(r.signal) && /^IB/.test(r.spread) && /^TP\d+ only$/.test(r.exit) && r.n >= 3);
  const cred = pick((r: any) => /^HMA/.test(r.signal) && /(ITM|OTM|ATM) w\d/.test(r.spread) && /^TP\d+ only$/.test(r.exit) && r.n >= 3);
  const parse = (sig: string, sp: string, ex: string) => {
    const sm = /^(HMA)\s+([0-9+m]+)\s+(\d+)x(\d+)$/.exec(sig); if (!sm) return null;
    const tf = sm[2].replace(/m/g, '').split('+').map(Number);
    let kind: any = null, co = 0, so = 0, ww = 0, w = 0, m;
    if ((m = /^IB(?:±(\d+))?\s+w(\d+)$/.exec(sp))) { kind = 'iron'; co = m[1] ? +m[1] : 0; ww = +m[2]; }
    else if ((m = /^IC\s+(\d+)w(\d+)$/.exec(sp))) { kind = 'iron'; so = +m[1]; ww = +m[2]; }
    else if ((m = /^(?:(\d+)(ITM|OTM)|ATM)\s+w(\d+)$/.exec(sp))) { kind = 'spread'; so = m[1] ? +m[1] * (m[2] === 'ITM' ? -1 : 1) : 0; w = +m[3]; }
    else return null;
    const em = /^TP(\d+)\s*only$/.exec(ex); if (!em) return null;
    return { label: `${sig}|${sp}|${ex}`, hmaFast: +sm[3], hmaSlow: +sm[4], timeframes: tf, kind, centerOffset: co, shortOffset: so, wingWidth: ww, width: w, tpFrac: +em[1] / 100, slMult: 0 };
  };
  const targets = [iron, cred].filter(Boolean).map((r: any) => parse(r.signal, r.spread, r.exit)).filter(Boolean);
  if (!targets.length) { console.log('  ✗ no comparable HMA TP-only variant produced'); return false; }
  run('scripts/diag/concurrent-distribution.ts', ['--symbol', t.symbol, '--dte', String(t.dte)],
      { SWEEP_DAYS: days, RISK_TARGETS_INLINE: JSON.stringify(targets) });
  const ra = JSON.parse(fs.readFileSync(p.risk, 'utf8'));
  let pass = true;
  for (const r of [iron, cred].filter(Boolean) as any[]) {
    const key = `${r.signal}|${r.spread}|${r.exit}`;
    const u = ra[key]?.capResults?.uncap;
    if (!u) { console.log(`  ✗ ${key}: no recompute row`); pass = false; continue; }
    const nOk = r.n === u.n;
    const pOk = Math.abs(r.pnl - u.cumPnl) < 1.0;            // dollar-exact
    console.log(`  ${key}`);
    console.log(`    sweep  n=${r.n} pnl=$${r.pnl.toFixed(0)}`);
    console.log(`    recomp n=${u.n} cum=$${u.cumPnl}`);
    console.log(`    => n ${nOk ? 'MATCH' : 'MISMATCH'} | pnl ${pOk ? 'MATCH' : 'MISMATCH'}`);
    if (!nOk || !pOk) pass = false;
  }
  console.log(pass ? '  ✓ VALIDATE PASS — recompute is faithful to the sweep' : '  ✗ VALIDATE FAIL');
  return pass;
}

function cmdBackfill(t: SymbolTarget) {
  const days = parseInt(arg('days') || '0', 10);
  if (!days) throw new Error('backfill requires --days K');
  // Most-recent K weekdays ending today (holidays skipped by the backfill itself).
  const out: string[] = [];
  const d = new Date();
  while (out.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  console.log(`\n── backfill ${t.profileId}: ${days} days (${out[out.length - 1]}..${out[0]}) ──`);
  for (const date of out.reverse()) {
    try { run('scripts/backfill/backfill-replay-options.ts', [date, `--profile=${t.profileId}`]); }
    catch (e: any) { console.log(`  ⚠ ${date} backfill failed: ${e.message}`); }
  }
}

function cmdDelete(t: SymbolTarget) {
  const barDate = arg('date');
  if (hasFlag('bars') && barDate) {
    const f = path.join(profilePaths(t).barsDir, `${barDate}.parquet`);
    // Source-of-truth parquet — guarded for EVERY ticker (expensive to
    // re-backfill), not SPX-specially. --yes to confirm.
    if (!hasFlag('yes')) throw new Error(`deleting source bars ${t.profileId}/${barDate} — re-run with --yes to confirm`);
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`rm ${f}`); } else console.log(`(absent) ${f}`);
    return;
  }
  console.log(`\n── delete outputs ${t.symbol}-${t.dte}dte ──`);
  cleanSlate(t);
}

function cmdOnboard(t: SymbolTarget) {
  // Entry already ensured in dispatch (so resolveSymbolTarget could resolve a
  // brand-new symbol). Now: backfill → verify → validate → execute.
  ensureRegistered(t.symbol, t.dte); // idempotent — no-op if already present
  cmdBackfill(t);
  if (!cmdVerify(t)) console.log('  (verify flagged issues — continuing; execute will regen clean)');
  cmdExecute(t);
}

// ── dispatch ────────────────────────────────────────────────────────────────
const cmd = process.argv[2];
// One or MANY tickers per invocation, all independently scoped:
//   --all                         every non-protected registry profile
//   --symbol SPY,QQQ --dte 1       both at dte 1
//   --symbol SPY:1,QQQ:1,NVDA:0    explicit per-symbol dte (':' overrides --dte)
// Each resolves to its own namespaced file set — multi-ticker never crosses.
function profilesFromArgs(): SymbolTarget[] {
  if (hasFlag('all')) {
    return loadRegistry()
      .filter(p => !p.protected || hasFlag('force-spx'))
      .map(p => resolveSymbolTarget(['--symbol', p.symbol, '--dte', String(p.dte)]));
  }
  const raw = arg('symbol');
  const defDte = arg('dte');
  if (raw && raw.includes(',')) {
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(tok => {
      const [sym, dte] = tok.split(':');
      const a = ['--symbol', sym, '--dte', String(dte ?? defDte ?? 0)];
      return resolveSymbolTarget(a);
    });
  }
  return [resolveSymbolTarget(process.argv)];
}

(async () => {
  // onboard must register the (possibly brand-new) symbol BEFORE
  // profilesFromArgs() → resolveSymbolTarget runs, else a ticker absent from
  // both BASES and the registry can never resolve. discoverAndRegister() pulls
  // the real chain metadata from Polygon (heuristic fallback if offline).
  if (cmd === 'onboard') {
    const raw = arg('symbol'); const dte = parseInt(arg('dte') || '0', 10);
    if (!raw) throw new Error('onboard requires --symbol X --dte N [--days K]');
    for (const tok of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      const [sym, d] = tok.split(':');
      await discoverAndRegister(sym.toUpperCase(), parseInt(d ?? String(dte), 10));
    }
  }
  if (cmd === 'list') cmdList();
  else if (cmd === 'verify')   { let ok = true; for (const t of profilesFromArgs()) ok = cmdVerify(t) && ok; process.exit(ok ? 0 : 1); }
  else if (cmd === 'validate') { let ok = true; for (const t of profilesFromArgs()) ok = cmdValidate(t) && ok; process.exit(ok ? 0 : 1); }
  else if (cmd === 'execute')  { for (const t of profilesFromArgs()) cmdExecute(t); }
  else if (cmd === 'backfill') { for (const t of profilesFromArgs()) cmdBackfill(t); }
  else if (cmd === 'delete')   { for (const t of profilesFromArgs()) cmdDelete(t); }
  else if (cmd === 'onboard')  { for (const t of profilesFromArgs()) cmdOnboard(t); }
  else {
    console.log('Usage: sweep-manager <list|verify|validate|execute|backfill|delete|onboard> --symbol X --dte N [--days K] [--all] [--force-spx]');
    console.log('Vendor: Polygon only (ThetaData removed 2026-05-17). New-ticker onboarding IS supported:');
    console.log('  onboard --symbol IWM --dte 1 --days 60   (Polygon discovery auto-fills class/SI/prefix/band)');
    console.log('  overrides: --class --strike-interval --option-prefix --underlying-ticker --band');
    process.exit(2);
  }
})().catch((e: any) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
