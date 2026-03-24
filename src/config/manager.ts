/**
 * ConfigManager — centralized configuration management from database.
 *
 * Single source of truth for ALL configs:
 * - Live trading agent (agent.ts)
 * - Replay system (src/replay/)
 * - Autoresearch (scripts/autoresearch/)
 *
 * All services load their ReplayConfig from replay.db, not from files.
 * Multiple services can run in parallel with different configs.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import type { ReplayConfig } from '../replay/types';

const CONFIG_DB_PATH = path.resolve(process.cwd(), 'data/replay.db');

export class ConfigManager {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || CONFIG_DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS replay_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        config_json TEXT NOT NULL,
        baselineConfigId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_configs (
        service_name TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        loaded_at INTEGER NOT NULL,
        FOREIGN KEY(config_id) REFERENCES replay_configs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_active_configs_loaded ON active_configs(loaded_at);
    `);
  }

  // ── Config CRUD ─────────────────────────────────────────────────────────────

  /**
   * Save a config to the database.
   * Updates updatedAt timestamp automatically.
   */
  saveConfig(config: ReplayConfig): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_configs
      (id, name, description, config_json, baselineConfigId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.name,
      config.description || '',
      JSON.stringify(config),
      config.baselineConfigId || null,
      config.createdAt || now,
      now
    );
  }

  /**
   * Load a config by ID from the database.
   * Returns null if not found.
   */
  getConfig(id: string): ReplayConfig | null {
    const row = this.db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(id) as any;
    return row ? JSON.parse(row.config_json) : null;
  }

  /**
   * List all configs in the database.
   */
  listConfigs(): ReplayConfig[] {
    const rows = this.db.prepare('SELECT config_json FROM replay_configs ORDER BY createdAt DESC').all() as any[];
    return rows.map(r => JSON.parse(r.config_json));
  }

  /**
   * Delete a config by ID.
   * Also clears any active_config references to this config.
   */
  deleteConfig(id: string): void {
    this.db.prepare('DELETE FROM active_configs WHERE config_id = ?').run(id);
    this.db.prepare('DELETE FROM replay_configs WHERE id = ?').run(id);
  }

  /**
   * Create a new config as a variation of an existing config.
   * Copies all properties, allows overrides.
   */
  deriveConfig(baseConfigId: string, newId: string, overrides: Partial<ReplayConfig>): ReplayConfig {
    const base = this.getConfig(baseConfigId);
    if (!base) {
      throw new Error(`Base config ${baseConfigId} not found`);
    }

    const derived: ReplayConfig = {
      ...base,
      ...overrides,
      id: newId,
      baselineConfigId: baseConfigId,
      createdAt: Date.now(),
    };

    this.saveConfig(derived);
    return derived;
  }

  // ── Service Config Tracking ────────────────────────────────────────────────

  /**
   * Register that a service is using a specific config.
   * Allows tracking which config each active service is running with.
   */
  registerActiveService(serviceName: string, configId: string): void {
    const config = this.getConfig(configId);
    if (!config) {
      throw new Error(`Config ${configId} not found`);
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO active_configs (service_name, config_id, loaded_at)
      VALUES (?, ?, ?)
    `).run(serviceName, configId, Date.now());
  }

  /**
   * Get the config ID currently in use by a service.
   */
  getActiveServiceConfig(serviceName: string): string | null {
    const row = this.db.prepare('SELECT config_id FROM active_configs WHERE service_name = ?').get(serviceName) as any;
    return row?.config_id || null;
  }

  /**
   * Get the full config for a service.
   */
  loadServiceConfig(serviceName: string): ReplayConfig | null {
    const configId = this.getActiveServiceConfig(serviceName);
    return configId ? this.getConfig(configId) : null;
  }

  /**
   * List all active services and their configs.
   */
  listActiveServices(): Array<{ serviceName: string; configId: string; loadedAt: number; config: ReplayConfig }> {
    const rows = this.db.prepare(`
      SELECT ac.service_name, ac.config_id, ac.loaded_at, rc.config_json
      FROM active_configs ac
      JOIN replay_configs rc ON ac.config_id = rc.id
      ORDER BY ac.loaded_at DESC
    `).all() as any[];

    return rows.map(r => ({
      serviceName: r.service_name,
      configId: r.config_id,
      loadedAt: r.loaded_at,
      config: JSON.parse(r.config_json),
    }));
  }

  /**
   * Unregister a service (when it shuts down cleanly).
   */
  unregisterService(serviceName: string): void {
    this.db.prepare('DELETE FROM active_configs WHERE service_name = ?').run(serviceName);
  }

  // ── Convenience Methods ─────────────────────────────────────────────────────

  /**
   * Get or create default config for live trading.
   * Seeds from agent-config.ts defaults if no config exists.
   */
  getOrCreateDefaultAgentConfig(): ReplayConfig {
    const existing = this.getConfig('agent-default');
    if (existing) return existing;

    // Seed from agent-config.ts
    const { AGENT_CONFIG } = require('../../agent-config');
    const config: ReplayConfig = {
      id: 'agent-default',
      name: 'Default Agent Config',
      description: 'Default configuration for live trading agent',
      createdAt: Date.now(),
      ...AGENT_CONFIG,
    };

    this.saveConfig(config);
    return config;
  }

  /**
   * Get or create default config for replay.
   * Seeds from replay/config.ts DEFAULT_CONFIG if no config exists.
   */
  getOrCreateDefaultReplayConfig(): ReplayConfig {
    const existing = this.getConfig('replay-default');
    if (existing) return existing;

    // Seed from replay/config.ts
    const { DEFAULT_CONFIG } = require('../replay/config');
    const config: ReplayConfig = {
      id: 'replay-default',
      name: 'Default Replay Config',
      description: 'Default configuration for replay system',
      createdAt: Date.now(),
      ...DEFAULT_CONFIG,
    };

    this.saveConfig(config);
    return config;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

// Singleton instance for convenience
let defaultManager: ConfigManager | null = null;

export function getConfigManager(): ConfigManager {
  if (!defaultManager) {
    defaultManager = new ConfigManager();
  }
  return defaultManager;
}

export function createConfigManager(dbPath?: string): ConfigManager {
  return new ConfigManager(dbPath);
}
