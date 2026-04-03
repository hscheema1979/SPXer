/**
 * Replay module — public API surface.
 */

export type {
  ReplayConfig,
  ReplayRun,
  ReplayResult,
  Trade,
  ReplayBar,
  ReplayContract,
  CycleSnapshot,
  ReplayContext,
  CycleHandlers,
} from './types';

export { DEFAULT_CONFIG, mergeConfig, validateConfig } from './config';
export { ReplayStore, createStore } from './store';
export { computeMetrics, etLabel, etToUnix, minutesToClose, parseIndicators, buildSymbolFilter, buildSymbolRange, buildSessionTimestamps } from './metrics';
export { buildCycleSnapshot, createReplayContext, getAvailableDays, runReplayDay } from './framework';
export { runReplay, type ReplayOptions } from './machine';
