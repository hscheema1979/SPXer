/**
 * Core trading logic — shared between replay and live agent.
 *
 * Both systems import from here. Test once, deploy everywhere.
 */

export type {
  Direction, SignalType, ExitReason,
  Signal, Position, ExitCheck, TradeResult, CoreBar, PriceGetter,
} from './types';

export { detectSignals } from './signal-detector';
export { checkExit } from './position-manager';
export { computeQty } from './position-sizer';
export { isRiskBlocked, type RiskState } from './risk-guard';
export { isRegimeBlocked } from './regime-gate';
export { selectStrike, type StrikeCandidate, type StrikeResult } from './strike-selector';
export { computeIndicators, seedIndicatorState, resetVWAP } from './indicator-engine';
export {
  tick,
  createInitialState,
  stripFormingCandle,
  type CorePosition,
  type StrategyState,
  type TickInput,
  type TickResult,
} from './strategy-engine';
