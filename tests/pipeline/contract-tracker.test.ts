// tests/pipeline/contract-tracker.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContractTracker } from '../../src/pipeline/contract-tracker';

describe('ContractTracker', () => {
  let tracker: ContractTracker;

  beforeEach(() => {
    tracker = new ContractTracker(100, 5); // band=100, interval=5
  });

  it('adds contracts within band as ACTIVE', () => {
    const added = tracker.updateBand(5000, [
      { symbol: 'SPXW260318C05000000', strike: 5000, expiry: '2026-03-18', type: 'call' as const },
      { symbol: 'SPXW260318C05105000', strike: 5105, expiry: '2026-03-18', type: 'call' as const },
    ]);
    expect(added.some(c => c.symbol === 'SPXW260318C05000000')).toBe(true);
    // 5105 is > 100 away from 5000, so only the ATM contract is added
    expect(tracker.getActive().length).toBe(1);
  });

  it('keeps contract STICKY when price moves outside band', () => {
    tracker.updateBand(5000, [
      { symbol: 'SPXW260318C05000000', strike: 5000, expiry: '2026-03-18', type: 'call' as const },
    ]);
    // SPX moves to 5200 — 5000 strike is now 200 away
    tracker.updateBand(5200, []);
    const all = tracker.getTracked();
    const contract = all.find(c => c.symbol === 'SPXW260318C05000000');
    expect(contract?.state).toBe('STICKY');
  });

  it('transitions STICKY back to ACTIVE when price returns', () => {
    tracker.updateBand(5000, [
      { symbol: 'SPXW260318C05000000', strike: 5000, expiry: '2026-03-18', type: 'call' as const },
    ]);
    tracker.updateBand(5200, []); // goes STICKY
    tracker.updateBand(5050, []); // returns within band
    const contract = tracker.getTracked().find(c => c.symbol === 'SPXW260318C05000000');
    expect(contract?.state).toBe('ACTIVE');
  });

  it('marks contracts EXPIRED after expiry', () => {
    const pastExpiry = '2020-01-01';
    tracker.updateBand(5000, [
      { symbol: 'SPXW200101C05000000', strike: 5000, expiry: pastExpiry, type: 'call' as const },
    ]);
    tracker.checkExpiries();
    const contract = tracker.getTracked().find(c => c.symbol === 'SPXW200101C05000000');
    expect(contract?.state).toBe('EXPIRED');
  });
});
