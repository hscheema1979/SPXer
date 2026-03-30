/**
 * Tests for src/monitor/prompts.ts
 */

import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildCyclePrompt } from '../../src/monitor/prompts';

describe('SYSTEM_PROMPT', () => {
  it('mentions both accounts', () => {
    expect(SYSTEM_PROMPT).toContain('6YA51425');
    expect(SYSTEM_PROMPT).toContain('6YA58635');
  });

  it('mentions HMA strategy', () => {
    expect(SYSTEM_PROMPT).toContain('HMA(3)');
    expect(SYSTEM_PROMPT).toContain('HMA(17)');
  });

  it('specifies JSON response format', () => {
    expect(SYSTEM_PROMPT).toContain('"severity"');
    expect(SYSTEM_PROMPT).toContain('"assessment"');
  });

  it('mentions all three severity levels', () => {
    expect(SYSTEM_PROMPT).toContain('"info"');
    expect(SYSTEM_PROMPT).toContain('"warn"');
    expect(SYSTEM_PROMPT).toContain('"alert"');
  });

  it('instructs not to repeat observations', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER repeat');
  });
});

describe('buildCyclePrompt', () => {
  const fakeData = '## Open Positions\nNo positions.\n## Balances\nSPX: $10k';

  it('includes pre-collected data', () => {
    const prompt = buildCyclePrompt('rth', 5, fakeData);
    expect(prompt).toContain('Open Positions');
    expect(prompt).toContain('SPX: $10k');
  });

  it('includes mode-specific instructions for RTH', () => {
    const prompt = buildCyclePrompt('rth', 5, fakeData);
    expect(prompt).toContain('Full analysis');
  });

  it('includes mode-specific instructions for pre-market', () => {
    const prompt = buildCyclePrompt('pre-market', 1, fakeData);
    expect(prompt).toContain('agents are running');
  });

  it('includes mode-specific instructions for post-close', () => {
    const prompt = buildCyclePrompt('post-close', 100, fakeData);
    expect(prompt).toContain('closed/expired');
  });

  it('includes mode-specific instructions for overnight', () => {
    const prompt = buildCyclePrompt('overnight', 200, fakeData);
    expect(prompt).toContain('System health');
  });

  it('includes carryover when provided', () => {
    const carryover = 'CONTEXT: Account was in debit last session.';
    const prompt = buildCyclePrompt('rth', 21, fakeData, carryover);
    expect(prompt).toContain('Account was in debit');
  });

  it('omits carryover when not provided', () => {
    const prompt = buildCyclePrompt('rth', 5, fakeData);
    expect(prompt).not.toContain('CONTEXT FROM PREVIOUS');
  });

  it('requests JSON response', () => {
    const prompt = buildCyclePrompt('rth', 1, fakeData);
    expect(prompt).toContain('JSON object');
  });
});
