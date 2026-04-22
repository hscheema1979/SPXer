/**
 * Tests for src/monitor/engine.ts
 *
 * All time-dependent functions accept injectable `now` parameters,
 * so we test with fixed dates — no mocking needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMonitorInterval,
  isEarlyCloseDay,
  AlertDedup,
  SessionCycleManager,
  collectPreLLMData,
  type MonitorMode,
  type MonitorTools,
} from '../../src/monitor/engine';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a Date in ET by computing UTC offset. EDT = UTC-4, EST = UTC-5. */
function etDate(dateStr: string, timeET: string, edt = true): Date {
  const offsetHours = edt ? 4 : 5;
  const [h, m] = timeET.split(':').map(Number);
  const totalMinutes = (h + offsetHours) * 60 + m;
  // Handle day rollover (e.g., 22:00 ET + 4h = 02:00 UTC next day)
  const utcDate = new Date(`${dateStr}T00:00:00.000Z`);
  utcDate.setUTCMinutes(totalMinutes);
  return utcDate;
}

// ── getMonitorInterval ──────────────────────────────────────────────────────

describe('getMonitorInterval', () => {
  it('returns closed for Saturday', () => {
    // 2026-03-28 is a Saturday
    const sat = etDate('2026-03-28', '12:00');
    const result = getMonitorInterval(sat);
    expect(result.mode).toBe('closed');
    expect(result.intervalMs).toBe(0);
  });

  it('returns closed for Sunday', () => {
    // 2026-03-29 is a Sunday
    const sun = etDate('2026-03-29', '12:00');
    const result = getMonitorInterval(sun);
    expect(result.mode).toBe('closed');
    expect(result.intervalMs).toBe(0);
  });

  it('returns closed for holiday', () => {
    // 2026-01-19 is MLK Day (Monday)
    const holiday = etDate('2026-01-19', '10:00', false); // January = EST
    const result = getMonitorInterval(holiday);
    expect(result.mode).toBe('closed');
  });

  it('returns overnight for early morning weekday', () => {
    // 2026-03-30 is a Monday, 6:00 AM ET
    const early = etDate('2026-03-30', '06:00');
    const result = getMonitorInterval(early);
    expect(result.mode).toBe('overnight');
    expect(result.intervalMs).toBe(30 * 60 * 1000);
  });

  it('returns pre-market for 7:30 AM ET', () => {
    const preMarket = etDate('2026-03-30', '07:30');
    const result = getMonitorInterval(preMarket);
    expect(result.mode).toBe('pre-market');
    expect(result.intervalMs).toBe(5 * 60 * 1000);
  });

  it('returns rth for 10:00 AM ET', () => {
    const rth = etDate('2026-03-30', '10:00');
    const result = getMonitorInterval(rth);
    expect(result.mode).toBe('rth');
    expect(result.intervalMs).toBe(30 * 1000);
  });

  it('returns rth for 8:00 AM ET (market open)', () => {
    const open = etDate('2026-03-30', '08:00');
    const result = getMonitorInterval(open);
    expect(result.mode).toBe('rth');
  });

  it('returns rth for 16:59 ET (1 min before close)', () => {
    const beforeClose = etDate('2026-03-30', '16:59');
    const result = getMonitorInterval(beforeClose);
    expect(result.mode).toBe('rth');
  });

  it('returns post-close for 17:00 ET', () => {
    const close = etDate('2026-03-30', '17:00');
    const result = getMonitorInterval(close);
    expect(result.mode).toBe('post-close');
    expect(result.intervalMs).toBe(2 * 60 * 1000);
  });

  it('returns post-close for 17:15 ET', () => {
    const postClose = etDate('2026-03-30', '17:15');
    const result = getMonitorInterval(postClose);
    expect(result.mode).toBe('post-close');
  });

  it('returns overnight for 17:30 ET', () => {
    const evening = etDate('2026-03-30', '17:30');
    const result = getMonitorInterval(evening);
    expect(result.mode).toBe('overnight');
  });

  it('returns overnight for 22:00 ET', () => {
    const night = etDate('2026-03-30', '22:00');
    const result = getMonitorInterval(night);
    expect(result.mode).toBe('overnight');
  });

  it('handles early close day — rth ends at 13:00 ET', () => {
    // 2026-11-27 is an early close day (Friday after Thanksgiving)
    // At 12:30 ET should be rth, at 13:00 should be post-close
    const beforeEarly = etDate('2026-11-27', '12:30', false); // November = EST
    const rth = getMonitorInterval(beforeEarly);
    expect(rth.mode).toBe('rth');

    const afterEarly = etDate('2026-11-27', '13:05', false);
    const postClose = getMonitorInterval(afterEarly);
    expect(postClose.mode).toBe('post-close');

    const eveningEarly = etDate('2026-11-27', '13:35', false);
    const overnight = getMonitorInterval(eveningEarly);
    expect(overnight.mode).toBe('overnight');
  });
});

describe('isEarlyCloseDay', () => {
  it('returns true for known early close days', () => {
    const earlyClose = etDate('2026-11-27', '10:00', false);
    expect(isEarlyCloseDay(earlyClose)).toBe(true);
  });

  it('returns false for normal days', () => {
    const normal = etDate('2026-03-30', '10:00');
    expect(isEarlyCloseDay(normal)).toBe(false);
  });
});

// ── AlertDedup ──────────────────────────────────────────────────────────────

describe('AlertDedup', () => {
  let dedup: AlertDedup;

  beforeEach(() => {
    dedup = new AlertDedup(5 * 60 * 1000); // 5 min window
  });

  it('logs first occurrence', () => {
    const result = dedup.shouldLog('Negative buying power -$87', 'alert', 1000);
    expect(result.log).toBe(true);
    expect(result.summary).toBeUndefined();
  });

  it('suppresses duplicate within window', () => {
    const t0 = 1000;
    dedup.shouldLog('Negative buying power -$87', 'alert', t0);
    const r2 = dedup.shouldLog('Negative buying power -$87', 'alert', t0 + 30_000);
    expect(r2.log).toBe(false);
  });

  it('suppresses multiple duplicates', () => {
    const t0 = 1000;
    dedup.shouldLog('Negative buying power -$87', 'alert', t0);
    for (let i = 1; i <= 10; i++) {
      const r = dedup.shouldLog('Negative buying power -$87', 'alert', t0 + i * 30_000);
      if (t0 + i * 30_000 - t0 < 5 * 60 * 1000) {
        expect(r.log).toBe(false);
      }
    }
  });

  it('emits summary after dedup window expires', () => {
    const t0 = 0;
    dedup.shouldLog('Negative buying power -$87', 'alert', t0);
    // Fire 10 more within window
    for (let i = 1; i <= 10; i++) {
      dedup.shouldLog('Negative buying power -$87', 'alert', t0 + i * 20_000);
    }
    // Fire again after 5+ minutes
    const result = dedup.shouldLog('Negative buying power -$87', 'alert', t0 + 6 * 60 * 1000);
    expect(result.log).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary).toContain('×');
    expect(result.summary).toContain('still unresolved');
  });

  it('logs different messages independently', () => {
    const t0 = 1000;
    const r1 = dedup.shouldLog('Negative buying power', 'alert', t0);
    const r2 = dedup.shouldLog('Disk space critical', 'alert', t0 + 1000);
    expect(r1.log).toBe(true);
    expect(r2.log).toBe(true);
  });

  it('differentiates by severity', () => {
    const t0 = 1000;
    const r1 = dedup.shouldLog('Buying power low', 'warn', t0);
    const r2 = dedup.shouldLog('Buying power low', 'alert', t0 + 1000);
    expect(r1.log).toBe(true);
    expect(r2.log).toBe(true); // different severity = different hash
  });

  it('normalizes dollar amounts for dedup', () => {
    const t0 = 1000;
    dedup.shouldLog('Buying power is -$87.46', 'alert', t0);
    // Same message with different dollar amount — should still dedup
    const r = dedup.shouldLog('Buying power is -$87.46', 'alert', t0 + 10_000);
    expect(r.log).toBe(false);
  });

  it('tracks active count', () => {
    dedup.shouldLog('Alert 1', 'alert', 1000);
    dedup.shouldLog('Alert 2', 'warn', 2000);
    expect(dedup.activeCount).toBe(2);
  });

  it('clear resets everything', () => {
    dedup.shouldLog('Alert 1', 'alert', 1000);
    dedup.clear();
    expect(dedup.activeCount).toBe(0);
    // Same message should log again
    const r = dedup.shouldLog('Alert 1', 'alert', 2000);
    expect(r.log).toBe(true);
  });
});

// ── SessionCycleManager ─────────────────────────────────────────────────────

describe('SessionCycleManager', () => {
  let mgr: SessionCycleManager;

  beforeEach(() => {
    mgr = new SessionCycleManager(20);
  });

  it('tracks cycle count', () => {
    expect(mgr.getCycleCount()).toBe(0);
    mgr.tick();
    expect(mgr.getCycleCount()).toBe(1);
    mgr.tick();
    expect(mgr.getCycleCount()).toBe(2);
  });

  it('tick returns current cycle', () => {
    expect(mgr.tick()).toBe(1);
    expect(mgr.tick()).toBe(2);
  });

  it('shouldReset is false on cycle 1', () => {
    mgr.tick(); // cycle 1
    expect(mgr.shouldReset()).toBe(false);
  });

  it('shouldReset is true on cycle 21 (after 20 cycles)', () => {
    for (let i = 0; i < 21; i++) {
      mgr.tick();
    }
    expect(mgr.getCycleCount()).toBe(21);
    expect(mgr.shouldReset()).toBe(true);
  });

  it('shouldReset is false on cycle 22', () => {
    for (let i = 0; i < 22; i++) {
      mgr.tick();
    }
    expect(mgr.shouldReset()).toBe(false);
  });

  it('shouldReset is true again on cycle 41', () => {
    for (let i = 0; i < 41; i++) {
      mgr.tick();
    }
    expect(mgr.shouldReset()).toBe(true);
  });

  it('buildCarryoverSummary with no prior assessment', () => {
    const summary = mgr.buildCarryoverSummary();
    expect(summary).toContain('fresh monitoring session');
  });

  it('buildCarryoverSummary with stored assessment', () => {
    mgr.tick();
    mgr.setLastAssessment('Both accounts clean, no positions open. SPX at 6335.');
    const summary = mgr.buildCarryoverSummary();
    expect(summary).toContain('PREVIOUS SESSION');
    expect(summary).toContain('Both accounts clean');
    expect(summary).toContain('Do not repeat');
  });

  it('buildCarryoverSummary includes long assessments with context wrapper', () => {
    mgr.tick();
    const longText = 'A'.repeat(1000);
    mgr.setLastAssessment(longText);
    const summary = mgr.buildCarryoverSummary();
    expect(summary).toContain('CONTEXT FROM PREVIOUS SESSION');
    expect(summary).toContain(longText);
  });

  it('buildCarryoverSummary accepts explicit text override', () => {
    const summary = mgr.buildCarryoverSummary('Override text here');
    expect(summary).toContain('Override text here');
  });
});

// ── collectPreLLMData ───────────────────────────────────────────────────────

describe('collectPreLLMData', () => {
  function mockTools(overrides: Partial<MonitorTools> = {}): MonitorTools {
    return {
      getPositions: async () => 'No positions.',
      getOrders: async (_a, filter) => `Orders (${filter}): none.`,
      getBalance: async () => 'SPX: $10k',
      getMarketSnapshot: async () => 'SPX 6335 RSI 52 HMA BULLISH',
      getAgentStatus: async () => 'SPX agent running.',
      checkSystemHealth: async () => 'Disk 76%, DB 13G, all processes up.',
      ...overrides,
    };
  }

  it('overnight mode only calls checkSystemHealth', async () => {
    let healthCalled = false;
    let positionsCalled = false;
    const tools = mockTools({
      checkSystemHealth: async () => { healthCalled = true; return 'Disk OK'; },
      getPositions: async () => { positionsCalled = true; return 'No positions.'; },
    });

    const data = await collectPreLLMData('overnight', 1, tools);
    expect(healthCalled).toBe(true);
    expect(positionsCalled).toBe(false);
    expect(data).toContain('System Health');
    expect(data).toContain('OVERNIGHT');
  });

  it('pre-market calls balance, health, agent status', async () => {
    const called: string[] = [];
    const tools = mockTools({
      getBalance: async () => { called.push('balance'); return 'OK'; },
      checkSystemHealth: async () => { called.push('health'); return 'OK'; },
      getAgentStatus: async () => { called.push('status'); return 'OK'; },
      getPositions: async () => { called.push('positions'); return 'none'; },
    });

    const data = await collectPreLLMData('pre-market', 5, tools);
    expect(called).toContain('balance');
    expect(called).toContain('health');
    expect(called).toContain('status');
    expect(called).not.toContain('positions');
    expect(data).toContain('PRE-MARKET');
  });

  it('rth calls all tools', async () => {
    const called: string[] = [];
    const tools = mockTools({
      getPositions: async () => { called.push('positions'); return 'none'; },
      getOrders: async () => { called.push('orders'); return 'none'; },
      getBalance: async () => { called.push('balance'); return 'OK'; },
      getMarketSnapshot: async () => { called.push('snapshot'); return 'SPX 6335'; },
      getAgentStatus: async () => { called.push('status'); return 'OK'; },
      checkSystemHealth: async () => { called.push('health'); return 'OK'; },
    });

    const data = await collectPreLLMData('rth', 10, tools);
    expect(called).toContain('positions');
    expect(called).toContain('orders');
    expect(called).toContain('balance');
    expect(called).toContain('snapshot');
    expect(called).toContain('status');
    expect(called).toContain('health');
    expect(data).toContain('RTH');
  });

  it('post-close calls positions, balance, orders, status, health', async () => {
    const called: string[] = [];
    const tools = mockTools({
      getPositions: async () => { called.push('positions'); return 'none'; },
      getOrders: async () => { called.push('orders'); return 'none'; },
      getBalance: async () => { called.push('balance'); return 'OK'; },
      getAgentStatus: async () => { called.push('status'); return 'OK'; },
      checkSystemHealth: async () => { called.push('health'); return 'OK'; },
      getMarketSnapshot: async () => { called.push('snapshot'); return 'SPX'; },
    });

    const data = await collectPreLLMData('post-close', 20, tools);
    expect(called).toContain('positions');
    expect(called).toContain('balance');
    expect(called).toContain('orders');
    expect(called).toContain('status');
    expect(called).toContain('health');
    expect(called).not.toContain('snapshot');
    expect(data).toContain('POST-CLOSE');
  });

  it('handles tool errors gracefully', async () => {
    const tools = mockTools({
      getPositions: async () => { throw new Error('Tradier timeout'); },
      getOrders: async () => { throw new Error('Tradier timeout'); },
      getBalance: async () => { throw new Error('Tradier timeout'); },
      getMarketSnapshot: async () => { throw new Error('timeout'); },
      getAgentStatus: async () => { throw new Error('file not found'); },
      checkSystemHealth: async () => { throw new Error('df failed'); },
    });

    const data = await collectPreLLMData('rth', 1, tools);
    expect(data).toContain('Data Collection Error');
  });

  it('includes cycle number and mode in header', async () => {
    const tools = mockTools();
    const data = await collectPreLLMData('rth', 42, tools);
    expect(data).toContain('CYCLE #42');
    expect(data).toContain('RTH');
  });
});
