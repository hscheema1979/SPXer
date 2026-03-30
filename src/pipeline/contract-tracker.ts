import type { Contract, ContractState, OptionType } from '../types';
import { nowET, todayET } from '../utils/et-time';

interface ChainEntry {
  symbol: string;
  strike: number;
  expiry: string;
  type: OptionType;
}

export class ContractTracker {
  private contracts = new Map<string, Contract>();
  private currentSpx = 0;

  constructor(private band: number, private strikeInterval: number) {}

  updateBand(spxPrice: number, chainEntries: ChainEntry[]): Contract[] {
    this.currentSpx = spxPrice;
    const now = Math.floor(Date.now() / 1000);
    const added: Contract[] = [];

    // Add new contracts within band
    for (const entry of chainEntries) {
      if (!this.contracts.has(entry.symbol)) {
        if (Math.abs(entry.strike - spxPrice) <= this.band) {
          const contract: Contract = {
            symbol: entry.symbol, type: entry.type, underlying: 'SPX',
            strike: entry.strike, expiry: entry.expiry, state: 'ACTIVE',
            firstSeen: now, lastBarTs: now, createdAt: now,
          };
          this.contracts.set(entry.symbol, contract);
          added.push(contract);
        }
      }
    }

    // Update states for existing contracts
    for (const [symbol, contract] of this.contracts) {
      if (contract.state === 'EXPIRED') continue;
      const inBand = Math.abs(contract.strike - spxPrice) <= this.band;
      if (inBand && contract.state === 'STICKY') {
        this.contracts.set(symbol, { ...contract, state: 'ACTIVE' });
      } else if (!inBand && contract.state === 'ACTIVE') {
        this.contracts.set(symbol, { ...contract, state: 'STICKY' });
      }
    }

    return added;
  }

  checkExpiries(): void {
    const today = todayET();
    const rthCloseEt = this.isAfterRTHClose();
    for (const [symbol, contract] of this.contracts) {
      if (contract.state === 'EXPIRED') continue;
      if (contract.expiry < today || (contract.expiry === today && rthCloseEt)) {
        this.contracts.set(symbol, { ...contract, state: 'EXPIRED' });
      }
    }
  }

  getTracked(): Contract[] {
    return Array.from(this.contracts.values());
  }

  getActive(): Contract[] {
    return this.getTracked().filter(c => c.state === 'ACTIVE');
  }

  getSticky(): Contract[] {
    return this.getTracked().filter(c => c.state === 'STICKY');
  }

  getExpired(): Contract[] {
    return this.getTracked().filter(c => c.state === 'EXPIRED');
  }

  // Restores a previously persisted contract into in-memory state (startup resume)
  restoreContract(contract: Contract): void {
    if (!this.contracts.has(contract.symbol)) {
      this.contracts.set(contract.symbol, contract);
    }
  }

  private isAfterRTHClose(): boolean {
    const et = nowET();
    return et.h > 16 || (et.h === 16 && et.m >= 15);
  }
}
