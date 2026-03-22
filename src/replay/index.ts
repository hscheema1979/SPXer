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

export { DEFAULT_CONFIG, CONFIG_PRESETS, mergeConfig, validateConfig } from './config';
export { ReplayStore, createStore } from './store';
export { computeMetrics, etLabel, minutesToClose, parseIndicators, buildSymbolFilter, buildSessionTimestamps } from './metrics';
export { buildCycleSnapshot, createReplayContext, getAvailableDays, runReplayDay } from './framework';
export { runReplay, type ReplayOptions } from './machine';
