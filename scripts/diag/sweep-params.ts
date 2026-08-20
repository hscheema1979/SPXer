/**
 * sweep-params — structured `params` + profit factor for sweep rows.
 *
 * FR-002 / OA-mimic Phase 0: the sweep engines and the backfill script stamp
 * every row with a machine-readable `params` object (signal/spread/exit) plus a
 * computed `pf` (gross-win / gross-loss), so promotion no longer regex-parses
 * the human label triple. The parsers below are a faithful port of optionx's
 * tested src/bots/sweep-mapper.ts grammar, plus two label forms that engine's
 * regex never matched (see parseSpread / parseExit) — with those, every label
 * these engines emit parses.
 *
 * Consumers:
 *   - scripts/diag/credit-spread-sweep.ts / iron-sweep.ts — stamp rows at summary()
 *   - scripts/diag/annotate-sweep-params.ts — backfill existing output JSONs
 *   - optionx sweep-mapper prefers row.params when present (regex stays fallback)
 *
 * The emitted shape mirrors optionx's ParsedSignal / ParsedSpread / ParsedExit
 * exactly, so `row.params.signal` slots straight into sweepRowToConfig.
 */

// ── signal ──────────────────────────────────────────────────────────────────
export interface SignalParams {
  kind: 'time' | 'swing' | 'intraday';
  indicator: string;
  timeframes: string[];
  hmaFast: number;
  hmaSlow: number;
  trigger: 'cross' | 'state';
  gateStart?: string;
  gateEnd?: string;
  entryTimeET?: string;
  direction?: string;
  swingTf?: 'daily' | 'weekly';
}

export function parseSignal(s: string): SignalParams | null {
  const norm = s.replace(/\s+/g, ' ').trim();
  if (/^1pm daily$/i.test(norm)) {
    return { kind: 'time', indicator: 'HMA', timeframes: ['1d'], hmaFast: 3, hmaSlow: 9, entryTimeET: '13:00', direction: 'bullish', trigger: 'cross' };
  }
  let body = norm;
  let trigger: 'cross' | 'state' = 'cross';
  // Strip the entry-window suffix BEFORE the state suffix so combined labels
  // ("… 3x12 st 10:00-10:30") parse (order-agnostic for single-suffix labels).
  let gateStart: string | undefined;
  let gateEnd: string | undefined;
  const gw = /\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(body);
  if (gw) { gateStart = gw[1]; gateEnd = gw[2]; body = body.slice(0, gw.index).trim(); }
  const st = /\s+st$/i.exec(body);
  if (st) { trigger = 'state'; body = body.slice(0, st.index).trim(); }
  const m = /^(HMA|DEMA)\s+([\dDWhm+]+)\s+(\d+)x(\d+)$/i.exec(body);
  if (!m) return null;
  const mapTfTok = (t: string): string | null => {
    const u = t.trim();
    if (/^\d+[mhdw]$/i.test(u)) return u.toLowerCase();
    if (/^\d+$/.test(u)) return `${u}m`;
    if (u === 'D' || u === 'd') return '1d';
    if (u === 'W' || u === 'w') return '1w';
    return null;
  };
  const timeframes = m[2].split('+').map(mapTfTok);
  if (timeframes.some((t) => t === null)) return null;
  const isSwing = timeframes.some((t) => t === '1d' || t === '1w');
  return {
    kind: isSwing ? 'swing' : 'intraday',
    indicator: m[1].toUpperCase(),
    timeframes: timeframes as string[],
    gateStart, gateEnd,
    hmaFast: +m[3], hmaSlow: +m[4],
    trigger,
    swingTf: timeframes.includes('1w') ? 'weekly' : 'daily',
  };
}

// ── spread ──────────────────────────────────────────────────────────────────
export interface SpreadParams {
  kind: 'iron' | 'bwb' | 'creditSpread' | 'creditPutDelta' | 'long';
  /** iron only: 'condor' = shorts offset from body, 'butterfly' = shorts at body */
  engineKind?: 'condor' | 'butterfly';
  centerOffset?: number;
  wingWidth?: number;
  putWingWidth?: number;
  callWingWidth?: number;
  shortOffset?: number;
  width?: number;
  shortDelta?: number;
}

export function parseSpread(s: string): SpreadParams | null {
  const norm = s.replace(/\s+/g, ' ').trim();
  let m: RegExpExecArray | null;
  // Static condor label ("IC 20w10" — space, no ±): shorts sit ±shortOffset
  // around center. optionx's regex never matched this form; we parse it so
  // condor rows carry honest structure (mapper maps to kind:'ironCondor').
  if ((m = /^IC\s+(\d+)\s*w(\d+)$/i.exec(norm))) {
    return { kind: 'iron', engineKind: 'condor', centerOffset: 0, shortOffset: +m[1], wingWidth: +m[2] };
  }
  if ((m = /^(IB|IC)(?:±(\d+))?\s+w(\d+)$/i.exec(norm))) {
    return { kind: 'iron', engineKind: 'butterfly', centerOffset: m[2] ? +m[2] : 0, wingWidth: +m[3], shortOffset: 0 };
  }
  if ((m = /^BWB\s+(\d+)w(\d+)$/i.exec(norm))) {
    return { kind: 'bwb', putWingWidth: +m[1], callWingWidth: +m[2] };
  }
  if ((m = /^(ATM|(\d+)(ITM|OTM))\s+w(\d+)$/i.exec(norm))) {
    const width = +m[4];
    let shortOffset = 0;
    if (m[1].toUpperCase() !== 'ATM') {
      const dist = +m[2];
      shortOffset = m[3].toUpperCase() === 'ITM' ? -dist : dist;
    }
    return { kind: 'creditSpread', shortOffset, width };
  }
  if ((m = /^(\d*\.?\d+)d\s+w(\d+)c$/i.exec(norm))) {
    return { kind: 'creditPutDelta', shortDelta: +m[1], width: +m[2], shortOffset: 0 };
  }
  if ((m = /^(?:single|long)(?:\s+(ATM|(\d+)(ITM|OTM)))?$/i.exec(norm))) {
    let shortOffset = 0;
    if (m[1] && m[1].toUpperCase() !== 'ATM') {
      const dist = +m[2];
      shortOffset = m[3].toUpperCase() === 'ITM' ? -dist : dist;
    }
    return { kind: 'long', shortOffset, width: 0 };
  }
  return null;
}

// ── exit ────────────────────────────────────────────────────────────────────
export interface ExitParams {
  tpFrac: number;
  slMult: number;
  slPct?: number;
  /** backtest-only risk-fraction SL: fires at V = credit + slRiskFrac×(width−credit) */
  slRiskFrac?: number;
  useFlip: boolean;
  isLong?: boolean;
}

export function parseExit(s: string): ExitParams | null {
  const norm = s.replace(/\s+/g, ' ').trim();
  if (/^hold-to-settle$/i.test(norm)) return { tpFrac: 0, slMult: 0, useFlip: false };
  if (/^flip only$/i.test(norm)) return { tpFrac: 0, slMult: 0, useFlip: true };
  const longM =
    /^TP(\d+)\s*\/\s*SL(\d+(?:\.\d+)?)\s*(only|\+flip)?$/i.exec(norm) ||
    /^(\d+)TP\s*\/\s*(\d+(?:\.\d+)?)SL\s*(only|\+flip)?$/i.exec(norm);
  if (longM) {
    const tpFrac = +longM[1] / 100;
    const slPct = +longM[2] / 100;
    const useFlip = (longM[3] || 'only').toLowerCase() === '+flip';
    return { tpFrac, slPct, slMult: 0, useFlip, isLong: true };
  }
  // Risk-fraction SL label ("TP10 SL70%") — the sweep engines' credit-structure
  // SL parameterization. No live equivalent yet: optionx refuses slRiskFrac>0
  // explicitly instead of mis-mapping it to stopLossMultiplier.
  const rf = /^TP(\d+)\s+SL(\d+(?:\.\d+)?)%$/i.exec(norm);
  if (rf) {
    return { tpFrac: +rf[1] / 100, slMult: 0, slRiskFrac: +rf[2] / 100, useFlip: false };
  }
  const m = /^TP(\d+)(?:\s+(only|\+flip|SL(\d+(?:\.\d+)?)x))?$/i.exec(norm);
  if (!m) return null;
  const tpFrac = +m[1] / 100;
  const mod = (m[2] || 'only').toLowerCase();
  if (mod === 'only') return { tpFrac, slMult: 0, useFlip: false };
  if (mod === '+flip') return { tpFrac, slMult: 0, useFlip: true };
  return { tpFrac, slMult: +m[3], useFlip: false };
}

// ── row-level assembly ──────────────────────────────────────────────────────
export interface RowParams {
  signal: SignalParams;
  spread: SpreadParams;
  exit: ExitParams;
}

/** All three labels must parse, else null (row stays label-only / refused). */
export function parseSweepRowParams(signal: string, spread: string, exit: string): RowParams | null {
  const s = parseSignal(signal);
  const sp = parseSpread(spread);
  const ex = parseExit(exit);
  if (!s || !sp || !ex) return null;
  return { signal: s, spread: sp, exit: ex };
}

/**
 * Profit factor = gross win / |gross loss| (net-of-slippage trade P&Ls).
 * null when there are no losing trades (PF → ∞ — surfaced as a warning by
 * promote-time insights, not silently clamped) or no trades at all.
 */
export function profitFactor(grossWin: number, grossLoss: number): number | null {
  if (!(grossLoss > 0)) return null;
  return +(grossWin / grossLoss).toFixed(2);
}

/** Accumulate one trade's net P&L into gross-win/gross-loss counters. */
export function accumulatePf(acc: { gw: number; gl: number }, pnlNet: number): void {
  if (pnlNet > 0) acc.gw += pnlNet;
  else if (pnlNet < 0) acc.gl += -pnlNet;
}
