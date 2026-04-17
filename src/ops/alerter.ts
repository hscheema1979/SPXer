/**
 * Push alerting via ntfy.sh — zero-config, zero-cost push notifications.
 *
 * Setup (one time):
 *   1. Add NTFY_TOPIC=spxer-alerts-<your-secret> to .env
 *   2. Install the ntfy app on your phone: https://ntfy.sh
 *   3. Subscribe to the same topic name in the app
 *
 * Self-hosted ntfy is also supported: set NTFY_BASE_URL=https://your-server.
 * If NTFY_TOPIC is not set, alerts are logged to console only (safe default).
 *
 * Alert deduplication: identical alerts are suppressed for DEDUP_WINDOW_MS
 * to prevent notification floods during sustained outages.
 */

const NTFY_BASE_URL = process.env.NTFY_BASE_URL || 'https://ntfy.sh';
const NTFY_TOPIC    = process.env.NTFY_TOPIC || '';
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export type AlertSeverity = 'info' | 'warning' | 'critical';

interface AlertRecord {
  lastSentTs: number;
  count: number;
}

// Deduplication map: key → last sent timestamp + count
const sentAlerts = new Map<string, AlertRecord>();

/**
 * Fire an alert. Deduplicates within the 5-minute window.
 * Always logs to console. Sends push notification if NTFY_TOPIC is configured.
 *
 * @param key   — Stable identifier for dedup (e.g. 'db-write-failures', 'tradier-circuit-open')
 * @param title — Short title shown in the notification (< 80 chars)
 * @param body  — Detail message
 * @param severity — info | warning | critical
 */
export async function sendAlert(
  key: string,
  title: string,
  body: string,
  severity: AlertSeverity = 'warning',
): Promise<void> {
  const now = Date.now();
  const existing = sentAlerts.get(key);

  if (existing && now - existing.lastSentTs < DEDUP_WINDOW_MS) {
    existing.count++;
    // Log suppressed alerts at warn level so PM2 logs show them
    if (existing.count % 5 === 0) {
      console.warn(`[alerter] SUPPRESSED (${existing.count}x in 5min): [${severity.toUpperCase()}] ${title}`);
    }
    return;
  }

  sentAlerts.set(key, { lastSentTs: now, count: 1 });

  const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  const logLine = `[alerter] ${emoji} [${severity.toUpperCase()}] ${title}: ${body}`;

  if (severity === 'critical') {
    console.error(logLine);
  } else if (severity === 'warning') {
    console.warn(logLine);
  } else {
    console.log(logLine);
  }

  if (!NTFY_TOPIC) return; // No push configured — console log only

  const priorityMap: Record<AlertSeverity, string> = {
    info: '2',
    warning: '3',
    critical: '5',
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${NTFY_BASE_URL}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        'Title':    title,
        'Priority': priorityMap[severity],
        'Tags':     severity === 'critical' ? 'rotating_light,spxer' : severity === 'warning' ? 'warning,spxer' : 'spxer',
        'Content-Type': 'text/plain',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err: any) {
    // Never let alert delivery fail the calling code — fire and forget
    console.warn(`[alerter] ntfy delivery failed (${err?.message})`);
  }
}

/** Clear dedup state for a key — call when a condition resolves to allow re-alerting */
export function clearAlert(key: string): void {
  sentAlerts.delete(key);
}

// ─── Built-in alert rules ─────────────────────────────────────────────────────
// These run on a 60s interval once startAlertMonitor() is called.
// Import pipelineHealth and health tracker to evaluate conditions.

import { pipelineHealth } from './pipeline-health';
import { getDbStats } from '../storage/db';

let _alertInterval: ReturnType<typeof setInterval> | null = null;

export function startAlertMonitor(): void {
  if (_alertInterval) return; // already running

  _alertInterval = setInterval(async () => {
    const ph = pipelineHealth;

    // ── DB write failures ──────────────────────────────────────────────────
    if (ph.db.writesFailed > 0) {
      await sendAlert(
        'db-write-failures',
        'DB write failures detected',
        `${ph.db.writesFailed} bars lost (${ph.db.writesSucceeded} succeeded). Check PM2 logs for details.`,
        'critical',
      );
    } else {
      clearAlert('db-write-failures');
    }

    // ── WAL size ───────────────────────────────────────────────────────────
    try {
      const { walSizeMb } = getDbStats();
      if (walSizeMb > 100) {
        await sendAlert(
          'wal-growing',
          'WAL file is large',
          `WAL is ${walSizeMb}MB — auto-checkpoint may be stalling. Check disk space and DB locks.`,
          walSizeMb > 300 ? 'critical' : 'warning',
        );
      } else {
        clearAlert('wal-growing');
      }
    } catch { /* ignore */ }

    // ── Indicator NaN rejections ───────────────────────────────────────────
    if (ph.indicators.nanRejected > 0) {
      await sendAlert(
        'indicator-nan',
        'NaN bars rejected by indicator engine',
        `${ph.indicators.nanRejected} invalid bars rejected. Provider may be sending bad data.`,
        'warning',
      );
    }

    // ── Bar validation rejections ──────────────────────────────────────────
    const totalRejected = ph.barBuilder.barsRejected +
      ph.providers.tradier.barsRejected +
      (ph.providers.yahoo?.barsRejected ?? 0);
    if (totalRejected > 5) {
      await sendAlert(
        'bar-validation-failures',
        'Multiple bars rejected by validator',
        `${totalRejected} invalid bars rejected across all providers. Check for bad data or timezone issues.`,
        'warning',
      );
    }

    // ── Circuit breakers open ──────────────────────────────────────────────
    if (ph.providers.tradier.circuitState === 'open') {
      await sendAlert(
        'circuit-tradier',
        'Tradier circuit breaker OPEN',
        'Tradier API circuit breaker is open — no market data or options quotes flowing.',
        'critical',
      );
    } else {
      clearAlert('circuit-tradier');
    }

  }, 60_000); // check every 60 seconds
}

export function stopAlertMonitor(): void {
  if (_alertInterval) {
    clearInterval(_alertInterval);
    _alertInterval = null;
  }
}
