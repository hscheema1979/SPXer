/**
 * Tests for the agent-runner skeleton.
 *
 * Phase 1 scope: boot validation + banner. These tests lock the shape so
 * future phases can extend without regressing the contract future agents
 * depend on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAgent,
  validateAgentBoot,
  formatBootBanner,
} from '../../src/framework';
import { SPX_0DTE_PROFILE, SPY_1DTE_PROFILE } from '../../src/instruments';
import { DEFAULT_CONFIG } from '../../src/config/defaults';

describe('validateAgentBoot', () => {
  it('accepts a live-capable profile + valid config', () => {
    expect(() => validateAgentBoot(SPX_0DTE_PROFILE, DEFAULT_CONFIG)).not.toThrow();
  });

  it('rejects a profile with no accountId unless allowNoAccount', () => {
    expect(() => validateAgentBoot(SPY_1DTE_PROFILE, DEFAULT_CONFIG)).toThrow(/cannot go live/);
    expect(() =>
      validateAgentBoot(SPY_1DTE_PROFILE, DEFAULT_CONFIG, { allowNoAccount: true })
    ).not.toThrow();
  });

  it('rejects profile with missing id', () => {
    const broken = { ...SPX_0DTE_PROFILE, id: '' };
    expect(() => validateAgentBoot(broken, DEFAULT_CONFIG)).toThrow(/no id/);
  });

  it('rejects profile with non-positive strikeInterval', () => {
    const broken = {
      ...SPX_0DTE_PROFILE,
      options: { ...SPX_0DTE_PROFILE.options, strikeInterval: 0 },
    };
    expect(() => validateAgentBoot(broken, DEFAULT_CONFIG)).toThrow(/strikeInterval/);
  });

  it('rejects config with no id', () => {
    const broken = { ...DEFAULT_CONFIG, id: '' };
    expect(() => validateAgentBoot(SPX_0DTE_PROFILE, broken)).toThrow(/Config has no id/);
  });
});

describe('formatBootBanner', () => {
  it('includes profile id, underlying, account, and config id', () => {
    const ctx = {
      profile: SPX_0DTE_PROFILE,
      config: DEFAULT_CONFIG,
      paper: false,
      startedAt: new Date(),
    };
    const lines = formatBootBanner(ctx);
    const joined = lines.join('\n');
    expect(joined).toContain('spx-0dte');
    expect(joined).toContain('SPX');
    expect(joined).toContain(SPX_0DTE_PROFILE.execution.accountId!);
    expect(joined).toContain(DEFAULT_CONFIG.id);
    expect(joined).toMatch(/LIVE|REAL MONEY/);
  });

  it('shows PAPER mode', () => {
    const ctx = {
      profile: SPX_0DTE_PROFILE,
      config: DEFAULT_CONFIG,
      paper: true,
      startedAt: new Date(),
    };
    const lines = formatBootBanner(ctx);
    expect(lines.join('\n')).toContain('PAPER');
  });

  it('shows "(backtest-only)" for profiles without accountId', () => {
    const ctx = {
      profile: SPY_1DTE_PROFILE,
      config: DEFAULT_CONFIG,
      paper: true,
      startedAt: new Date(),
    };
    expect(formatBootBanner(ctx).join('\n')).toContain('(backtest-only)');
  });
});

describe('runAgent', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('boots with SPX profile and returns a handle', async () => {
    const handle = await runAgent({
      profile: SPX_0DTE_PROFILE,
      config: DEFAULT_CONFIG,
      paper: true,
    });
    expect(handle.context.profile.id).toBe('spx-0dte');
    expect(handle.context.config.id).toBe(DEFAULT_CONFIG.id);
    expect(handle.context.paper).toBe(true);
    expect(handle.context.startedAt).toBeInstanceOf(Date);
    await handle.stop(); // no-op in Phase 1, must not throw
  });

  it('rejects boot with a no-account profile unless allowNoAccount', async () => {
    await expect(
      runAgent({ profile: SPY_1DTE_PROFILE, config: DEFAULT_CONFIG, paper: true })
    ).rejects.toThrow(/cannot go live/);
  });

  it('boots a no-account profile when allowNoAccount=true (data-only/backtest harness)', async () => {
    const handle = await runAgent({
      profile: SPY_1DTE_PROFILE,
      config: DEFAULT_CONFIG,
      paper: true,
      allowNoAccount: true,
    });
    expect(handle.context.profile.id).toBe('spy-1dte');
    await handle.stop();
  });

  it('prints the banner at boot', async () => {
    const handle = await runAgent({
      profile: SPX_0DTE_PROFILE,
      config: DEFAULT_CONFIG,
      paper: true,
    });
    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('SPXer Agent Runner');
    expect(logged).toContain('spx-0dte');
    await handle.stop();
  });
});
