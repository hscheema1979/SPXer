/**
 * Tests for src/monitor/prompts.ts
 */

import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, buildSystemPrompt, buildCyclePrompt } from '../../src/monitor/prompts';

describe('SYSTEM_PROMPT (legacy default 3×17)', () => {
  it('mentions the SPX account', () => {
    expect(SYSTEM_PROMPT).toContain('6YA51425');
  });

  it('mentions default HMA strategy', () => {
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

describe('buildSystemPrompt(fast, slow)', () => {
  it('interpolates the active HMA pair (e.g. 3×12)', () => {
    const prompt = buildSystemPrompt(3, 12);
    expect(prompt).toContain('HMA(3)');
    expect(prompt).toContain('HMA(12)');
    expect(prompt).not.toContain('HMA(17)');
  });

  it('still mentions the account and response format', () => {
    const prompt = buildSystemPrompt(5, 19);
    expect(prompt).toContain('6YA51425');
    expect(prompt).toContain('"severity"');
  });

  it('reflects whatever pair is passed', () => {
    expect(buildSystemPrompt(9, 21)).toContain('HMA(9)×HMA(21)');
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
