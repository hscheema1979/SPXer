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
import { groupConfigSections } from './config-view';
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
  'spxer',                    // Data service (OPTIONAL for live trading)
  'spxer-agent',              // Legacy alias
  'event-handler',            // Signal detection + entry execution (PRIMARY - independent)
  'position-monitor',         // Exit observer (RECOMMENDED - independent)
  'schwaber',                 // Schwab ETF trading (optional)
  'runner-itm5', 'runner-atm', 'runner-otm5',    // Basket members
  'scalp-itm5', 'scalp-atm', 'scalp-otm5',      // Scalp members
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

  /** GET /admin/api/config/:id/grouped — get a config with parameters grouped for display */
  router.get('/api/config/:id/grouped', (req, res) => {
    const { id } = req.params;
    const db = getDb();
    try {
      const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(id) as any;
      if (!row) {
        return res.status(404).json({ error: 'Config not found' });
      }
      const config = mergeConfig(DEFAULT_CONFIG, JSON.parse(row.config_json));
      const sections = groupConfigSections(config);
      res.json(sections);
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
      const { stdout: jlistOutput } = await execAsync('pm2 jlist');
      const jlistData = JSON.parse(jlistOutput) as any[];

      const simplified = jlistData
        .filter((p: any) => SPXER_PROCESS_NAMES.has(p.name))
        .map((p: any) => {
          const monit = p.monit || {};
          const hasPid = p.pid && p.pid > 0;

          return {
            name: p.name as string,
            pid: p.pid as number,
            status: (hasPid ? 'online' : 'stopped') as string,
            uptime: (p.pm2_env?.created_at ? Date.now() - p.pm2_env.created_at : 0) as number,
            cpu: (monit.cpu ?? 0) as number,
            memory: (monit.memory ?? 0) as number,
            restarts: (p.pm2_env?.restart_time ?? 0) as number,
            autorestart: (p.pm2_env?.autorestart ?? false) as boolean,
          };
        });

      res.json(simplified);
    } catch (e: any) {
      res.status(500).json({ error: e.message, stdout: e.stdout, stderr: e.stderr });
    }
  });

  /** PUT /admin/api/process/:name/env/save-only — write env vars without restarting */
  router.put('/api/process/:name/env/save-only', async (req, res) => {
    const { name } = req.params;
    const { envUpdates } = req.body as { envUpdates: Record<string, string> };

    if (!envUpdates || typeof envUpdates !== 'object') {
      return res.status(400).json({ error: 'envUpdates object required' });
    }

    try {
      const ecosystemContent = await fs.readFile(ECOSYSTEM_PATH, 'utf-8');
      let updatedContent = ecosystemContent;

      for (const [key, value] of Object.entries(envUpdates)) {
        const regex = new RegExp(`(name:\\s*['"]${name}['"][\\s\\S]*?env:\\s*\\{[^}]*?)(${key}:\\s*['"][^'"]*['"]|)`, 'g');
        updatedContent = updatedContent.replace(regex, (match, prefix) => {
          if (match.includes(`${key}:`)) {
            return match.replace(new RegExp(`${key}:\\s*['"][^'"]*['"]`), `${key}: '${value}'`);
          } else {
            return prefix + `    ${key}: '${value}',\n`;
          }
        });
      }

      await fs.writeFile(ECOSYSTEM_PATH, updatedContent, 'utf-8');
      res.json({ saved: true, envUpdates, pendingRestart: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /admin/api/process/:name/apply-restart — restart PM2 process */
  router.post('/api/process/:name/apply-restart', async (req, res) => {
    const { name } = req.params;
    try {
      await execAsync(`pm2 restart ${name} --update-env`);
      res.json({ restarted: true, name });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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

  /** GET /admin/api/ecosystem/validate — syntax check ecosystem.config.js */
  router.get('/api/ecosystem/validate', async (_req, res) => {
    try {
      await execAsync(`node -c "${ECOSYSTEM_PATH}" 2>&1`);
      res.json({ valid: true });
    } catch (e: any) {
      const error = e.stderr || e.message || 'Syntax error';
      res.json({ valid: false, error });
    }
  });

  /** POST /admin/api/ecosystem/revert — restore from backup */
  router.post('/api/ecosystem/revert', async (_req, res) => {
    const backupPath = ECOSYSTEM_PATH + '.backup';
    try {
      await fs.access(backupPath);
    } catch {
      return res.status(404).json({ error: 'No backup file found' });
    }

    try {
      await fs.copyFile(backupPath, ECOSYSTEM_PATH);
      res.json({ reverted: true });
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

    const tmpPath = ECOSYSTEM_PATH + '.tmp';
    try {
      await fs.writeFile(tmpPath, content, 'utf-8');

      try {
        await execAsync(`node -c "${tmpPath}"`);
      } catch {
        await fs.unlink(tmpPath).catch(() => {});
        return res.status(400).json({ error: 'Invalid JavaScript syntax', stdout: '' });
      }

      await fs.copyFile(ECOSYSTEM_PATH, ECOSYSTEM_PATH + '.backup');
      await fs.writeFile(ECOSYSTEM_PATH, content, 'utf-8');
      await fs.unlink(tmpPath).catch(() => {});

      await execAsync('pm2 reload ecosystem.config.js --update-env');

      res.json({ message: 'Ecosystem config updated and PM2 reloaded' });
    } catch (e: any) {
      await fs.unlink(tmpPath).catch(() => {});
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

  // ── System Checklist ────────────────────────────────────────────────────────

  /** GET /admin/api/checklist/run — run tier checks and return results */
  router.get('/api/checklist/run', async (req, res) => {
    const { tier } = req.query;

    try {
      const scriptDir = path.resolve(process.cwd(), 'scripts/ops');
      const results: Array<{ name: string; status: string; output: string }> = [];

      // Define available check scripts
      const checks = [
        { name: 'Tier 0: Machine Fundamentals', script: 'check-environment.sh', tier: '0' },
        { name: 'Tier 1: Service Setup & Runtime', script: 'check-services-setup.sh', tier: '1' },
        { name: 'Tiers 6-10: Data Pipeline', script: 'check-data-pipeline.sh', tier: '6-10' },
        { name: 'Tiers 11-17: Pre-Market Validation', script: 'check-pre-market-validation.sh', tier: '11-17' },
      ];

      const checksToRun = tier
        ? checks.filter(c => c.tier === tier)
        : checks;

      for (const check of checksToRun) {
        try {
          const scriptPath = path.join(scriptDir, check.script);
          const { stdout, stderr } = await execAsync(`cd ${process.cwd()} && bash ${scriptPath}`, {
            timeout: 60000,
          });

          // Parse output to determine status
          const output = stdout + stderr;
          const hasFail = output.includes('❌') || output.includes('FAIL');
          const hasWarn = output.includes('⚠️') || output.includes('WARN');
          const status = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';

          results.push({
            name: check.name,
            status,
            output: output.slice(-5000), // Last 5000 chars
          });
        } catch (e: any) {
          results.push({
            name: check.name,
            status: 'error',
            output: e.stderr || e.message || 'Script failed to run',
          });
        }
      }

      res.json({ results, timestamp: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /admin/api/checklist/summary — get quick summary of all tiers */
  router.get('/api/checklist/summary', async (_req, res) => {
    try {
      const { stdout } = await execAsync('cd /home/ubuntu/SPXer && ./scripts/ops/check-services-setup.sh', {
        timeout: 30000,
      });

      const isOnline = stdout.includes('ONLINE') || stdout.includes('✓');
      const hasErrors = stdout.includes('❌') || stdout.includes('FAIL');

      // Parse service status from output
      // Note: spxer is OPTIONAL for live trading - event-handler and position-monitor are independent
      const services: Record<string, string> = {
        spxer: stdout.includes('SPXer.*ONLINE') || stdout.includes('spxer.*online') ? 'online' : 'unknown',
        eventHandler: stdout.includes('Event Handler.*ONLINE') || stdout.includes('event-handler.*online') ? 'online' : 'unknown',
        positionMonitor: stdout.includes('Position Monitor.*ONLINE') || stdout.includes('position-monitor.*online') ? 'online' : 'unknown',
      };

      res.json({
        overall: hasErrors ? 'fail' : isOnline ? 'pass' : 'warn',
        services,
        architecture: 'independent', // v2.0 - all services independent
        lastCheck: new Date().toISOString(),
      });
    } catch (e: any) {
      res.json({
        overall: 'error',
        services: { spxer: 'error', eventHandler: 'error', positionMonitor: 'error' },
        architecture: 'independent',
        lastCheck: new Date().toISOString(),
      });
    }
  });

  // ── Operational Monitoring ─────────────────────────────────────────────────

  /** GET /admin/api/monitoring/results — get monitoring results */
  router.get('/api/monitoring/results', (_req, res) => {
    try {
      const monitoringPath = path.join(process.cwd(), 'data', 'monitoring-results.json');

      if (!fsSync.existsSync(monitoringPath)) {
        return res.json({ results: [], summary: { total: 0, lastCheck: null, lastIssues: 0, lastWarnings: 0 } });
      }

      const data = JSON.parse(fsSync.readFileSync(monitoringPath, 'utf-8')) as any[];

      res.json({
        results: data.slice(0, 50), // Last 50 results
        summary: {
          total: data.length,
          lastCheck: data[0]?.timestamp || null,
          lastIssues: data[0]?.issues || 0,
          lastWarnings: data[0]?.warnings || 0,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /admin/api/monitoring/latest — get latest monitoring check */
  router.get('/api/monitoring/latest', (_req, res) => {
    try {
      const monitoringPath = path.join(process.cwd(), 'data', 'monitoring-results.json');

      if (!fsSync.existsSync(monitoringPath)) {
        return res.json({ result: null, message: 'No monitoring data yet' });
      }

      const data = JSON.parse(fsSync.readFileSync(monitoringPath, 'utf-8')) as any[];

      res.json({ result: data[0] || null });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /admin/api/monitoring/stats — get 24h stats */
  router.get('/api/monitoring/stats', (_req, res) => {
    try {
      const monitoringPath = path.join(process.cwd(), 'data', 'monitoring-results.json');

      if (!fsSync.existsSync(monitoringPath)) {
        return res.json({ stats: null });
      }

      const data = JSON.parse(fsSync.readFileSync(monitoringPath, 'utf-8')) as any[];

      // Calculate 24h stats
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recent = data.filter((r: any) => new Date(r.timestamp).getTime() > oneDayAgo);

      const totalIssues = recent.reduce((sum: number, r: any) => sum + (r.issues || 0), 0);
      const totalWarnings = recent.reduce((sum: number, r: any) => sum + (r.warnings || 0), 0);
      const failedChecks = recent.filter((r: any) => r.issues > 0).length;
      const warningChecks = recent.filter((r: any) => r.issues === 0 && r.warnings > 0).length;
      const cleanChecks = recent.filter((r: any) => r.issues === 0 && r.warnings === 0).length;

      res.json({
        stats: {
          period: '24h',
          totalChecks: recent.length,
          failedChecks,
          warningChecks,
          cleanChecks,
          totalIssues,
          totalWarnings,
          avgIssuesPerCheck: recent.length > 0 ? (totalIssues / recent.length).toFixed(2) : '0.00',
          avgWarningsPerCheck: recent.length > 0 ? (totalWarnings / recent.length).toFixed(2) : '0.00',
          uptime: recent.length > 0 ? ((cleanChecks + warningChecks) / recent.length * 100).toFixed(1) + '%' : '0%',
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** POST /admin/api/monitoring/trigger — manually trigger monitoring check */
  router.post('/api/monitoring/trigger', async (_req, res) => {
    try {
      const scriptPath = path.resolve(process.cwd(), 'scripts/ops/monitor-operational.sh');
      const { stdout, stderr } = await execAsync(`bash ${scriptPath}`, {
        timeout: 60000,
        cwd: process.cwd(),
      });

      res.json({
        triggered: true,
        output: stdout + stderr,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message, output: e.stdout + e.stderr });
    }
  });

  return router;
}
