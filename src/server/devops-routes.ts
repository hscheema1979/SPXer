import express, { type Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router: Router = express.Router();

// Storage file for monitoring results (in-memory persistence)
const MONITORING_FILE = path.join(process.cwd(), 'data', 'monitoring-results.json');
const MAX_RESULTS = 100; // Keep last 100 checks

interface MonitoringResult {
  timestamp: string;
  issues: number;
  warnings: number;
  checks: {
    spxFreshness: { status: string; staleSec: number } | null;
    optionFreshness: { status: string; staleSec: number } | null;
    spxerService: { status: string; restarts: number } | null;
    handlerService: { status: string; restarts: number } | null;
    signalDetection: { hasSignal: boolean; signalAge: number; lastSignal: any } | null;
    positions: { open: number; orphaned: number; dailyPnl: number } | null;
    brokerConnectivity: { status: string } | null;
    recentErrors: { spxerErrors: number; handlerErrors: number } | null;
  };
  summary: string;
}

function loadResults(): MonitoringResult[] {
  try {
    if (fs.existsSync(MONITORING_FILE)) {
      const data = fs.readFileSync(MONITORING_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[devops] Failed to load monitoring results:', e);
  }
  return [];
}

function saveResults(results: MonitoringResult[]) {
  try {
    const dir = path.dirname(MONITORING_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MONITORING_FILE, JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('[devops] Failed to save monitoring results:', e);
  }
}

// POST /devops/monitoring - Receive monitoring results from cron job
router.post('/monitoring', (req, res) => {
  try {
    const result = req.body as MonitoringResult;

    // Validate required fields
    if (!result.timestamp || typeof result.issues !== 'number' || typeof result.warnings !== 'number') {
      return res.status(400).json({ error: 'Missing required fields: timestamp, issues, warnings' });
    }

    // Load existing results, add new one, keep only last MAX_RESULTS
    const results = loadResults();
    results.unshift(result);
    if (results.length > MAX_RESULTS) {
      results.splice(MAX_RESULTS);
    }

    saveResults(results);

    res.json({ success: true, stored: true, count: results.length });
  } catch (e: any) {
    console.error('[devops] Failed to store monitoring result:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /devops/monitoring - Get recent monitoring results
router.get('/monitoring', (_req, res) => {
  try {
    const results = loadResults();
    res.json({
      results,
      summary: {
        total: results.length,
        lastCheck: results[0]?.timestamp || null,
        lastIssues: results[0]?.issues || 0,
        lastWarnings: results[0]?.warnings || 0,
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /devops/monitoring/latest - Get only the most recent result
router.get('/monitoring/latest', (_req, res) => {
  try {
    const results = loadResults();
    if (results.length === 0) {
      return res.json({ result: null, message: 'No monitoring results yet' });
    }
    res.json({ result: results[0] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /devops/monitoring/stats - Get statistics over time
router.get('/monitoring/stats', (_req, res) => {
  try {
    const results = loadResults();
    if (results.length === 0) {
      return res.json({ stats: null });
    }

    // Calculate stats over last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentResults = results.filter(r => {
      const ts = new Date(r.timestamp).getTime();
      return ts > oneDayAgo;
    });

    const totalIssues = recentResults.reduce((sum, r) => sum + r.issues, 0);
    const totalWarnings = recentResults.reduce((sum, r) => sum + r.warnings, 0);
    const failedChecks = recentResults.filter(r => r.issues > 0).length;
    const warningChecks = recentResults.filter(r => r.warnings > 0 && r.issues === 0).length;
    const cleanChecks = recentResults.filter(r => r.issues === 0 && r.warnings === 0).length;

    res.json({
      stats: {
        period: '24h',
        totalChecks: recentResults.length,
        failedChecks,
        warningChecks,
        cleanChecks,
        totalIssues,
        totalWarnings,
        avgIssuesPerCheck: recentResults.length > 0 ? (totalIssues / recentResults.length).toFixed(2) : 0,
        avgWarningsPerCheck: recentResults.length > 0 ? (totalWarnings / recentResults.length).toFixed(2) : 0,
        uptime: cleanChecks + warningChecks > 0
          ? ((cleanChecks + warningChecks) / recentResults.length * 100).toFixed(1) + '%'
          : '0%',
      }
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /devops/health - Quick health status based on monitoring
router.get('/health', (_req, res) => {
  try {
    const results = loadResults();
    if (results.length === 0) {
      return res.json({
        status: 'unknown',
        message: 'No monitoring data yet'
      });
    }

    const latest = results[0];
    let status = 'healthy';
    if (latest.issues > 0) {
      status = 'critical';
    } else if (latest.warnings > 3) {
      status = 'degraded';
    } else if (latest.warnings > 0) {
      status = 'warning';
    }

    // Check if data is stale (last check > 45 minutes ago)
    const lastCheckTime = new Date(latest.timestamp).getTime();
    const staleMinutes = Math.floor((Date.now() - lastCheckTime) / 60000);
    const isStale = staleMinutes > 45;

    res.json({
      status: isStale ? 'stale' : status,
      lastCheck: latest.timestamp,
      staleMinutes,
      issues: latest.issues,
      warnings: latest.warnings,
      summary: latest.summary,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /devops/viewer - DevOps monitoring dashboard
router.get('/viewer', (_req, res) => {
  const htmlPath = path.resolve(__dirname, 'devops-viewer.html');
  const altPath = path.resolve(process.cwd(), 'src/server/devops-viewer.html');

  if (fs.existsSync(htmlPath)) {
    return res.sendFile(htmlPath);
  }
  if (fs.existsSync(altPath)) {
    return res.sendFile(altPath);
  }

  res.status(404).send('DevOps viewer not found. Run: npm run build:devops');
});

export function createDevopsRoutes(): Router {
  return router;
}
