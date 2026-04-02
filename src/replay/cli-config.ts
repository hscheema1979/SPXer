/**
 * CLI config builder — interactive or flag-based config for replay runs.
 * Works with the unified Config type from src/config/types.ts.
 */

import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../config/defaults';
import type { Config } from '../config/types';

// ── CLI flag parsing ───────────────────────────────────────────────────────

interface CliOverrides {
  dates?: string;
  noScanners?: boolean;
  strikeSearchRange?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  optionRsiOversold?: number;
  optionRsiOverbought?: number;
  stopLossPercent?: number;
  takeProfitMultiplier?: number;
  activeStart?: string;
  activeEnd?: string;
  cooldownSec?: number;
  maxDailyLoss?: number;
  enableHmaCrosses?: boolean;
  enableEmaCrosses?: boolean;
  hmaCrossFast?: number;
  hmaCrossSlow?: number;
  requireUnderlyingHmaCross?: boolean;
  targetOtmDistance?: number;
  contractPriceMax?: number;
  maxPositionsOpen?: number;
  exitStrategy?: string;
  label?: string;
}

export function parseCliFlags(args: string[]): CliOverrides {
  const flags: CliOverrides = {};

  for (const arg of args) {
    if (arg === '--no-scanners') { flags.noScanners = true; continue; }

    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (!match) continue;
    const [, key, val] = match;

    switch (key) {
      case 'dates': flags.dates = val; break;
      case 'strikeSearchRange': flags.strikeSearchRange = parseInt(val); break;
      case 'rsiOversold': flags.rsiOversold = parseInt(val); break;
      case 'rsiOverbought': flags.rsiOverbought = parseInt(val); break;
      case 'optionRsiOversold': flags.optionRsiOversold = parseInt(val); break;
      case 'optionRsiOverbought': flags.optionRsiOverbought = parseInt(val); break;
      case 'stopLossPercent': flags.stopLossPercent = parseFloat(val); break;
      case 'takeProfitMultiplier': flags.takeProfitMultiplier = parseFloat(val); break;
      case 'activeStart': flags.activeStart = val; break;
      case 'activeEnd': flags.activeEnd = val; break;
      case 'cooldownSec': flags.cooldownSec = parseInt(val); break;
      case 'maxDailyLoss': flags.maxDailyLoss = parseInt(val); break;
      case 'enableHmaCrosses': flags.enableHmaCrosses = val === 'true'; break;
      case 'enableEmaCrosses': flags.enableEmaCrosses = val === 'true'; break;
      case 'hmaCrossFast': flags.hmaCrossFast = parseInt(val); break;
      case 'hmaCrossSlow': flags.hmaCrossSlow = parseInt(val); break;
      case 'requireUnderlyingHmaCross': flags.requireUnderlyingHmaCross = val === 'true'; break;
      case 'targetOtmDistance': flags.targetOtmDistance = parseInt(val); break;
      case 'contractPriceMax': flags.contractPriceMax = parseFloat(val); break;
      case 'maxPositionsOpen': flags.maxPositionsOpen = parseInt(val); break;
      case 'exitStrategy': flags.exitStrategy = val; break;
      case 'label': flags.label = val; break;
    }
  }

  return flags;
}

/** Build a Config from defaults + CLI flag overrides. */
export function buildConfigFromFlags(flags: CliOverrides, base?: Config): Config {
  const config = base ? { ...base } : { ...DEFAULT_CONFIG };

  const overrides: Partial<Config> = {};

  if (flags.noScanners) {
    overrides.scanners = { ...config.scanners, enabled: false };
  }
  if (flags.strikeSearchRange !== undefined) {
    overrides.strikeSelector = { ...config.strikeSelector, strikeSearchRange: flags.strikeSearchRange };
  }
  if (flags.rsiOversold !== undefined || flags.rsiOverbought !== undefined) {
    overrides.signals = {
      ...config.signals,
      ...(flags.rsiOversold !== undefined && { rsiOversold: flags.rsiOversold }),
      ...(flags.rsiOverbought !== undefined && { rsiOverbought: flags.rsiOverbought }),
    };
  }
  if (flags.optionRsiOversold !== undefined || flags.optionRsiOverbought !== undefined) {
    overrides.signals = {
      ...(overrides.signals || config.signals),
      ...(flags.optionRsiOversold !== undefined && { optionRsiOversold: flags.optionRsiOversold }),
      ...(flags.optionRsiOverbought !== undefined && { optionRsiOverbought: flags.optionRsiOverbought }),
    };
  }
  if (
    flags.enableHmaCrosses !== undefined || flags.enableEmaCrosses !== undefined ||
    flags.hmaCrossFast !== undefined || flags.hmaCrossSlow !== undefined ||
    flags.requireUnderlyingHmaCross !== undefined || flags.targetOtmDistance !== undefined
  ) {
    overrides.signals = {
      ...(overrides.signals || config.signals),
      ...(flags.enableHmaCrosses !== undefined && { enableHmaCrosses: flags.enableHmaCrosses }),
      ...(flags.enableEmaCrosses !== undefined && { enableEmaCrosses: flags.enableEmaCrosses }),
      ...(flags.hmaCrossFast !== undefined && { hmaCrossFast: flags.hmaCrossFast }),
      ...(flags.hmaCrossSlow !== undefined && { hmaCrossSlow: flags.hmaCrossSlow }),
      ...(flags.requireUnderlyingHmaCross !== undefined && { requireUnderlyingHmaCross: flags.requireUnderlyingHmaCross }),
      ...(flags.targetOtmDistance !== undefined && { targetOtmDistance: flags.targetOtmDistance }),
    };
  }
  if (flags.contractPriceMax !== undefined) {
    overrides.strikeSelector = {
      ...(overrides.strikeSelector || config.strikeSelector),
      contractPriceMax: flags.contractPriceMax,
    };
  }
  if (flags.maxPositionsOpen !== undefined) {
    overrides.position = {
      ...(overrides.position || config.position),
      maxPositionsOpen: flags.maxPositionsOpen,
    };
  }
  if (flags.stopLossPercent !== undefined || flags.takeProfitMultiplier !== undefined) {
    overrides.position = {
      ...config.position,
      ...(flags.stopLossPercent !== undefined && { stopLossPercent: flags.stopLossPercent }),
      ...(flags.takeProfitMultiplier !== undefined && { takeProfitMultiplier: flags.takeProfitMultiplier }),
    };
  }
  if (flags.activeStart !== undefined || flags.activeEnd !== undefined) {
    overrides.timeWindows = {
      ...config.timeWindows,
      ...(flags.activeStart !== undefined && { activeStart: flags.activeStart }),
      ...(flags.activeEnd !== undefined && { activeEnd: flags.activeEnd }),
    };
  }
  if (flags.cooldownSec !== undefined) {
    overrides.judges = { ...config.judges, entryCooldownSec: flags.cooldownSec };
  }
  if (flags.maxDailyLoss !== undefined) {
    overrides.risk = { ...config.risk, maxDailyLoss: flags.maxDailyLoss };
  }
  if (flags.exitStrategy !== undefined) {
    overrides.exit = { ...config.exit, strategy: flags.exitStrategy as any };
  }
  if (flags.label) {
    overrides.id = flags.label;
    overrides.name = flags.label;
  }

  const merged = mergeConfig(config, overrides);

  const result = validateConfig(merged);
  if (!result.valid) {
    console.warn('Config validation warnings:');
    result.errors.forEach(e => console.warn(`  - ${e}`));
  }

  return merged;
}

/** Parse dates from CLI flag or return default dates. */
export function parseDates(flags: CliOverrides, defaultDates: string[]): string[] {
  if (flags.dates) {
    return flags.dates.split(',').map(d => d.trim());
  }
  return defaultDates;
}
