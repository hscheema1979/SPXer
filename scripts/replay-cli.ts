#!/usr/bin/env npx tsx
/**
 * Replay CLI — interactive tool for managing configs and running replays.
 *
 * Usage:
 *   npx tsx scripts/replay-cli.ts list                    # List all configs
 *   npx tsx scripts/replay-cli.ts show <config-id>        # Show config details
 *   npx tsx scripts/replay-cli.ts create                  # Interactive config creation
 *   npx tsx scripts/replay-cli.ts run <config-id> --start 2026-03-16 --end 2026-03-24
 *   npx tsx scripts/replay-cli.ts run <config-id> --date 2026-03-24
 *   npx tsx scripts/replay-cli.ts seed                    # Seed defaults + HMA strategy
 *   npx tsx scripts/replay-cli.ts results <config-id>     # Show past results
 *   npx tsx scripts/replay-cli.ts delete <config-id>      # Delete a config
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as readline from 'readline';
import Database from 'better-sqlite3';
import * as path from 'path';
import { ConfigManager } from '../src/config/manager';
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../src/config/defaults';
import { seedDefaults } from '../src/config/seed';
import { runReplay } from '../src/replay/machine';
import { ReplayStore } from '../src/replay/store';
import type { Config } from '../src/config/types';
import type { Trade, ReplayResult } from '../src/replay/types';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

function getManager(): ConfigManager {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return new ConfigManager(db);
}

function getStore(): ReplayStore {
  return new ReplayStore(DB_PATH);
}

// ── readline prompt helper ────────────────────────────────────────────────

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const prompt = defaultVal != null ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      resolve(answer.trim() || (defaultVal ?? ''));
    });
  });
}

// ── Available dates ────────────────────────────────────────────────────────

function getAvailableDates(): string[] {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT DISTINCT date(ts, 'unixepoch') as d
    FROM bars WHERE symbol='SPX' AND timeframe='1m'
    GROUP BY d HAVING COUNT(*) > 100 ORDER BY d
  `).all() as any[];
  db.close();
  return rows.map(r => r.d);
}

// ── Commands ──────────────────────────────────────────────────────────────

function cmdSeed() {
  const mgr = getManager();
  seedDefaults(mgr);

  // Also seed the HMA strategy config
  const hmaConfig: Config = mergeConfig(DEFAULT_CONFIG, {
    id: 'hma-otm25-tp3',
    name: 'HMA Cross | ±$25 OTM | TP 3x | No SL',
    description: 'HMA5×HMA19 cross on options + underlying. Only trade strike closest to ±$25 OTM. TP 3x entry, no stop loss (close on signal reversal). Max 20 trades/day. No entries within 30min of close.',
    signals: {
      ...DEFAULT_CONFIG.signals,
      enableRsiCrosses: false,
      enableHmaCrosses: true,
      enablePriceCrossHma: false,
      enableEmaCrosses: false,
      requireUnderlyingHmaCross: true,
      targetOtmDistance: 25,
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: 0,
      takeProfitMultiplier: 3,
    },
    risk: {
      ...DEFAULT_CONFIG.risk,
      maxTradesPerDay: 20,
    },
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeEnd: '15:15',
    },
    regime: { ...DEFAULT_CONFIG.regime, enabled: false, mode: 'disabled' as const },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
    judges: { ...DEFAULT_CONFIG.judges, enabled: false },
  });
  mgr.saveConfig(hmaConfig);

  console.log('Seeded defaults: models, prompts, configs.');
  console.log('Configs in DB:');
  for (const c of mgr.listConfigs()) {
    console.log(`  ${c.id.padEnd(25)} ${c.name}`);
  }
}

function cmdList() {
  const mgr = getManager();
  const configs = mgr.listConfigs();

  if (configs.length === 0) {
    console.log('No configs in DB. Run: npx tsx scripts/replay-cli.ts seed');
    return;
  }

  console.log(`\n${'ID'.padEnd(30)} ${'Name'.padEnd(45)} Description`);
  console.log('─'.repeat(120));
  for (const c of configs) {
    const desc = (c.description || '').slice(0, 60);
    console.log(`${c.id.padEnd(30)} ${(c.name || '').padEnd(45)} ${desc}`);
  }
  console.log(`\n${configs.length} config(s) total.\n`);
}

function cmdShow(configId: string) {
  const mgr = getManager();
  const config = mgr.getConfig(configId);
  if (!config) {
    console.error(`Config '${configId}' not found.`);
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${config.name} (${config.id})`);
  console.log(`${'═'.repeat(72)}`);
  if (config.description) console.log(`  ${config.description}\n`);

  console.log('  SIGNALS:');
  console.log(`    RSI crosses:       ${config.signals.enableRsiCrosses}`);
  console.log(`    HMA crosses:       ${config.signals.enableHmaCrosses}`);
  console.log(`    Price cross HMA:   ${config.signals.enablePriceCrossHma}`);
  console.log(`    EMA crosses:       ${config.signals.enableEmaCrosses}`);
  console.log(`    Require SPX HMA:   ${config.signals.requireUnderlyingHmaCross}`);
  console.log(`    Target OTM dist:   ${config.signals.targetOtmDistance != null ? '±$' + config.signals.targetOtmDistance : 'any'}`);
  console.log(`    Target price:      ${config.signals.targetContractPrice != null ? '$' + config.signals.targetContractPrice.toFixed(2) : 'any'}`);
  console.log(`    RSI thresholds:    ${config.signals.rsiOversold}/${config.signals.rsiOverbought}`);
  console.log(`    Opt RSI:           ${config.signals.optionRsiOversold}/${config.signals.optionRsiOverbought}`);

  console.log('\n  POSITION:');
  console.log(`    Stop loss:         ${config.position.stopLossPercent === 0 ? 'disabled (signal reversal)' : config.position.stopLossPercent + '%'}`);
  console.log(`    Take profit:       ${config.position.takeProfitMultiplier}x entry`);
  console.log(`    Max positions:     ${config.position.maxPositionsOpen}`);

  console.log('\n  RISK:');
  console.log(`    Max daily loss:    $${config.risk.maxDailyLoss}`);
  console.log(`    Max trades/day:    ${config.risk.maxTradesPerDay}`);
  console.log(`    Max risk/trade:    $${config.risk.maxRiskPerTrade}`);

  console.log('\n  TIME:');
  console.log(`    Active window:     ${config.timeWindows.activeStart} - ${config.timeWindows.activeEnd} ET`);
  console.log(`    Session:           ${config.timeWindows.sessionStart} - ${config.timeWindows.sessionEnd} ET`);

  console.log('\n  PIPELINE:');
  console.log(`    Timeframe:         ${config.pipeline.timeframe}`);
  console.log(`    Strike band:       ±$${config.strikeSelector.strikeSearchRange}`);

  console.log('\n  MODELS:');
  console.log(`    Scanners:          ${config.scanners.enabled ? config.scanners.models.join(', ') || 'none selected' : 'disabled'}`);
  console.log(`    Judges:            ${config.judges.enabled ? config.judges.models.join(', ') || 'none selected' : 'disabled'}`);
  console.log(`    Regime:            ${config.regime.enabled ? config.regime.mode : 'disabled'}`);

  console.log('\n  SIZING:');
  console.log(`    Per trade:         $${config.sizing.baseDollarsPerTrade}`);
  console.log(`    Min/max contracts: ${config.sizing.minContracts}-${config.sizing.maxContracts}`);
  console.log('');
}

async function cmdCreate() {
  const rl = createRl();
  const mgr = getManager();

  console.log('\n  Create New Config');
  console.log('  ─────────────────');
  console.log('  Press Enter to accept defaults shown in [brackets].\n');

  // Basic info
  const id = await ask(rl, '  Config ID (slug)', '');
  if (!id) { console.log('  ID required.'); rl.close(); return; }
  const name = await ask(rl, '  Name', id);
  const description = await ask(rl, '  Description', '');

  // Base config
  const existingConfigs = mgr.listConfigs();
  let baseId = 'default';
  if (existingConfigs.length > 0) {
    console.log(`\n  Available base configs: ${existingConfigs.map(c => c.id).join(', ')}`);
    baseId = await ask(rl, '  Base config to derive from', 'default');
  }
  const base = mgr.getConfig(baseId) || DEFAULT_CONFIG;

  // Signals
  console.log('\n  ── Signals ──');
  const enableRsi = (await ask(rl, '  Enable RSI crosses', String(base.signals.enableRsiCrosses))).toLowerCase();
  const enableHma = (await ask(rl, '  Enable HMA crosses (HMA5×HMA19)', String(base.signals.enableHmaCrosses))).toLowerCase();
  const enablePriceHma = (await ask(rl, '  Enable Price cross HMA', String(base.signals.enablePriceCrossHma))).toLowerCase();
  const enableEma = (await ask(rl, '  Enable EMA crosses', String(base.signals.enableEmaCrosses))).toLowerCase();
  const requireSpxHma = (await ask(rl, '  Require underlying SPX HMA cross', String(base.signals.requireUnderlyingHmaCross))).toLowerCase();
  const otmDistStr = await ask(rl, '  Target OTM distance ($ or "any")', base.signals.targetOtmDistance != null ? String(base.signals.targetOtmDistance) : 'any');
  const contractPriceStr = await ask(rl, '  Target contract price ($ or "any")', base.signals.targetContractPrice != null ? String(base.signals.targetContractPrice) : 'any');
  const rsiOS = await ask(rl, '  RSI oversold', String(base.signals.rsiOversold));
  const rsiOB = await ask(rl, '  RSI overbought', String(base.signals.rsiOverbought));
  const optRsiOS = await ask(rl, '  Option RSI oversold', String(base.signals.optionRsiOversold));
  const optRsiOB = await ask(rl, '  Option RSI overbought', String(base.signals.optionRsiOverbought));

  // Position
  console.log('\n  ── Position ──');
  const slPct = await ask(rl, '  Stop loss % (0=disabled, use signal reversal)', String(base.position.stopLossPercent));
  const tpMult = await ask(rl, '  Take profit multiplier (e.g. 3 = 3x entry)', String(base.position.takeProfitMultiplier));
  const maxPos = await ask(rl, '  Max positions open', String(base.position.maxPositionsOpen));

  // Risk
  console.log('\n  ── Risk ──');
  const maxLoss = await ask(rl, '  Max daily loss ($)', String(base.risk.maxDailyLoss));
  const maxTrades = await ask(rl, '  Max trades per day', String(base.risk.maxTradesPerDay));

  // Time
  console.log('\n  ── Time ──');
  const activeStart = await ask(rl, '  Active start (HH:MM ET)', base.timeWindows.activeStart);
  const activeEnd = await ask(rl, '  Active end (HH:MM ET)', base.timeWindows.activeEnd);

  // Pipeline
  console.log('\n  ── Pipeline ──');
  const timeframe = await ask(rl, '  Timeframe (1m/3m/5m/10m/15m/1h)', base.pipeline.timeframe);
  const strikeRange = await ask(rl, '  Strike search range ($)', String(base.strikeSelector.strikeSearchRange));

  // Models
  console.log('\n  ── Models ──');
  const availableModels = mgr.listModels();
  if (availableModels.length > 0) {
    console.log(`  Available: ${availableModels.map(m => `${m.id} (${m.role})`).join(', ')}`);
  }
  const scannersEnabled = (await ask(rl, '  Enable scanners', String(base.scanners.enabled))).toLowerCase();
  let scannerModels: string[] = [];
  if (scannersEnabled === 'true') {
    const sm = await ask(rl, '  Scanner model IDs (comma-separated)', base.scanners.models.join(','));
    scannerModels = sm.split(',').map(s => s.trim()).filter(Boolean);
  }
  const judgesEnabled = (await ask(rl, '  Enable judges', String(base.judges.enabled))).toLowerCase();
  let judgeModels: string[] = [];
  let activeJudge = base.judges.activeJudge;
  if (judgesEnabled === 'true') {
    const jm = await ask(rl, '  Judge model IDs (comma-separated)', base.judges.models.join(','));
    judgeModels = jm.split(',').map(s => s.trim()).filter(Boolean);
    activeJudge = await ask(rl, '  Active judge', judgeModels[0] || 'sonnet');
  }
  const regimeEnabled = (await ask(rl, '  Enable regime', String(base.regime.enabled))).toLowerCase();

  // Sizing
  console.log('\n  ── Sizing ──');
  const baseDollars = await ask(rl, '  Dollars per trade', String(base.sizing.baseDollarsPerTrade));
  const minContracts = await ask(rl, '  Min contracts', String(base.sizing.minContracts));
  const maxContracts = await ask(rl, '  Max contracts', String(base.sizing.maxContracts));

  rl.close();

  // Build config
  const toBool = (s: string) => s === 'true' || s === 'yes' || s === '1';
  const config: Config = mergeConfig(base, {
    id,
    name,
    description: description || undefined,
    baselineId: baseId !== 'default' ? baseId : undefined,
    signals: {
      ...base.signals,
      enableRsiCrosses: toBool(enableRsi),
      enableHmaCrosses: toBool(enableHma),
      enablePriceCrossHma: toBool(enablePriceHma),
      enableEmaCrosses: toBool(enableEma),
      requireUnderlyingHmaCross: toBool(requireSpxHma),
      targetOtmDistance: otmDistStr === 'any' ? null : parseInt(otmDistStr) || null,
      targetContractPrice: contractPriceStr === 'any' ? null : parseFloat(contractPriceStr) || null,
      rsiOversold: parseInt(rsiOS),
      rsiOverbought: parseInt(rsiOB),
      optionRsiOversold: parseInt(optRsiOS),
      optionRsiOverbought: parseInt(optRsiOB),
    },
    position: {
      ...base.position,
      stopLossPercent: parseInt(slPct),
      takeProfitMultiplier: parseFloat(tpMult),
      maxPositionsOpen: parseInt(maxPos),
    },
    risk: {
      ...base.risk,
      maxDailyLoss: parseInt(maxLoss),
      maxTradesPerDay: parseInt(maxTrades),
    },
    timeWindows: {
      ...base.timeWindows,
      activeStart,
      activeEnd,
    },
    pipeline: {
      ...base.pipeline,
      timeframe: timeframe as Config['pipeline']['timeframe'],
    },
    strikeSelector: {
      ...base.strikeSelector,
      strikeSearchRange: parseInt(strikeRange),
    },
    scanners: {
      ...base.scanners,
      enabled: toBool(scannersEnabled),
      models: scannerModels,
    },
    judges: {
      ...base.judges,
      enabled: toBool(judgesEnabled),
      models: judgeModels,
      activeJudge,
    },
    regime: {
      ...base.regime,
      enabled: toBool(regimeEnabled),
      mode: toBool(regimeEnabled) ? 'enforce' : 'disabled' as any,
    },
    sizing: {
      ...base.sizing,
      baseDollarsPerTrade: parseInt(baseDollars),
      minContracts: parseInt(minContracts),
      maxContracts: parseInt(maxContracts),
    },
  });

  const validation = validateConfig(config);
  if (!validation.valid) {
    console.log('\n  Validation errors:');
    for (const err of validation.errors) console.log(`    - ${err}`);
    console.log('  Config NOT saved.');
    return;
  }

  mgr.saveConfig(config);
  // Also save to replay_configs so ReplayStore can find it
  const store = getStore();
  store.saveConfig(config);
  store.close();

  console.log(`\n  Config '${id}' saved to DB.`);
  cmdShow(id);
}

async function cmdRun(configId: string, args: string[]) {
  const mgr = getManager();
  const config = mgr.getConfig(configId);
  if (!config) {
    console.error(`Config '${configId}' not found. Run 'list' to see available configs.`);
    process.exit(1);
  }

  // Also ensure it's in replay_configs
  const store = getStore();
  store.saveConfig(config);
  store.close();

  // Parse date args
  let dates: string[] = [];
  const dateIdx = args.indexOf('--date');
  const startIdx = args.indexOf('--start');
  const endIdx = args.indexOf('--end');
  const verboseFlag = args.includes('--verbose') || args.includes('-v');
  const noJudgeFlag = args.includes('--no-judge');
  const tfOverride = args.indexOf('--tf');

  // Override timeframe if provided
  let runConfig = config;
  if (tfOverride >= 0 && args[tfOverride + 1]) {
    runConfig = mergeConfig(config, {
      pipeline: { ...config.pipeline, timeframe: args[tfOverride + 1] as any },
    });
  }

  const availableDates = getAvailableDates();

  if (dateIdx >= 0 && args[dateIdx + 1]) {
    dates = [args[dateIdx + 1]];
  } else if (startIdx >= 0 && endIdx >= 0 && args[startIdx + 1] && args[endIdx + 1]) {
    const start = args[startIdx + 1];
    const end = args[endIdx + 1];
    dates = availableDates.filter(d => d >= start && d <= end);
  } else {
    // Default: show available dates and pick
    console.log(`\nAvailable dates: ${availableDates.join(', ')}`);
    const rl = createRl();
    const start = await ask(rl, 'Start date (YYYY-MM-DD)', availableDates[0]);
    const end = await ask(rl, 'End date (YYYY-MM-DD)', availableDates[availableDates.length - 1]);
    rl.close();
    dates = availableDates.filter(d => d >= start && d <= end);
  }

  if (dates.length === 0) {
    console.error('No dates selected or no data available for selected range.');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  Replay: ${config.name}`);
  console.log(`  Config: ${config.id} | TF: ${runConfig.pipeline.timeframe} | Dates: ${dates.length}`);
  console.log(`  ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`${'═'.repeat(72)}\n`);

  const allResults: ReplayResult[] = [];
  const allTrades: (Trade & { date: string })[] = [];

  for (const date of dates) {
    try {
      const result = await runReplay(runConfig, date, {
        verbose: verboseFlag,
        noJudge: noJudgeFlag || !config.judges.enabled,
      });
      allResults.push(result);

      const trades: Trade[] = JSON.parse(result.trades_json);
      for (const t of trades) allTrades.push({ ...t, date });

      // Per-day summary line
      const wr = result.trades > 0 ? `${(result.winRate * 100).toFixed(0)}%` : 'N/A';
      const pnlSign = result.totalPnl >= 0 ? '+' : '';
      console.log(`  ${date} | ${String(result.trades).padStart(2)} trades | WR ${wr.padStart(4)} | P&L ${pnlSign}$${result.totalPnl.toFixed(0).padStart(6)} | max win $${(result.maxWin || 0).toFixed(0)} | max loss $${(result.maxLoss || 0).toFixed(0)}`);
    } catch (err: any) {
      console.log(`  ${date} | ERROR: ${err.message}`);
    }
  }

  // ── Aggregate summary ────────────────────────────────────────────────────

  if (allResults.length === 0) {
    console.log('\nNo results.');
    return;
  }

  const totalTrades = allResults.reduce((s, r) => s + r.trades, 0);
  const totalWins = allResults.reduce((s, r) => s + r.wins, 0);
  const totalPnl = allResults.reduce((s, r) => s + r.totalPnl, 0);
  const avgDailyPnl = totalPnl / allResults.length;
  const winDays = allResults.filter(r => r.totalPnl > 0).length;
  const maxDayWin = Math.max(...allResults.map(r => r.totalPnl));
  const maxDayLoss = Math.min(...allResults.map(r => r.totalPnl));

  console.log(`\n${'═'.repeat(72)}`);
  console.log('  AGGREGATE RESULTS');
  console.log(`${'═'.repeat(72)}`);
  console.log(`  Days tested:       ${allResults.length}`);
  console.log(`  Win days:          ${winDays}/${allResults.length} (${(winDays / allResults.length * 100).toFixed(0)}%)`);
  console.log(`  Total trades:      ${totalTrades}`);
  console.log(`  Total wins:        ${totalWins} (${totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(0) : 0}%)`);
  console.log(`  Total P&L:         $${totalPnl.toFixed(0)}`);
  console.log(`  Avg daily P&L:     $${avgDailyPnl.toFixed(0)}`);
  console.log(`  Best day:          $${maxDayWin.toFixed(0)}`);
  console.log(`  Worst day:         $${maxDayLoss.toFixed(0)}`);

  // ── Trade detail table ────────────────────────────────────────────────────

  if (allTrades.length > 0) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log('  ALL TRADES');
    console.log(`${'─'.repeat(72)}`);
    console.log(`  ${'Date'.padEnd(12)} ${'Side'.padEnd(5)} ${'Strike'.padEnd(7)} ${'Entry'.padEnd(14)} ${'Exit'.padEnd(14)} ${'Entry$'.padEnd(9)} ${'Exit$'.padEnd(9)} ${'P&L%'.padEnd(8)} ${'P&L$'.padEnd(8)} Reason`);
    console.log(`  ${'─'.repeat(108)}`);

    for (const t of allTrades) {
      const pnlSign = t.pnlPct >= 0 ? '+' : '';
      const dollarSign = t.pnl$ >= 0 ? '+' : '';
      console.log(
        `  ${t.date.padEnd(12)} ${t.side.padEnd(5)} ${String(t.strike).padEnd(7)} ${t.entryET.padEnd(14)} ${t.exitET.padEnd(14)} $${t.entryPrice.toFixed(2).padStart(7)} $${t.exitPrice.toFixed(2).padStart(7)} ${(pnlSign + t.pnlPct.toFixed(0) + '%').padStart(7).padEnd(8)} ${(dollarSign + '$' + t.pnl$.toFixed(0)).padEnd(8)} ${t.reason}`
      );
    }
  }

  // ── Exit reason breakdown ─────────────────────────────────────────────────

  const reasons: Record<string, { count: number; pnl: number }> = {};
  for (const t of allTrades) {
    if (!reasons[t.reason]) reasons[t.reason] = { count: 0, pnl: 0 };
    reasons[t.reason].count++;
    reasons[t.reason].pnl += t.pnl$;
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log('  EXIT REASON BREAKDOWN');
  console.log(`${'─'.repeat(72)}`);
  for (const [reason, data] of Object.entries(reasons)) {
    console.log(`  ${reason.padEnd(20)} ${String(data.count).padStart(4)} trades  P&L: $${data.pnl.toFixed(0)}`);
  }
  console.log('');
}

function cmdResults(configId: string) {
  const store = getStore();
  const results = store.getResultsByConfig(configId);
  store.close();

  if (results.length === 0) {
    console.log(`No results found for config '${configId}'.`);
    return;
  }

  console.log(`\nResults for config: ${configId}\n`);
  console.log(`${'Date'.padEnd(12)} ${'Trades'.padEnd(8)} ${'Wins'.padEnd(6)} ${'WR'.padEnd(6)} ${'P&L'.padEnd(10)} ${'MaxWin'.padEnd(10)} ${'MaxLoss'.padEnd(10)}`);
  console.log('─'.repeat(72));

  let totalPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;

  for (const r of results) {
    const wr = r.trades > 0 ? `${(r.winRate * 100).toFixed(0)}%` : 'N/A';
    console.log(
      `${r.date.padEnd(12)} ${String(r.trades).padEnd(8)} ${String(r.wins).padEnd(6)} ${wr.padEnd(6)} $${r.totalPnl.toFixed(0).padStart(7).padEnd(10)} $${(r.maxWin || 0).toFixed(0).padStart(7).padEnd(10)} $${(r.maxLoss || 0).toFixed(0).padStart(7)}`
    );
    totalPnl += r.totalPnl;
    totalTrades += r.trades;
    totalWins += r.wins;
  }

  console.log('─'.repeat(72));
  const wr = totalTrades > 0 ? `${(totalWins / totalTrades * 100).toFixed(0)}%` : 'N/A';
  console.log(`${'TOTAL'.padEnd(12)} ${String(totalTrades).padEnd(8)} ${String(totalWins).padEnd(6)} ${wr.padEnd(6)} $${totalPnl.toFixed(0).padStart(7)}`);
  console.log('');
}

function cmdDelete(configId: string) {
  const mgr = getManager();
  const config = mgr.getConfig(configId);
  if (!config) {
    console.error(`Config '${configId}' not found.`);
    process.exit(1);
  }
  mgr.deleteConfig(configId);
  console.log(`Deleted config '${configId}' (${config.name}).`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help') {
    console.log(`
SPXer Replay CLI

Commands:
  seed                          Seed default configs, models, prompts into DB
  list                          List all configs
  show <config-id>              Show config details
  create                        Interactive config creation
  run <config-id> [options]     Run replay
  results <config-id>           Show past replay results
  delete <config-id>            Delete a config

Run options:
  --date <YYYY-MM-DD>           Single date
  --start <date> --end <date>   Date range
  --tf <1m|3m|5m|...>           Override timeframe
  --verbose / -v                Verbose per-bar output
  --no-judge                    Skip judge calls (deterministic only)
`);
    return;
  }

  switch (command) {
    case 'seed': cmdSeed(); break;
    case 'list': cmdList(); break;
    case 'show': cmdShow(args[1]); break;
    case 'create': await cmdCreate(); break;
    case 'run': await cmdRun(args[1], args.slice(2)); break;
    case 'results': cmdResults(args[1]); break;
    case 'delete': cmdDelete(args[1]); break;
    default:
      console.error(`Unknown command: ${command}. Run with --help for usage.`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
