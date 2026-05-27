/**
 * sweep-geometry.ts
 *
 * DTE-aware geometry for short-put credit spreads.
 *
 * The short leg is selected by DELTA (constant-delta normalizes moneyness
 * across DTE and vol — a 0.30Δ put is the same probabilistic distance from spot
 * at 5DTE or 60DTE). Delta is computed by the engine via Black-Scholes from the
 * cached option price (no greeks in the feed; see black-scholes.ts/delta-grid.ts).
 *
 * The long protective leg is `width` strike-COUNTS further OTM, scaled at sweep
 * time by the real per-expiry interval derived from the listed chain near spot
 * (strike-grid.ts). The engine sweeps the CROSS-PRODUCT shortDeltas × widths.
 */

export interface DteGeometry {
  // Short-leg target absolute deltas, swept symmetric ITM<->OTM around 0.50:
  // 0.30 (OTM) ... 0.50 (ATM) ... 0.70 (ITM). The engine snaps each to the
  // listed strike whose BS delta is nearest.
  shortDeltas: number[];
  // Long-leg width in STRIKE COUNTS (× per-expiry derived interval = dollars).
  widths: number[];
  wingWidths: number[];   // iron/fly: wing width in strike counts
  icOffsets: number[];    // iron: iron collar offset from short strike
  closeHalfSpread: number;        // exit half-spread cost per leg (dollars)
  entrySlippage2leg: number;      // 2-leg slippage (dollars)
  entrySlippage4leg: number;      // 4-leg slippage (dollars)
  exitGateDefault: 'shorts-fresh' | 'none';
}

/**
 * Returns geometry tier for a given DTE. Tiers are RANGE-based (upper-bound
 * buckets), so any DTE — including values not explicitly listed (4, 7, 45) —
 * resolves to the nearest tier at or above it.
 *
 * Short-delta range is the SAME 0.30–0.70 band across all DTEs (delta already
 * normalizes for time), but longer DTEs add wider `widths` (a $-wider spread is
 * sensible when there's more time/move to absorb). Friction grows with DTE.
 */
export function geometryForDte(dte: number): DteGeometry {

  // Short-leg delta band: 0.30 (OTM) → 0.50 (ATM) → 0.70 (ITM), 0.05 steps.
  // Same across DTEs (delta normalizes for time); widths grow with DTE.
  const DELTAS = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];

  if (dte <= 0) {
    return {
      shortDeltas: DELTAS,
      widths: [1, 2, 3],
      wingWidths: [1, 2, 3],
      icOffsets: [1, 2, 3],
      closeHalfSpread: 0.10,
      entrySlippage2leg: 25,
      entrySlippage4leg: 35,
      exitGateDefault: 'shorts-fresh',
    };
  }

  if (dte <= 1) {
    return {
      shortDeltas: DELTAS,
      widths: [1, 2, 3, 4],
      wingWidths: [1, 2, 3, 4],
      icOffsets: [1, 2, 3, 4],
      closeHalfSpread: 0.15,
      entrySlippage2leg: 28,
      entrySlippage4leg: 38,
      exitGateDefault: 'shorts-fresh',
    };
  }

  if (dte <= 3) {
    return {
      shortDeltas: DELTAS,
      widths: [1, 2, 3, 4, 5],
      wingWidths: [1, 2, 3, 4, 5],
      icOffsets: [1, 2, 3, 4, 5],
      closeHalfSpread: 0.25,
      entrySlippage2leg: 35,
      entrySlippage4leg: 48,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 5) {
    return {
      shortDeltas: DELTAS,
      widths: [2, 3, 4, 5, 6],
      wingWidths: [2, 3, 4, 5, 6],
      icOffsets: [2, 3, 4, 5, 6],
      closeHalfSpread: 0.35,
      entrySlippage2leg: 45,
      entrySlippage4leg: 60,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 10) {
    return {
      shortDeltas: DELTAS,
      widths: [2, 3, 4, 6, 8],
      wingWidths: [2, 3, 4, 6, 8],
      icOffsets: [2, 3, 4, 6, 8],
      closeHalfSpread: 0.50,
      entrySlippage2leg: 55,
      entrySlippage4leg: 75,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 15) {
    return {
      shortDeltas: DELTAS,
      widths: [3, 4, 6, 8, 10],
      wingWidths: [3, 4, 6, 8, 10],
      icOffsets: [3, 4, 6, 8, 10],
      closeHalfSpread: 0.55,
      entrySlippage2leg: 60,
      entrySlippage4leg: 82,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 20) {
    return {
      shortDeltas: DELTAS,
      widths: [4, 6, 8, 10, 12],
      wingWidths: [4, 6, 8, 10, 12],
      icOffsets: [4, 6, 8, 10, 12],
      closeHalfSpread: 0.60,
      entrySlippage2leg: 65,
      entrySlippage4leg: 88,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 30) {
    return {
      shortDeltas: DELTAS,
      widths: [4, 6, 8, 12, 16],
      wingWidths: [4, 6, 8, 12, 16],
      icOffsets: [4, 6, 8, 12, 16],
      closeHalfSpread: 0.65,
      entrySlippage2leg: 70,
      entrySlippage4leg: 95,
      exitGateDefault: 'none',
    };
  }

  // 40+ DTE: widest spreads
  return {
    shortDeltas: DELTAS,
    widths: [6, 8, 12, 16, 20],
    wingWidths: [6, 8, 12, 16, 20],
    icOffsets: [6, 8, 12, 16, 20],
    closeHalfSpread: 0.70,
    entrySlippage2leg: 75,
    entrySlippage4leg: 105,
    exitGateDefault: 'none',
  };
}
