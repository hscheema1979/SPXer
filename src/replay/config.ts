/**
 * Replay configuration — re-exports from unified config system.
 * The canonical defaults, merge, and validation are in src/config/defaults.ts.
 *
 * This file exists for backwards compatibility with existing replay imports.
 */

export { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../config/defaults';
export type { Config as ReplayConfig } from '../config/types';
