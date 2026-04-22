/**
 * Admin API routes — config management and PM2 process control.
 * Mounted on the Express app at /admin/api/*
 */

import { Router, type Request, type Response } from 'express';
import { promisify } from 'util';
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../config/defaults';
import type { Config } from '../config/types';
import { REPLAY_META_DB } from '../storage/replay-db';
import { readHandlerState, readRoutingLog, writeCommand } from '../agent/handler-state';
import Database from 'better-sqlite3';

const execAsync = promisify(exec);

/** Metadata DB (configs) — writable */
function getWriteDb(): Database.Database {
  return new Database(REPLAY_META_DB);
}

/** Metadata DB — readonly */
function getDb(): Database.Database {
  return new Database(REPLAY_META_DB, { readonly: true });
}

/**
 * Normalize config JSON for comparison — strip fields that differ between
 * saves but don't represent actual config changes (id, name, timestamps).
 */
function configFingerprint(config: Config): string {
  const { id, name, description, createdAt, updatedAt, ...rest } = config as any;
  return JSON.stringify(rest);
}

/**
 * Save a config with automatic versioning. If a config with the same ID
 * already exists and has DIFFERENT settings, auto-create a new version
 * (base-v2, base-v3, etc.) instead of overwriting the original.
 *
 * Returns the actual ID used (may differ from input if versioned).
 */
function saveConfigVersioned(db: Database.Database, config: Config, id: string, name: string): string {
  // Check if this ID already exists with different content
  const existing = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
    .get(id) as { config_json: string } | undefined;

  if (existing) {
    const existingConfig = JSON.parse(existing.config_json) as Config;
    const existingFp = configFingerprint(existingConfig);

    // Build fingerprint for the new config (temporarily set id/name to compare fairly)
    const newConfig = { ...config, id, name };
    const newFp = configFingerprint(newConfig);

    if (existingFp !== newFp) {
      // Config changed — find next available version
      const base = id.replace(/-v\d+$/, '');
      let v = 2;
      while (db.prepare('SELECT 1 FROM replay_configs WHERE id = ?').get(`${base}-v${v}`)) {
        v++;
      }
      id = `${base}-v${v}`;
      name = name.replace(/ v\d+$/, '') + ` v${v}`;
      console.log(`[admin] Config changed, auto-versioned to: ${id}`);
    }
    // If fingerprints match, reuse the same ID (just update timestamp)
  }

  config.id = id;
  config.name = name;

  db.prepare(`
    INSERT INTO replay_configs (id, name, description, config_json, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, description=excluded.description, config_json=excluded.config_json, updatedAt=excluded.updatedAt
  `).run(id, name, config.description || '', JSON.stringify(config), config.createdAt || Date.now(), Date.now());

  return id;
}

/** Path to ecosystem.config.js */
const ECOSYSTEM_PATH = path.resolve(process.cwd(), 'ecosystem.config.js');

/** SPXer process name prefixes — only these show in admin */
const SPXER_PROCESS_NAMES = new Set([
  'spxer', 'spxer-agent', 'event-handler',
  'runner-itm5', 'runner-atm', 'runner-otm5',
  'scalp-itm5', 'scalp-atm', 'scalp-otm5',
  'replay-viewer', 'replay2-viewer', 'replay-sweep',
  'status-monitor', 'daily-journal', 'daily-backfill',
  'metrics-collector',
]);

export function createAdminRoutes(): Router {
  const router = Router();

  // ── Serve the HTML admin viewer ───────────────────────────────────────────
  router.get('/', (req, res) => {
    const htmlPath = path.resolve(__dirname, 'admin-viewer.html');
    if (fsSync.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/admin-viewer.html');
      res.sendFile(altPath);
    }
  });

  // ── Config Management ───────────────────────────────────────────────────

  /** GET /admin/api/configs — list all configs */
  router.get('/api/configs', (_req, res) => {
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT id, name, description, createdAt, updatedAt
        FROM replay_configs
        ORDER BY createdAt DESC
      `).all() as Array<{ id: string; name: string; description: string; createdAt: number; updatedAt: number }>;

      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      db.close();
    }
  });

  /** GET /admin/api/config/:id — get a single config */
  router.get('/api/config/:id', (req, res) => {
    const { id } = req.params;
    const db = getDb();
    try {
      const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(id) as any;
      if (!row) {
        return res.status(404).json({ error: 'Config not found' });
      }
      const config = mergeConfig(DEFAULT_CONFIG, JSON.parse(row.config_json));
      res.json(config);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      db.close();
    }
  });

  /** POST /admin/api/config — create new config */
  router.post('/api/config', (req, res) => {
    const { id, name, description, config } = req.body as {
      id?: string;
      name: string;
      description?: string;
      config: Partial<Config>;
    };

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const newId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const merged = mergeConfig(DEFAULT_CONFIG, { ...config, id: newId, name, description });

    // Validate
    const validation = validateConfig(merged);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid config', errors: validation.errors });
    }

    const db = getWriteDb();
    try {
      const actualId = saveConfigVersioned(db, merged, newId, name);
      res.json({ id: actualId, name, message: 'Config created' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      db.close();
    }
  });

  /** PUT /admin/api/config/:id — update existing config (creates new version if changed) */
  router.put('/api/config/:id', (req, res) => {
    const { id } = req.params;
    const { name, description, config } = req.body as {
      name?: string;
      description?: string;
      config: Partial<Config>;
    };

    const db = getWriteDb();
    try {
      // Load existing
      const existing = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(id) as any;
      if (!existing) {
        return res.status(404).json({ error: 'Config not found' });
      }

      const existingConfig = JSON.parse(existing.config_json) as Config;
      const newName = name || existingConfig.name;
      const merged = mergeConfig(DEFAULT_CONFIG, { ...existingConfig, ...config, name: newName, description: description ?? existingConfig.description });

      // Validate
      const validation = validateConfig(merged);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid config', errors: validation.errors });
      }

      const actualId = saveConfigVersioned(db, merged, id, newName);
      res.json({ id: actualId, name: newName, message: actualId === id ? 'Config updated' : `New version created: ${actualId}` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      db.close();
    }
  });

  /** DELETE /admin/api/config/:id — delete a config */
  router.delete('/api/config/:id', (req, res) => {
    const { id } = req.params;
    const db = getWriteDb();
    try {
      const result = db.prepare('DELETE FROM replay_configs WHERE id = ?').run(id);
      if (result.changes === 0) {
        return res.status(404).json({ error: 'Config not found' });
      }
      res.json({ message: 'Config deleted', id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    } finally {
      db.close();
    }
  });

  /** GET /admin/api/config/defaults — get default config template */
  router.get('/api/config/defaults', (_req, res) => {
    res.json(DEFAULT_CONFIG);
  });

  // ── PM2 Process Management ───────────────────────────────────────────────

  /** GET /admin/api/processes — list all PM2 processes */
  router.get('/api/processes', async (_req, res) => {
    try {
      const { stdout } = await execAsync('pm2 jlist');
      const raw = JSON.parse(stdout) as any[];

      const simplified = raw
        .filter((p: any) => SPXER_PROCESS_NAMES.has(p.name))
        .map((p: any) => ({
          name: p.name as string,
          pid: p.pid as number,
          status: (p.pm2_env?.status ?? 'stopped') as string,
          uptime: p.pm2_env?.pm_uptime ?? 0,
          cpu: p.monit?.cpu ?? 0,
          memory: p.monit?.memory ?? 0,
          restarts: p.pm2_env?.restart_time ?? 0,
          autorestart: p.pm2_env?.autorestart ?? false,
        }));

      res.json(simplified);
    } catch (e: any) {
      res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
  });

  /** POST /admin/api/process/:name/:action — control PM2 process */
  router.post('/api/process/:name/:action', async (req, res) => {
    const { name, action } = req.params;
    const validActions = ['start', 'stop', 'restart', 'reload', 'delete'];

    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `Invalid action: ${action}. Valid: ${validActions.join(', ')}` });
    }

    try {
      await execAsync(`pm2 ${action} ${name}`);
      res.json({ message: `Process ${name} ${action}ed successfully` });
    } catch (e: any) {
      res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
  });

  /** POST /admin/api/process/:name/reload — reload ecosystem and restart process */
  router.post('/api/process/reload-all', async (_req, res) => {
    try {
      await execAsync('pm2 reload ecosystem.config.js --update-env');
      res.json({ message: 'All processes reloaded from ecosystem.config.js' });
    } catch (e: any) {
      res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
  });

  /** GET /admin/api/process/:name/logs — get recent logs for a process */
  router.get('/api/process/:name/logs', async (req, res) => {
    const { name } = req.params;
    const lines = parseInt(req.query.lines as string || '100');
    const logType = req.query.type as string || 'both'; // 'out', 'err', or 'both'

    try {
      const logs: Array<{ name: string; type: 'out' | 'err'; timestamp: number; line: string }> = [];

      if (logType === 'out' || logType === 'both') {
        try {
          const { stdout: outLogs } = await execAsync(`pm2 logs ${name} --nostream --lines ${lines} --raw`);
          for (const line of outLogs.split('\n').filter(Boolean)) {
            logs.push({ name, type: 'out', timestamp: Date.now(), line });
          }
        } catch {}
      }

      if (logType === 'err' || logType === 'both') {
        try {
          const { stdout: errLogs } = await execAsync(`pm2 logs ${name} --err --nostream --lines ${lines} --raw`);
          for (const line of errLogs.split('\n').filter(Boolean)) {
            logs.push({ name, type: 'err', timestamp: Date.now(), line });
          }
        } catch {}
      }

      res.json({ logs });
    } catch (e: any) {
      res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
  });

  /** GET /admin/api/process/:name/env — get environment variables for a process */
  router.get('/api/process/:name/env', async (req, res) => {
    const { name } = req.params;
    try {
      const { stdout } = await execAsync('pm2 jlist');
      const raw = JSON.parse(stdout) as any[];
      const proc = raw.find((p: any) => p.name === name);

      if (!proc) {
        return res.status(404).json({ error: 'Process not found' });
      }

      res.json({ env: proc.pm2_env?.env || {} });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** PUT /admin/api/process/:name/env — update environment variable and reload */
  router.put('/api/process/:name/env', async (req, res) => {
    const { name } = req.params;
    const { envUpdates } = req.body as { envUpdates: Record<string, string> };

    if (!envUpdates || typeof envUpdates !== 'object') {
      return res.status(400).json({ error: 'envUpdates object required' });
    }

    try {
      // Read current ecosystem config
      const ecosystemContent = await fs.readFile(ECOSYSTEM_PATH, 'utf-8');

      // Parse and update the specific process's env
      // This is a simple regex-based approach - for production, use a proper parser
      let updatedContent = ecosystemContent;

      for (const [key, value] of Object.entries(envUpdates)) {
        // Find the env block for the named process and update/add the key
        const regex = new RegExp(`(name:\\s*['"]${name}['"][\\s\\S]*?env:\\s*\\{[^}]*?)(${key}:\\s*['"][^'"]*['"]|)`, 'g');
        updatedContent = updatedContent.replace(regex, (match, prefix) => {
          if (match.includes(`${key}:`)) {
            // Update existing
            return match.replace(new RegExp(`${key}:\\s*['"][^'"]*['"]`), `${key}: '${value}'`);
          } else {
            // Add new key
            return prefix + `    ${key}: '${value}',\n`;
          }
        });
      }

      // Write back
      await fs.writeFile(ECOSYSTEM_PATH, updatedContent, 'utf-8');

      // Reload the process
      await execAsync(`pm2 restart ${name} --update-env`);

      res.json({ message: `Environment updated for ${name}, process restarted`, envUpdates });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Ecosystem Config ──────────────────────────────────────────────────────

  /** GET /admin/api/ecosystem — get ecosystem.config.js content */
  router.get('/api/ecosystem', async (_req, res) => {
    try {
      const content = await fs.readFile(ECOSYSTEM_PATH, 'utf-8');
      res.json({ content, path: ECOSYSTEM_PATH });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** PUT /admin/api/ecosystem — update ecosystem.config.js and reload */
  router.put('/api/ecosystem', async (req, res) => {
    const { content } = req.body as { content: string };

    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }

    try {
      // Validate it's valid JS by attempting to parse it
      const { stdout } = await execAsync(`node -c "${ECOSYSTEM_PATH}"`);
      // If no output, file is valid

      // Backup original
      await fs.copyFile(ECOSYSTEM_PATH, ECOSYSTEM_PATH + '.backup', fs.constants.COPYFILE_EXCL);

      // Write new content
      await fs.writeFile(ECOSYSTEM_PATH, content, 'utf-8');

      // Reload PM2
      await execAsync('pm2 reload ecosystem.config.js --update-env');

      res.json({ message: 'Ecosystem config updated and PM2 reloaded' });
    } catch (e: any) {
      res.status(500).json({ error: e.message, stdout: e.stdout });
    }
  });

  // ── Event Handler State ─────────────────────────────────────────────────────

  /** GET /admin/api/handler/state — live event handler state from file */
  router.get('/api/handler/state', (_req, res) => {
    const state = readHandlerState();
    if (!state) {
      return res.json({ running: false, message: 'No handler process detected' });
    }
    res.json(state);
  });

  /** GET /admin/api/handler/routing — recent signal routing decisions */
  router.get('/api/handler/routing', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 50, 200);
    const decisions = readRoutingLog(n);
    res.json(decisions);
  });

  /** POST /admin/api/handler/command — send command to event handler */
  router.post('/api/handler/command', (req, res) => {
    const { action, configId, ...rest } = req.body;

    const validActions = ['toggle_paper', 'toggle_enabled', 'force_close', 'shutdown'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    if (configId) {
      const state = readHandlerState();
      if (state && !state.configs[configId]) {
        return res.status(404).json({ error: `Config '${configId}' not found in handler` });
      }
    }

    writeCommand({ action, configId, ...rest, ts: Date.now() });
    res.json({ message: `Command '${action}' sent` });
  });

  return router;
}
