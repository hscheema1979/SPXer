/**
 * MarketNarrative — stateful rolling narrative for each scanner.
 *
 * Each scanner (Kimi, GLM, MiniMax) has its own MarketNarrative instance.
 * They each build their own interpretation of the overnight story,
 * their own TLDR, their own trajectory tracking.
 *
 * The Judge receives escalations from each scanner's narrative and weighs them.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface OvernightData {
  esHigh: number;
  esLow: number;
  esClose: number;
  esChange: number;
  esRange: number;
  character: 'choppy' | 'trend' | 'range-bound' | 'volatile';
  vix: number;
  skew: number;
  keyLevels: {
    support: number[];
    resistance: number[];
  };
  news?: string[];
}

export interface PreMarketData {
  impliedOpen: number;
  auctionRange: [number, number];
  imbalance: 'bullish' | 'bearish' | 'neutral';
  contractCount: number;
  callCount: number;
  putCount: number;
  volumeEstimate: number;
  regimeExpectation: string;
}

export interface SessionEvent {
  ts: number;
  timeET: string;
  spx: number;
  rsi: number | null;
  regime: string;
  event: string;
  note?: string;
}

export interface Trajectory {
  rsiHigh: number | null;
  rsiHighTs: number | null;
  rsiLow: number | null;
  rsiLowTs: number | null;
  spxHigh: number | null;
  spxHighTs: number | null;
  spxLow: number | null;
  spxLowTs: number | null;
  spxOpen: number | null;
  spxOpenTs: number | null;
  moves: Array<{
    ts: number;
    description: string;
  }>;
}

export interface Escalation {
  ts: number;
  reason: string;
  trajectory: string;
  scannerRead: string;
  recommendation: string;
  confidence: number;
  rawSnapshot: string;
}

export class MarketNarrative {
  // Identity
  readonly scannerId: string;
  readonly scannerLabel: string;

  // Pre-session data
  overnight: OvernightData | null = null;
  preMarket: PreMarketData | null = null;
  overnightNarrative: string = '';

  // Session data
  sessionEvents: SessionEvent[] = [];
  scannerNotes: string[] = [];
  escalations: Escalation[] = [];

  // Trajectory tracking
  trajectory: Trajectory = {
    rsiHigh: null,
    rsiHighTs: null,
    rsiLow: null,
    rsiLowTs: null,
    spxHigh: null,
    spxHighTs: null,
    spxLow: null,
    spxLowTs: null,
    spxOpen: null,
    spxOpenTs: null,
    moves: [],
  };

  // Judge validation
  judgeOvernightValidation: string | null = null;

  // Timestamps
  sessionStartTs: number | null = null;

  constructor(scannerId: string, scannerLabel: string) {
    this.scannerId = scannerId;
    this.scannerLabel = scannerLabel;
  }

  // ─────────────────────────────────────────────────────────────
  // PRE-SESSION: Overnight data (from collected pipeline data)
  // ─────────────────────────────────────────────────────────────

  setOvernight(data: OvernightData): void {
    this.overnight = data;
    this.overnightNarrative = this.buildOvernightNarrative(data);
  }

  setPreMarket(data: PreMarketData): void {
    this.preMarket = data;
  }

  setJudgeValidation(validation: string): void {
    this.judgeOvernightValidation = validation;
  }

  // ─────────────────────────────────────────────────────────────
  // SESSION: Minute-by-minute updates
  // ─────────────────────────────────────────────────────────────

  startSession(spxOpen: number, ts: number): void {
    this.sessionStartTs = ts;
    this.trajectory.spxOpen = spxOpen;
    this.trajectory.spxOpenTs = ts;
    this.trajectory.spxLow = spxOpen;
    this.trajectory.spxLowTs = ts;
    this.trajectory.spxHigh = spxOpen;
    this.trajectory.spxHighTs = ts;
  }

  appendEvent(
    ts: number,
    timeET: string,
    spx: number,
    rsi: number | null,
    regime: string,
    event: string,
    note?: string
  ): void {
    // Update trajectory
    this.updateTrajectory(ts, spx, rsi, event);

    const sessionEvent: SessionEvent = { ts, timeET, spx, rsi, regime, event, note };
    this.sessionEvents.push(sessionEvent);

    // Keep only last 120 minutes of events (200 events at 30s intervals)
    if (this.sessionEvents.length > 200) {
      this.sessionEvents = this.sessionEvents.slice(-200);
    }
  }

  addScannerNote(note: string): void {
    this.scannerNotes.push(note);
    if (this.scannerNotes.length > 100) {
      this.scannerNotes = this.scannerNotes.slice(-100);
    }
  }

  addEscalation(escalation: Escalation): void {
    this.escalations.push(escalation);
  }

  private updateTrajectory(ts: number, spx: number, rsi: number | null, event: string): void {
    // SPX highs/lows
    if (spx > (this.trajectory.spxHigh ?? -Infinity)) {
      this.trajectory.spxHigh = spx;
      this.trajectory.spxHighTs = ts;
    }
    if (spx < (this.trajectory.spxLow ?? Infinity)) {
      this.trajectory.spxLow = spx;
      this.trajectory.spxLowTs = ts;
    }

    // RSI highs/lows
    if (rsi !== null) {
      if (this.trajectory.rsiHigh === null || rsi > this.trajectory.rsiHigh) {
        this.trajectory.rsiHigh = rsi;
        this.trajectory.rsiHighTs = ts;
      }
      if (this.trajectory.rsiLow === null || rsi < this.trajectory.rsiLow) {
        this.trajectory.rsiLow = rsi;
        this.trajectory.rsiLowTs = ts;
      }
    }

    // Notable moves
    const lastMove = this.trajectory.moves[this.trajectory.moves.length - 1];
    if (event.includes('signal') || event.includes('SCANNER') || event.includes('JUDGE')) {
      this.trajectory.moves.push({ ts, description: event });
      if (this.trajectory.moves.length > 50) {
        this.trajectory.moves = this.trajectory.moves.slice(-50);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BUILD: Narrative strings for prompts
  // ─────────────────────────────────────────────────────────────

  /**
   * Full narrative for scanner prompts (compact)
   */
  buildTLDR(): string {
    const lines: string[] = [];

    // Overnight
    if (this.overnightNarrative) {
      lines.push(`OVERNIGHT: ${this.overnightNarrative.split('\n')[0]}`);
    }

    // Pre-market
    if (this.preMarket) {
      lines.push(`PRE-MKT: Implied ${this.preMarket.impliedOpen}, auction ${this.preMarket.auctionRange[0]}-${this.preMarket.auctionRange[1]}`);
    }

    // Judge validation
    if (this.judgeOvernightValidation) {
      lines.push(`JUDGE: "${this.judgeOvernightValidation.slice(0, 120)}..."`);
    }

    // Recent events (last 5)
    if (this.sessionEvents.length > 0) {
      const recent = this.sessionEvents.slice(-5);
      lines.push('RECENT:');
      for (const e of recent) {
        lines.push(`  ${e.timeET}: SPX=${e.spx} RSI=${e.rsi?.toFixed(1) ?? '-'} ${e.regime} — ${e.event}`);
      }
    }

    // Scanner's own notes
    if (this.scannerNotes.length > 0) {
      lines.push('MY NOTES:');
      for (const note of this.scannerNotes.slice(-5)) {
        lines.push(`  ${note}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Trajectory summary for escalation
   */
  buildTrajectory(): string {
    const t = this.trajectory;
    const lines: string[] = [];

    if (t.spxOpen !== null && t.spxLow !== null && t.spxHigh !== null) {
      const spxMove = t.spxHigh - t.spxLow;
      lines.push(`SPX: opened ${t.spxOpen}, range ${t.spxLow}-${t.spxHigh} (+${spxMove.toFixed(1)} pts)`);
    }

    if (t.rsiLow !== null && t.rsiHigh !== null) {
      lines.push(`RSI: ${t.rsiLow.toFixed(1)} → ${t.rsiHigh.toFixed(1)} (extreme range)`);
    }

    if (t.rsiLow !== null && t.rsiHigh !== null && t.rsiLowTs !== null && t.rsiHighTs !== null) {
      const rsiTimeDiff = Math.round((t.rsiHighTs - t.rsiLowTs) / 60000);
      lines.push(`RSI traveled from ${t.rsiLow.toFixed(1)} to ${t.rsiHigh.toFixed(1)} in ${rsiTimeDiff} minutes`);
    }

    if (t.moves.length > 0) {
      lines.push('KEY MOVES:');
      for (const move of t.moves.slice(-10)) {
        const timeET = new Date(move.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
        lines.push(`  ${timeET}: ${move.description}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Escalation brief for Judge
   */
  buildEscalationBrief(
    scannerRead: string,
    recommendation: string,
    confidence: number,
    rawSnapshot: string
  ): string {
    const lines: string[] = [];

    lines.push('═'.repeat(60));
    lines.push('SCANNER ESCALATION');
    lines.push('═'.repeat(60));
    lines.push(`Scanner: ${this.scannerLabel}`);
    lines.push(`Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })}`);
    lines.push('');

    lines.push('FULL TRAJECTORY:');
    lines.push(this.buildTrajectory());
    lines.push('');

    lines.push('MY NARRATIVE:');
    lines.push(this.buildTLDR());
    lines.push('');

    lines.push('MY READ:');
    lines.push(scannerRead);
    lines.push('');

    lines.push('MY RECOMMENDATION:');
    lines.push(`  ${recommendation} (confidence: ${(confidence * 100).toFixed(0)}%)`);
    lines.push('');

    lines.push('RAW SNAPSHOT:');
    lines.push(rawSnapshot.slice(0, 1000) + (rawSnapshot.length > 1000 ? '...' : ''));

    return lines.join('\n');
  }

  /**
   * Overnight narrative (deterministic, from Pre-Session Agent)
   */
  private buildOvernightNarrative(data: OvernightData): string {
    const lines: string[] = [];

    lines.push(`ES ranged ${data.esLow.toFixed(2)}-${data.esHigh.toFixed(2)} (${data.esRange.toFixed(1)} pts)`);
    lines.push(`ES ${data.esChange >= 0 ? '+' : ''}${data.esChange.toFixed(2)} handles from 4PM close`);
    lines.push(`Character: ${data.character}`);
    lines.push(`VIX: ${data.vix} ${data.vix > 20 ? '(elevated)' : '(normal)'}`);
    lines.push(`Skew: ${(data.skew * 100).toFixed(1)}%`);
    lines.push(`Support: ${data.keyLevels.support.join('/')}`);
    lines.push(`Resistance: ${data.keyLevels.resistance.join('/')}`);

    return lines.join(' | ');
  }

  // ─────────────────────────────────────────────────────────────
  // PERSISTENCE: Write to JSONL for audit
  // ─────────────────────────────────────────────────────────────

  toJSON(): object {
    return {
      scannerId: this.scannerId,
      scannerLabel: this.scannerLabel,
      sessionStartTs: this.sessionStartTs,
      overnight: this.overnight,
      preMarket: this.preMarket,
      judgeOvernightValidation: this.judgeOvernightValidation,
      sessionEvents: this.sessionEvents,
      scannerNotes: this.scannerNotes,
      escalations: this.escalations,
      trajectory: this.trajectory,
    };
  }

  appendToLog(logPath: string): void {
    const entry = JSON.stringify({
      ts: Date.now(),
      ...this.toJSON(),
    });
    fs.appendFileSync(logPath, entry + '\n');
  }

  // ─────────────────────────────────────────────────────────────
  // STATIC: Build from overnight data (called by Pre-Session Agent)
  // ─────────────────────────────────────────────────────────────

  static buildOvernightSummary(data: OvernightData): string {
    const n = new MarketNarrative('pre-session', 'Pre-Session');
    n.setOvernight(data);
    return n.overnightNarrative;
  }
}
