/**
 * fib-bb-option-core.ts
 *
 * Option-pricing layer that maps fib-bb SIGNAL trades (detected on SPY
 * underlying, where volume makes the VWMA basis work) onto tradeable option
 * CONTRACTS (SPX 0DTE primary, SPY fallback) and computes realistic dollar
 * P&L after spread + commission.
 *
 * ── The signal/contract split ──────────────────────────────────────────────
 * fib-bb-core.simulate() runs on SPY 1m bars and produces trades with
 * entryTs/exitTs/dir/exitReason on the UNDERLYING. This module takes those
 * trades and prices the corresponding option contract at entry and exit.
 * The signal fires on SPY; the P&L comes from the SPX (or fallback SPY)
 * contract priced off its OWN underlying bars — both underlyings move
 * together (SPX ≈ SPY × ~300) but the contract price must come from the
 * contract's actual bar.
 *
 * ── Moneyness convention ───────────────────────────────────────────────────
 * `moneyness` = strikes from ATM in the OTM direction. Negative = ITM.
 *   long signal → buy a CALL: strike = ATM + moneyness × interval
 *     (+1 = OTM call, -1 = ITM call, 0 = ATM)
 *   short signal → buy a PUT:  strike = ATM − moneyness × interval
 *     (+1 = OTM put, -1 = ITM put, 0 = ATM)
 *
 * ── Look-ahead ─────────────────────────────────────────────────────────────
 * The option fill at entryTs uses the contract bar at ts >= entryTs (next bar
 * forward if no exact match) — never a prior bar, never the signal bar's own
 * close. The signal already confirms at bar i's close and fills at i+1's open
 * (enforced in fib-bb-core), so entryTs is strictly after the signal bar. We
 * preserve that invariant here by only ever reading bars with ts >= entryTs.
 */
import { frictionEntry, frictionSlExit, frictionTpExit, type SpreadModel } from '../../src/core/friction';

/** A contract symbol → its 1m bars (ts-ascending). */
export type OptionBarMap = Map<string, { ts: number; open: number; high: number; low: number; close: number; volume: number }[]>;

/** Pad a strike to the OCC 8-digit format (strike × 1000). */
export function padStrike(strike: number): string {
  return String(Math.round(strike * 1000)).padStart(8, '0');
}

/** Build an option symbol: prefix + YYMMDD + C/P + padded strike. */
export function buildOptionSymbol(prefix: string, expiryYYMMDD: string, cp: 'C' | 'P', strike: number): string {
  return `${prefix}${expiryYYMMDD}${cp}${padStrike(strike)}`;
}

/** Nearest valid strike for a spot price, given the strike interval. */
export function atmStrike(spot: number, interval: number): number {
  return Math.round(spot / interval) * interval;
}

/** Resolve the target strike from moneyness for a call (long) or put (short). */
export function resolveStrike(dir: 'long' | 'short', atm: number, moneyness: number, interval: number): number {
  return dir === 'long' ? atm + moneyness * interval : atm - moneyness * interval;
}

/** Find the first bar at or after `ts` (forward fill — never reads the past). */
function barAtOrAfter(bars: { ts: number; close: number }[], ts: number): { ts: number; close: number } | null {
  // Linear scan is fine — contract bars per symbol are short (<400/day). The
  // invariant we guard: only return a bar with ts >= ts. A binary search would
  // be faster but the correctness boundary is the ts comparison, not the scan.
  for (const b of bars) if (b.ts >= ts) return b;
  return null;
}

export interface OptFillInput {
  dir: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  moneyness: number;
  strikeInterval: number;
  prefix: 'SPXW' | 'SPY';
  expiry: string;              // YYMMDD
  underlyingAtEntry: number;   // contract's own underlying spot at entryTs (SPX spot for SPX contracts)
  exitKind: 'market' | 'sl' | 'tp';
  spreadModel: SpreadModel;
  qty: number;                 // contracts
}

export interface OptionTrade {
  instrument: 'SPX' | 'SPY';
  symbol: string;
  strike: number;
  cp: 'C' | 'P';
  entryOptPrice: number;   // effective fill (after entry spread)
  exitOptPrice: number;    // effective fill (after exit spread/slippage)
  entryMid: number;
  exitMid: number;
  pnlPerShare: number;
  pnlDollars: number;      // after spread + commission
  dir: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  exitKind: 'market' | 'sl' | 'tp';
}

const COMMISSION_PER_SIDE = 0.35;   // matches src/core/friction.ts default
const SHARES_PER_CONTRACT = 100;

/**
 * Price one option fill. Returns null if the contract or the entry/exit bar is
 * missing — the caller then routes to the fallback instrument.
 *
 * Both entry and exit read bars with ts >= the fill timestamp (forward-fill),
 * so a fill at entryTs can never see a bar before the signal confirmed.
 */
export function priceOptionFill(bars: OptionBarMap, inp: OptFillInput): OptionTrade | null {
  const atm = atmStrike(inp.underlyingAtEntry, inp.strikeInterval);
  const strike = resolveStrike(inp.dir, atm, inp.moneyness, inp.strikeInterval);
  const cp: 'C' | 'P' = inp.dir === 'long' ? 'C' : 'P';
  const symbol = buildOptionSymbol(inp.prefix, inp.expiry, cp, strike);
  const chain = bars.get(symbol);
  if (!chain || chain.length === 0) return null;

  const entryBar = barAtOrAfter(chain, inp.entryTs);
  if (!entryBar || entryBar.close == null) return null;
  const exitBar = barAtOrAfter(chain, inp.exitTs);
  if (!exitBar || exitBar.close == null) return null;

  const entryMid = entryBar.close;
  const exitMid = exitBar.close;
  const entryEff = frictionEntry(entryMid, inp.spreadModel);
  const exitEff = inp.exitKind === 'tp'
    ? frictionTpExit(exitMid)        // limit: no slippage, just the level
    : frictionSlExit(exitMid, inp.spreadModel);  // market/SL: pay the spread

  const pnlPerShare = exitEff - entryEff;
  const pnlDollars = pnlPerShare * SHARES_PER_CONTRACT * inp.qty - 2 * COMMISSION_PER_SIDE;

  return {
    instrument: inp.prefix === 'SPXW' ? 'SPX' : 'SPY',
    symbol, strike, cp,
    entryOptPrice: entryEff, exitOptPrice: exitEff,
    entryMid, exitMid, pnlPerShare, pnlDollars,
    dir: inp.dir, entryTs: entryBar.ts, exitTs: exitBar.ts, exitKind: inp.exitKind,
  };
}

export interface OptNativeInput {
  dir: 'long' | 'short';
  entryTs: number;
  sessionEndTs: number;        // flatten here if neither TP nor SL hit
  moneyness: number;
  strikeInterval: number;
  prefix: 'SPXW' | 'SPY';
  expiry: string;
  underlyingAtEntry: number;
  tpPct: number;               // e.g. 0.50 = exit when premium +50%
  slPct: number;               // e.g. 0.30 = exit when premium -30%
  spreadModel: SpreadModel;
  qty: number;
}

/**
 * Option-NATIVE exit: ignore the underlying signal's exit bar entirely and
 * manage the option by its OWN premium. Scan the contract chain forward from
 * the entry bar; exit at the first bar where:
 *   - mid >= entryEff × (1 + tpPct)  → TP (limit, no spread)
 *   - mid <= entryEff × (1 - slPct)  → SL (market, full spread)
 *   - bar.ts >= sessionEndTs         → session flatten (market)
 *
 * Why this exists: the signal-native exit closes the option when the
 * UNDERLYING mean-reverts to its VWMA basis — often too slow, so theta eats
 * the premium. Option-native TP/SL captures quick gamma pops and caps theta
 * damage with a tight premium stop. Look-ahead is preserved: the scan only
 * walks forward from entryTs, one bar at a time, exiting on the FIRST bar
 * that trips a level (no peeking at later bars to pick the best exit).
 *
 * Within a single bar that straddles both TP and SL, assume SL first
 * (conservative — matches fib-bb-core's discipline).
 */
export function priceOptionNativeExit(bars: OptionBarMap, inp: OptNativeInput): OptionTrade | null {
  const atm = atmStrike(inp.underlyingAtEntry, inp.strikeInterval);
  const strike = resolveStrike(inp.dir, atm, inp.moneyness, inp.strikeInterval);
  const cp: 'C' | 'P' = inp.dir === 'long' ? 'C' : 'P';
  const symbol = buildOptionSymbol(inp.prefix, inp.expiry, cp, strike);
  const chain = bars.get(symbol);
  if (!chain || chain.length === 0) return null;

  // Find the entry bar (first bar at ts >= entryTs).
  let entryIdx = -1;
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].ts >= inp.entryTs && chain[i].close != null) { entryIdx = i; break; }
  }
  if (entryIdx < 0) return null;

  const entryMid = chain[entryIdx].close;
  const entryEff = frictionEntry(entryMid, inp.spreadModel);
  const tpLevel = entryEff * (1 + inp.tpPct);
  const slLevel = entryEff * (1 - inp.slPct);

  let exitIdx = entryIdx;
  let exitKind: 'tp' | 'sl' | 'market' = 'market';
  let exitMid = entryMid;

  for (let i = entryIdx; i < chain.length; i++) {
    const bar = chain[i];
    if (bar.close == null) continue;
    const mid = bar.close;
    exitIdx = i;
    // SL first when ambiguous (conservative).
    if (mid <= slLevel) { exitKind = 'sl'; exitMid = mid; break; }
    if (mid >= tpLevel) { exitKind = 'tp'; exitMid = mid; break; }
    if (bar.ts >= inp.sessionEndTs) { exitKind = 'market'; exitMid = mid; break; }
    exitMid = mid;
  }

  const exitEff = exitKind === 'tp'
    ? frictionTpExit(exitMid)
    : frictionSlExit(exitMid, inp.spreadModel);
  const pnlPerShare = exitEff - entryEff;
  const pnlDollars = pnlPerShare * SHARES_PER_CONTRACT * inp.qty - 2 * COMMISSION_PER_SIDE;

  return {
    instrument: inp.prefix === 'SPXW' ? 'SPX' : 'SPY',
    symbol, strike, cp,
    entryOptPrice: entryEff, exitOptPrice: exitEff,
    entryMid, exitMid, pnlPerShare, pnlDollars,
    dir: inp.dir, entryTs: chain[entryIdx].ts, exitTs: chain[exitIdx].ts, exitKind,
  };
}

// ── Credit spread (2-leg) ─────────────────────────────────────────────────
//
// A credit spread sells premium (theta-positive) and defines risk with a
// long wing. For a mean-reversion signal that expects price to STAY NEAR the
// basis, this is the structurally correct payoff — you profit if price
// doesn't reach the short strike, which is the signal's actual prediction.
//
//   Bullish signal (dir='long')  → PUT credit spread:
//     sell a put at ATM - shortOffset×interval (short leg, below)
//     buy  a put at short - width×interval        (wing, further below)
//     profits if price stays ABOVE the short strike.
//   Bearish signal (dir='short') → CALL credit spread:
//     sell a call at ATM + shortOffset×interval (short leg, above)
//     buy  a call at short + width×interval      (wing, further above)
//     profits if price stays BELOW the short strike.

export interface CreditSpreadInput {
  dir: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  /** Short leg placement: strikes OTM from ATM (in the spread's direction). */
  shortOffset: number;
  /** Wing distance from the short leg, in strikes. width=1 → 5pt on SPX. */
  width: number;
  strikeInterval: number;
  prefix: 'SPXW' | 'SPY';
  expiry: string;
  underlyingAtEntry: number;
  exitKind: 'market' | 'sl' | 'tp';
  spreadModel: SpreadModel;
  qty: number;
}

export interface CreditSpreadTrade {
  structure: 'put_credit' | 'call_credit';
  shortStrike: number;
  wingStrike: number;
  /** Net premium collected at entry, per share (after spread on both legs). */
  entryCredit: number;
  /** Net cost to close the spread at exit, per share (after spread). */
  exitSpreadValue: number;
  pnlPerShare: number;
  pnlDollars: number;     // after spread + commission (4 fills)
  dir: 'long' | 'short';
  entryTs: number;
  exitTs: number;
  exitKind: 'market' | 'sl' | 'tp';
}

/**
 * Price one credit-spread fill. Returns null if EITHER leg's contract or its
 * entry/exit bar is missing.
 *
 * Friction model (per leg, per fill): a SELL receives mid - halfSpread (bid),
 * a BUY pays mid + halfSpread (ask). A credit spread has 4 fills total
 * (2 at entry, 2 at exit) → 4 commissions. TP exits on the closing legs get
 * no spread on the sell side (limit), matching the single-leg discipline.
 */
export function priceCreditSpread(bars: OptionBarMap, inp: CreditSpreadInput): CreditSpreadTrade | null {
  const atm = atmStrike(inp.underlyingAtEntry, inp.strikeInterval);
  const isPut = inp.dir === 'long';   // bullish → put credit spread
  // Short leg: OTM in the spread's direction.
  const shortStrike = isPut ? atm - inp.shortOffset * inp.strikeInterval : atm + inp.shortOffset * inp.strikeInterval;
  // Wing: further OTM by width strikes.
  const wingStrike = isPut ? shortStrike - inp.width * inp.strikeInterval : shortStrike + inp.width * inp.strikeInterval;
  const cp: 'C' | 'P' = isPut ? 'P' : 'C';
  const shortSym = buildOptionSymbol(inp.prefix, inp.expiry, cp, shortStrike);
  const wingSym = buildOptionSymbol(inp.prefix, inp.expiry, cp, wingStrike);
  const shortChain = bars.get(shortSym);
  const wingChain = bars.get(wingSym);
  if (!shortChain?.length || !wingChain?.length) return null;

  const shortEntry = barAtOrAfter(shortChain, inp.entryTs);
  const wingEntry = barAtOrAfter(wingChain, inp.entryTs);
  if (!shortEntry || shortEntry.close == null || !wingEntry || wingEntry.close == null) return null;
  const shortExit = barAtOrAfter(shortChain, inp.exitTs);
  const wingExit = barAtOrAfter(wingChain, inp.exitTs);
  if (!shortExit || shortExit.close == null || !wingExit || wingExit.close == null) return null;

  // ENTRY: sell short (recv bid), buy wing (pay ask). net credit.
  const shortSellPrice = frictionSlExit(shortEntry.close, inp.spreadModel);   // sell → bid
  const wingBuyPrice = frictionEntry(wingEntry.close, inp.spreadModel);       // buy → ask
  const entryCredit = shortSellPrice - wingBuyPrice;

  // EXIT: buy back short (pay ask), sell wing (recv bid, or limit if TP).
  const shortBuyBack = frictionEntry(shortExit.close, inp.spreadModel);       // buy to close → ask
  const wingSell = inp.exitKind === 'tp'
    ? frictionTpExit(wingExit.close)                                           // limit → no spread
    : frictionSlExit(wingExit.close, inp.spreadModel);                         // market → bid
  const exitSpreadValue = shortBuyBack - wingSell;                             // cost to close

  const pnlPerShare = entryCredit - exitSpreadValue;
  // 4 fills (2 entry + 2 exit) × 1 commission each.
  const pnlDollars = pnlPerShare * SHARES_PER_CONTRACT * inp.qty - 4 * COMMISSION_PER_SIDE;

  return {
    structure: isPut ? 'put_credit' : 'call_credit',
    shortStrike, wingStrike, entryCredit, exitSpreadValue,
    pnlPerShare, pnlDollars,
    dir: inp.dir, entryTs: shortEntry.ts, exitTs: shortExit.ts, exitKind: inp.exitKind,
  };
}
