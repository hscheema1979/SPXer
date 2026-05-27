/**
 * sweep-geometry.ts
 *
 * DTE-aware geometry definitions for credit/iron spreads.
 * Provides strike-count spread offsets, widths, and friction parameters calibrated to each timeframe.
 * Strike counts are multiplied by the instrument's strikeInterval to convert to dollars.
 *
 * Example: NDX 5DTE with strikeInterval=25
 *   soS=-8 means 8 strike counts × 25 = $200 ITM short leg
 *   wS=10 means 10 strike counts × 25 = $250 width
 */

export interface SpreadDef {
  soS: number;  // short leg strike offset (strike counts; negative = ITM)
  wS: number;   // spread width (strike counts)
}

export interface DteGeometry {
  spreadDefs: SpreadDef[];
  wingWidths: number[];   // iron/fly: wing width in strike counts
  icOffsets: number[];    // iron: iron collar offset from short strike
  closeHalfSpread: number;        // exit half-spread cost per leg (dollars)
  entrySlippage2leg: number;      // 2-leg slippage (dollars)
  entrySlippage4leg: number;      // 4-leg slippage (dollars)
  exitGateDefault: 'shorts-fresh' | 'none';
}

/**
 * Returns geometry tier for a given DTE.
 * Geometry scales with DTE: wider spreads, larger offsets at longer DTEs.
 *
 * Tiers are RANGE-based (upper-bound buckets), so any DTE — including values not
 * explicitly listed in the registry (e.g. 4, 7, 45) — resolves to the nearest
 * tier at or above it. A DTE between two named tiers takes the higher (wider,
 * more conservative) tier rather than falling through to 40+.
 */
export function geometryForDte(dte: number): DteGeometry {
  if (dte <= 0) {
    // 0DTE: tight spreads, deep ITM focus, very tight exit gate
    return {
      spreadDefs: [
        { soS: -4, wS: 1 },
        { soS: -6, wS: 2 },
        { soS: -8, wS: 3 },
        { soS: -10, wS: 4 },
        { soS: -12, wS: 5 },
      ],
      wingWidths: [1, 2, 3, 4],
      icOffsets: [1, 2, 3],
      closeHalfSpread: 0.10,
      entrySlippage2leg: 25,
      entrySlippage4leg: 35,
      exitGateDefault: 'shorts-fresh',
    };
  }

  if (dte <= 1) {
    // 1DTE: still tight but slightly more room
    return {
      spreadDefs: [
        { soS: -4, wS: 1 },
        { soS: -6, wS: 2 },
        { soS: -8, wS: 3 },
        { soS: -10, wS: 4 },
        { soS: -12, wS: 5 },
        { soS: -14, wS: 6 },
      ],
      wingWidths: [1, 2, 3, 4, 5],
      icOffsets: [1, 2, 3, 4],
      closeHalfSpread: 0.15,
      entrySlippage2leg: 28,
      entrySlippage4leg: 38,
      exitGateDefault: 'shorts-fresh',
    };
  }

  if (dte <= 3) {
    // 2-3DTE: moderate spreads, wider offsets
    return {
      spreadDefs: [
        { soS: -8, wS: 2 },
        { soS: -10, wS: 3 },
        { soS: -12, wS: 4 },
        { soS: -14, wS: 5 },
        { soS: -16, wS: 6 },
        { soS: -18, wS: 8 },
        { soS: -20, wS: 10 },
      ],
      wingWidths: [2, 3, 4, 5, 6, 8],
      icOffsets: [2, 3, 4, 5, 6],
      closeHalfSpread: 0.25,
      entrySlippage2leg: 35,
      entrySlippage4leg: 48,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 5) {
    // 5DTE: balanced spreads, good credit-to-width ratio
    return {
      spreadDefs: [
        { soS: -10, wS: 3 },
        { soS: -12, wS: 4 },
        { soS: -14, wS: 6 },
        { soS: -16, wS: 8 },
        { soS: -18, wS: 10 },
        { soS: -20, wS: 12 },
      ],
      wingWidths: [3, 4, 5, 6, 8, 10],
      icOffsets: [3, 4, 5, 6, 8],
      closeHalfSpread: 0.35,
      entrySlippage2leg: 45,
      entrySlippage4leg: 60,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 10) {
    // 10DTE: wider spreads, more offsets available
    return {
      spreadDefs: [
        { soS: -14, wS: 4 },
        { soS: -16, wS: 6 },
        { soS: -18, wS: 8 },
        { soS: -20, wS: 10 },
        { soS: -22, wS: 14 },
        { soS: -26, wS: 18 },
        { soS: -30, wS: 24 },
      ],
      wingWidths: [4, 6, 8, 10, 12, 16, 20],
      icOffsets: [4, 6, 8, 10, 12, 16],
      closeHalfSpread: 0.50,
      entrySlippage2leg: 55,
      entrySlippage4leg: 75,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 15) {
    // 15DTE: expanded parameter space
    return {
      spreadDefs: [
        { soS: -14, wS: 5 },
        { soS: -16, wS: 8 },
        { soS: -18, wS: 10 },
        { soS: -20, wS: 12 },
        { soS: -24, wS: 16 },
        { soS: -28, wS: 20 },
        { soS: -30, wS: 28 },
      ],
      wingWidths: [5, 8, 10, 12, 16, 20, 24],
      icOffsets: [5, 8, 10, 12, 16, 20],
      closeHalfSpread: 0.55,
      entrySlippage2leg: 60,
      entrySlippage4leg: 82,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 20) {
    // 20DTE: larger spreads, deeper ITM
    return {
      spreadDefs: [
        { soS: -16, wS: 6 },
        { soS: -18, wS: 8 },
        { soS: -20, wS: 12 },
        { soS: -24, wS: 16 },
        { soS: -28, wS: 20 },
        { soS: -32, wS: 26 },
        { soS: -40, wS: 32 },
      ],
      wingWidths: [6, 8, 12, 16, 20, 26, 32],
      icOffsets: [6, 8, 12, 16, 20, 26],
      closeHalfSpread: 0.60,
      entrySlippage2leg: 65,
      entrySlippage4leg: 88,
      exitGateDefault: 'none',
    };
  }

  if (dte <= 30) {
    // 30DTE: extended timeframe, even wider spreads
    return {
      spreadDefs: [
        { soS: -18, wS: 8 },
        { soS: -22, wS: 12 },
        { soS: -26, wS: 18 },
        { soS: -30, wS: 24 },
        { soS: -36, wS: 32 },
        { soS: -40, wS: 40 },
      ],
      wingWidths: [8, 12, 18, 24, 32, 40],
      icOffsets: [8, 12, 18, 24, 32],
      closeHalfSpread: 0.65,
      entrySlippage2leg: 70,
      entrySlippage4leg: 95,
      exitGateDefault: 'none',
    };
  }

  // 40+ DTE: maximum spread width and offset range
  return {
    spreadDefs: [
      { soS: -20, wS: 10 },
      { soS: -24, wS: 16 },
      { soS: -30, wS: 24 },
      { soS: -36, wS: 32 },
      { soS: -44, wS: 44 },
      { soS: -50, wS: 56 },
    ],
    wingWidths: [10, 16, 24, 32, 44, 56],
    icOffsets: [10, 16, 24, 32, 44],
    closeHalfSpread: 0.70,
    entrySlippage2leg: 75,
    entrySlippage4leg: 105,
    exitGateDefault: 'none',
  };
}
