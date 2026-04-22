import type { Config } from '../config/types';

export interface ConfigField {
  key: string;
  label: string;
  value: unknown;
  type: 'boolean' | 'number' | 'string' | 'object' | 'array' | 'null';
}

export interface ConfigSection {
  title: string;
  fields: ConfigField[];
}

function fmt(value: unknown, key: string): ConfigField {
  let type: ConfigField['type'] = 'null';
  if (value === null || value === undefined) type = 'null';
  else if (typeof value === 'boolean') type = 'boolean';
  else if (typeof value === 'number') type = 'number';
  else if (typeof value === 'string') type = 'string';
  else if (Array.isArray(value)) type = 'array';
  else if (typeof value === 'object') type = 'object';

  const labels: Record<string, string> = {
    enableHmaCrosses: 'Enable HMA Crosses',
    hmaCrossFast: 'HMA Fast Period',
    hmaCrossSlow: 'HMA Slow Period',
    enableEmaCrosses: 'Enable EMA Crosses',
    emaCrossFast: 'EMA Fast Period',
    emaCrossSlow: 'EMA Slow Period',
    enableRsiCrosses: 'Enable RSI Crosses',
    rsiOversold: 'RSI Oversold',
    rsiOverbought: 'RSI Overbought',
    optionRsiOversold: 'Option RSI Oversold',
    optionRsiOverbought: 'Option RSI Overbought',
    requireUnderlyingHmaCross: 'Require Underlying HMA Cross',
    signalTimeframe: 'Signal Timeframe',
    directionTimeframe: 'Direction Timeframe',
    exitTimeframe: 'Exit Timeframe',
    allowedSides: 'Allowed Sides',
    reverseSignals: 'Reverse Signals',
    targetOtmDistance: 'Target OTM Distance',
    targetContractPrice: 'Target Contract Price',
    maxEntryPrice: 'Max Entry Price',
    stopLossPercent: 'Stop Loss %',
    takeProfitMultiplier: 'Take Profit Multiplier',
    maxPositionsOpen: 'Max Positions Open',
    defaultQuantity: 'Default Quantity',
    maxDailyLoss: 'Max Daily Loss',
    maxTradesPerDay: 'Max Trades/Day',
    maxRiskPerTrade: 'Max Risk/Trade',
    cutoffTimeET: 'Cutoff Time ET',
    maxSignalsPerSession: 'Max Signals/Session',
    intrabarTieBreaker: 'Intrabar Tie Breaker',
    strikeSearchRange: 'Strike Search Range',
    contractPriceMin: 'Contract Price Min',
    contractPriceMax: 'Contract Price Max',
    strikeMode: 'Strike Mode',
    atmOffset: 'ATM Offset',
    sessionStart: 'Session Start',
    sessionEnd: 'Session End',
    activeStart: 'Active Start',
    activeEnd: 'Active End',
    skipWeekends: 'Skip Weekends',
    skipHolidays: 'Skip Holidays',
    strategy: 'Exit Strategy',
    trailingStopEnabled: 'Trailing Stop',
    trailingStopPercent: 'Trailing Stop %',
    timeBasedExitEnabled: 'Time-Based Exit',
    timeBasedExitMinutes: 'Time Exit Minutes',
    exitPricing: 'Exit Pricing',
    sizingMode: 'Sizing Mode',
    sizingValue: 'Sizing Value',
    startingAccountValue: 'Starting Account Value',
    slippage: 'Slippage',
    participationRate: 'Participation Rate',
    minContracts: 'Min Contracts',
    spreadModel: 'Spread Model',
    slSlipPerContract: 'SL Slip/Contract',
    slSlipMax: 'SL Slip Max',
    entrySlipPerContract: 'Entry Slip/Contract',
    entrySlipMax: 'Entry Slip Max',
    slSpreadFactor: 'SL Spread Factor',
    slEodPenalty: 'SL EOD Penalty',
    slEodWindowMin: 'SL EOD Window (min)',
    mode: 'Mode',
    spreadFloor: 'Spread Floor',
    spreadPct: 'Spread %',
    reentryOnTakeProfit: 'Re-entry on TP',
    cooldownSec: 'Cooldown (s)',
    sizeMultiplier: 'Size Multiplier',
    requireOptionHmaConfirm: 'Require Option HMA Confirm',
    maxReentriesPerDay: 'Max Reentries/Day',
    maxReentriesPerSignal: 'Max Reentries/Signal',
  };

  return { key, label: labels[key] || key, value, type };
}

export function groupConfigSections(config: Config): ConfigSection[] {
  const s = config.signals ?? {};
  const p = config.position ?? {};
  const r = config.risk ?? {};
  const ss = config.strikeSelector ?? {};
  const tw = config.timeWindows ?? {};
  const ex = config.exit ?? {};
  const sz = config.sizing ?? {};
  const fl = config.fill;

  return [
    {
      title: 'Signals',
      fields: [
        fmt(s.enableHmaCrosses, 'enableHmaCrosses'),
        fmt(s.hmaCrossFast, 'hmaCrossFast'),
        fmt(s.hmaCrossSlow, 'hmaCrossSlow'),
        fmt(s.enableEmaCrosses, 'enableEmaCrosses'),
        fmt(s.emaCrossFast, 'emaCrossFast'),
        fmt(s.emaCrossSlow, 'emaCrossSlow'),
        fmt(s.enableRsiCrosses, 'enableRsiCrosses'),
        fmt(s.rsiOversold, 'rsiOversold'),
        fmt(s.rsiOverbought, 'rsiOverbought'),
        fmt(s.optionRsiOversold, 'optionRsiOversold'),
        fmt(s.optionRsiOverbought, 'optionRsiOverbought'),
        fmt(s.requireUnderlyingHmaCross, 'requireUnderlyingHmaCross'),
        fmt(s.signalTimeframe, 'signalTimeframe'),
        fmt(s.directionTimeframe, 'directionTimeframe'),
        fmt(s.exitTimeframe, 'exitTimeframe'),
        fmt(s.allowedSides, 'allowedSides'),
        fmt(s.reverseSignals, 'reverseSignals'),
        fmt(s.targetOtmDistance, 'targetOtmDistance'),
        fmt(s.targetContractPrice, 'targetContractPrice'),
        fmt(s.maxEntryPrice, 'maxEntryPrice'),
      ],
    },
    {
      title: 'Risk & Position',
      fields: [
        fmt(p.stopLossPercent, 'stopLossPercent'),
        fmt(p.takeProfitMultiplier, 'takeProfitMultiplier'),
        fmt(p.maxPositionsOpen, 'maxPositionsOpen'),
        fmt(p.defaultQuantity, 'defaultQuantity'),
        fmt(p.intrabarTieBreaker, 'intrabarTieBreaker'),
        fmt(r.maxDailyLoss, 'maxDailyLoss'),
        fmt(r.maxTradesPerDay, 'maxTradesPerDay'),
        fmt(r.maxRiskPerTrade, 'maxRiskPerTrade'),
        fmt(r.cutoffTimeET, 'cutoffTimeET'),
        fmt(r.maxSignalsPerSession, 'maxSignalsPerSession'),
      ],
    },
    {
      title: 'Strike Selection',
      fields: [
        fmt(ss.strikeSearchRange, 'strikeSearchRange'),
        fmt(ss.contractPriceMin, 'contractPriceMin'),
        fmt(ss.contractPriceMax, 'contractPriceMax'),
        fmt(ss.strikeMode, 'strikeMode'),
        fmt(ss.atmOffset, 'atmOffset'),
      ],
    },
    {
      title: 'Time Windows',
      fields: [
        fmt(tw.sessionStart, 'sessionStart'),
        fmt(tw.sessionEnd, 'sessionEnd'),
        fmt(tw.activeStart, 'activeStart'),
        fmt(tw.activeEnd, 'activeEnd'),
        fmt(tw.skipWeekends, 'skipWeekends'),
        fmt(tw.skipHolidays, 'skipHolidays'),
      ],
    },
    {
      title: 'Exit Rules',
      fields: [
        fmt(ex.strategy, 'strategy'),
        fmt(ex.trailingStopEnabled, 'trailingStopEnabled'),
        fmt(ex.trailingStopPercent, 'trailingStopPercent'),
        fmt(ex.timeBasedExitEnabled, 'timeBasedExitEnabled'),
        fmt(ex.timeBasedExitMinutes, 'timeBasedExitMinutes'),
        fmt(ex.exitPricing, 'exitPricing'),
        fmt(ex.reentryOnTakeProfit, 'reentryOnTakeProfit'),
      ].filter(f => f.value !== undefined),
    },
    {
      title: 'Sizing & Fill',
      fields: [
        fmt(sz.sizingMode, 'sizingMode'),
        fmt(sz.sizingValue, 'sizingValue'),
        fmt(sz.startingAccountValue, 'startingAccountValue'),
        fmt(fl?.participationRate, 'participationRate'),
        fmt(fl?.minContracts, 'minContracts'),
        fmt(fl?.spreadModel?.mode, 'mode'),
        fmt(fl?.spreadModel?.spreadFloor, 'spreadFloor'),
        fmt(fl?.spreadModel?.spreadPct, 'spreadPct'),
        fmt(fl?.slippage?.slSlipPerContract, 'slSlipPerContract'),
        fmt(fl?.slippage?.slSlipMax, 'slSlipMax'),
        fmt(fl?.slippage?.entrySlipPerContract, 'entrySlipPerContract'),
        fmt(fl?.slippage?.entrySlipMax, 'entrySlipMax'),
        fmt(fl?.slippage?.slSpreadFactor, 'slSpreadFactor'),
        fmt(fl?.slippage?.slEodPenalty, 'slEodPenalty'),
        fmt(fl?.slippage?.slEodWindowMin, 'slEodWindowMin'),
      ].filter(f => f.value !== undefined),
    },
  ];
}
