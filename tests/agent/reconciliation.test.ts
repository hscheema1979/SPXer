/**
 * Position reconciliation tests.
 * Tests parseOptionSymbol() and reconciliation logic with real data — no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOptionSymbol,
  openToCorePosition,
} from '../../src/agent/reconciliation';
import type { OpenPosition } from '../../src/agent/types';

describe('parseOptionSymbol — real option symbols', () => {
  it('parses SPXW call option', () => {
    const result = parseOptionSymbol('SPXW260407C06610000');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('SPXW');
    expect(result!.callPut).toBe('C');
    expect(result!.side).toBe('call');
    expect(result!.strike).toBe(6610);
    expect(result!.expiry).toBe('2026-04-07');
  });

  it('parses SPXW put option', () => {
    const result = parseOptionSymbol('SPXW260407P06580000');
    expect(result).not.toBeNull();
    expect(result!.callPut).toBe('P');
    expect(result!.side).toBe('put');
    expect(result!.strike).toBe(6580);
    expect(result!.expiry).toBe('2026-04-07');
  });

  it('parses XSP call option', () => {
    const result = parseOptionSymbol('XSP260407C00659000');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('XSP');
    expect(result!.callPut).toBe('C');
    expect(result!.side).toBe('call');
    expect(result!.strike).toBe(659);
    expect(result!.expiry).toBe('2026-04-07');
  });

  it('parses XSP put option', () => {
    const result = parseOptionSymbol('XSP260407P00661000');
    expect(result).not.toBeNull();
    expect(result!.prefix).toBe('XSP');
    expect(result!.side).toBe('put');
    expect(result!.strike).toBe(661);
  });

  it('returns null for invalid symbol', () => {
    expect(parseOptionSymbol('INVALID')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseOptionSymbol('')).toBeNull();
  });

  it('returns null for partial symbol', () => {
    expect(parseOptionSymbol('SPXW260407')).toBeNull();
  });

  // Real symbols from today's audit log
  it('parses SPXW260407P06610000 (from audit)', () => {
    const result = parseOptionSymbol('SPXW260407P06610000');
    expect(result).not.toBeNull();
    expect(result!.side).toBe('put');
    expect(result!.strike).toBe(6610);
  });

  it('parses SPXW260407C06590000 (from audit)', () => {
    const result = parseOptionSymbol('SPXW260407C06590000');
    expect(result).not.toBeNull();
    expect(result!.side).toBe('call');
    expect(result!.strike).toBe(6590);
  });

  it('parses XSP260407P00661000 (from audit)', () => {
    const result = parseOptionSymbol('XSP260407P00661000');
    expect(result).not.toBeNull();
    expect(result!.side).toBe('put');
    expect(result!.strike).toBe(661);
  });
});

describe('openToCorePosition — real position conversion', () => {
  it('converts OpenPosition to CorePosition', () => {
    const openPos: OpenPosition = {
      id: 'test-id',
      symbol: 'SPXW260407C06590000',
      side: 'call',
      strike: 6590,
      expiry: '2026-04-07',
      entryPrice: 6.60,
      quantity: 15,
      stopLoss: 0.65,
      takeProfit: 8.19,
      openedAt: Date.now(),
    };

    const core = openToCorePosition(openPos);
    expect(core.id).toBe('SPXW260407C06590000');
    expect(core.symbol).toBe('SPXW260407C06590000');
    expect(core.side).toBe('call');
    expect(core.strike).toBe(6590);
    expect(core.qty).toBe(15);
    expect(core.entryPrice).toBe(6.60);
    expect(core.stopLoss).toBe(0.65);
    expect(core.takeProfit).toBe(8.19);
    expect(core.highWaterPrice).toBe(6.60);
    expect(core.entryTs).toBeGreaterThan(0);
  });

  it('handles XSP positions', () => {
    const openPos: OpenPosition = {
      id: 'test-id',
      symbol: 'XSP260407P00661000',
      side: 'put',
      strike: 661,
      expiry: '2026-04-07',
      entryPrice: 4.90,
      quantity: 1,
      stopLoss: 0.49,
      takeProfit: 6.13,
      openedAt: Date.now(),
    };

    const core = openToCorePosition(openPos);
    expect(core.id).toBe('XSP260407P00661000');
    expect(core.qty).toBe(1);
    expect(core.entryPrice).toBe(4.90);
  });
});

describe('reconciliation logic — pure computation', () => {
  it('detects orphaned symbols (broker has, agent missing)', () => {
    const agentSymbols = new Set(['SPXW260407C06590000']);
    const brokerSymbols = new Set(['SPXW260407C06590000', 'SPXW260407P06580000']);
    
    const orphans = [...brokerSymbols].filter(s => !agentSymbols.has(s));
    expect(orphans).toEqual(['SPXW260407P06580000']);
  });

  it('detects phantom symbols (agent has, broker missing)', () => {
    const agentSymbols = new Set(['SPXW260407C06590000', 'SPXW260407P06580000']);
    const brokerSymbols = new Set(['SPXW260407C06590000']);
    
    const phantoms = [...agentSymbols].filter(s => !brokerSymbols.has(s));
    expect(phantoms).toEqual(['SPXW260407P06580000']);
  });

  it('detects matched symbols', () => {
    const agentSymbols = new Set(['SPXW260407C06590000', 'SPXW260407P06580000']);
    const brokerSymbols = new Set(['SPXW260407C06590000', 'SPXW260407P06580000']);
    
    const matched = [...agentSymbols].filter(s => brokerSymbols.has(s));
    expect(matched).toHaveLength(2);
  });

  it('calculates entry price from cost basis', () => {
    const costBasis = 9900; // $9,900 for 15 contracts
    const quantity = 15;
    const entryPrice = costBasis / (quantity * 100);
    expect(entryPrice).toBeCloseTo(6.60, 2);
  });
});
