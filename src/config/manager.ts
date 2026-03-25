/**
 * ConfigManager — centralized config CRUD against the single spxer.db.
 *
 * Three tables: models, prompts, configs (+ active_configs for subsystem binding).
 * All subsystems (live agent, replay, autoresearch) load from the same DB.
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import type { Config, ModelRecord, PromptRecord, ActiveConfigBinding, ResolvedConfig } from './types';

// ── Table creation ─────────────────────────────────────────────────────────

export function createConfigTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      provider    TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('scanner', 'judge', 'both')),
      base_url    TEXT NOT NULL,
      model_name  TEXT NOT NULL,
      api_key_env TEXT NOT NULL,
      timeout_ms  INTEGER NOT NULL DEFAULT 180000,
      max_tokens  INTEGER NOT NULL DEFAULT 1024,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id          TEXT PRIMARY KEY,
      role        TEXT NOT NULL CHECK(role IN ('scanner', 'judge')),
      name        TEXT NOT NULL,
      content     TEXT NOT NULL,
      version     TEXT,
      notes       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS configs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      baseline_id TEXT,
      config_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_configs (
      subsystem   TEXT PRIMARY KEY,
      config_id   TEXT NOT NULL,
      loaded_at   INTEGER NOT NULL,
      FOREIGN KEY(config_id) REFERENCES configs(id)
    );
  `);
}

// ── ConfigManager ──────────────────────────────────────────────────────────

export class ConfigManager {
  constructor(private db: DB) {
    createConfigTables(db);
  }

  // ── Models CRUD ──────────────────────────────────────────────────────────

  saveModel(model: ModelRecord): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO models
      (id, name, provider, role, base_url, model_name, api_key_env, timeout_ms, max_tokens, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      model.id, model.name, model.provider, model.role, model.baseUrl,
      model.modelName, model.apiKeyEnv, model.timeoutMs, model.maxTokens,
      model.enabled ? 1 : 0, model.createdAt || now, now,
    );
  }

  getModel(id: string): ModelRecord | null {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as any;
    return row ? this.rowToModel(row) : null;
  }

  listModels(role?: 'scanner' | 'judge' | 'both'): ModelRecord[] {
    const query = role
      ? 'SELECT * FROM models WHERE role = ? OR role = \'both\' ORDER BY name'
      : 'SELECT * FROM models ORDER BY name';
    const rows = role ? this.db.prepare(query).all(role) : this.db.prepare(query).all();
    return (rows as any[]).map(r => this.rowToModel(r));
  }

  listEnabledModels(role?: 'scanner' | 'judge' | 'both'): ModelRecord[] {
    return this.listModels(role).filter(m => m.enabled);
  }

  deleteModel(id: string): void {
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  private rowToModel(row: any): ModelRecord {
    return {
      id: row.id,
      name: row.name,
      provider: row.provider,
      role: row.role,
      baseUrl: row.base_url,
      modelName: row.model_name,
      apiKeyEnv: row.api_key_env,
      timeoutMs: row.timeout_ms,
      maxTokens: row.max_tokens,
      enabled: !!row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Prompts CRUD ─────────────────────────────────────────────────────────

  savePrompt(prompt: PromptRecord): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR REPLACE INTO prompts
      (id, role, name, content, version, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prompt.id, prompt.role, prompt.name, prompt.content,
      prompt.version || null, prompt.notes || null,
      prompt.createdAt || now, now,
    );
  }

  getPrompt(id: string): PromptRecord | null {
    const row = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as any;
    return row ? this.rowToPrompt(row) : null;
  }

  listPrompts(role?: 'scanner' | 'judge'): PromptRecord[] {
    const query = role
      ? 'SELECT * FROM prompts WHERE role = ? ORDER BY created_at DESC'
      : 'SELECT * FROM prompts ORDER BY created_at DESC';
    const rows = role ? this.db.prepare(query).all(role) : this.db.prepare(query).all();
    return (rows as any[]).map(r => this.rowToPrompt(r));
  }

  deletePrompt(id: string): void {
    this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  private rowToPrompt(row: any): PromptRecord {
    return {
      id: row.id,
      role: row.role,
      name: row.name,
      content: row.content,
      version: row.version,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Configs CRUD ─────────────────────────────────────────────────────────

  saveConfig(config: Config): void {
    const now = Date.now();
    const saved = { ...config, updatedAt: now, createdAt: config.createdAt || now };
    this.db.prepare(`
      INSERT OR REPLACE INTO configs
      (id, name, description, baseline_id, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      saved.id, saved.name, saved.description || null,
      saved.baselineId || null, JSON.stringify(saved),
      saved.createdAt, saved.updatedAt,
    );
  }

  getConfig(id: string): Config | null {
    const row = this.db.prepare('SELECT config_json FROM configs WHERE id = ?').get(id) as any;
    return row ? JSON.parse(row.config_json) : null;
  }

  listConfigs(): Config[] {
    const rows = this.db.prepare('SELECT config_json FROM configs ORDER BY created_at DESC').all() as any[];
    return rows.map(r => JSON.parse(r.config_json));
  }

  deleteConfig(id: string): void {
    this.db.prepare('DELETE FROM active_configs WHERE config_id = ?').run(id);
    this.db.prepare('DELETE FROM configs WHERE id = ?').run(id);
  }

  deriveConfig(baseId: string, newId: string, overrides: Partial<Config>): Config {
    const base = this.getConfig(baseId);
    if (!base) throw new Error(`Base config '${baseId}' not found`);

    const derived: Config = {
      ...base,
      ...overrides,
      id: newId,
      baselineId: baseId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveConfig(derived);
    return derived;
  }

  // ── Subsystem Binding ────────────────────────────────────────────────────

  bindSubsystem(subsystem: string, configId: string): void {
    const config = this.getConfig(configId);
    if (!config) throw new Error(`Config '${configId}' not found`);

    this.db.prepare(`
      INSERT OR REPLACE INTO active_configs (subsystem, config_id, loaded_at)
      VALUES (?, ?, ?)
    `).run(subsystem, configId, Date.now());
  }

  unbindSubsystem(subsystem: string): void {
    this.db.prepare('DELETE FROM active_configs WHERE subsystem = ?').run(subsystem);
  }

  getSubsystemConfigId(subsystem: string): string | null {
    const row = this.db.prepare('SELECT config_id FROM active_configs WHERE subsystem = ?').get(subsystem) as any;
    return row?.config_id || null;
  }

  loadForSubsystem(subsystem: string): Config | null {
    const configId = this.getSubsystemConfigId(subsystem);
    return configId ? this.getConfig(configId) : null;
  }

  listActiveBindings(): ActiveConfigBinding[] {
    return this.db.prepare('SELECT subsystem, config_id as configId, loaded_at as loadedAt FROM active_configs ORDER BY loaded_at DESC').all() as any[];
  }

  // ── Resolved Config (hydrated with models + prompts) ─────────────────────

  resolveConfig(config: Config): ResolvedConfig {
    const resolvedScanners = config.scanners.models
      .map(id => this.getModel(id))
      .filter((m): m is ModelRecord => m !== null && m.enabled);

    const resolvedJudges = config.judges.models
      .map(id => this.getModel(id))
      .filter((m): m is ModelRecord => m !== null && m.enabled);

    const promptIds = new Set<string>();
    promptIds.add(config.scanners.defaultPromptId);
    promptIds.add(config.judges.promptId);
    for (const pid of Object.values(config.scanners.promptAssignments)) {
      promptIds.add(pid);
    }

    const resolvedPrompts: Record<string, PromptRecord> = {};
    for (const pid of promptIds) {
      const prompt = this.getPrompt(pid);
      if (prompt) resolvedPrompts[pid] = prompt;
    }

    return {
      ...config,
      resolvedScanners,
      resolvedJudges,
      resolvedPrompts,
    };
  }

  resolveForSubsystem(subsystem: string): ResolvedConfig | null {
    const config = this.loadForSubsystem(subsystem);
    return config ? this.resolveConfig(config) : null;
  }
}
