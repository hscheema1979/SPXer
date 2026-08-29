/**
 * study-stats.ts — small pure summary helpers shared by the diag studies.
 *
 * Break-even win rate is the number that keeps credit-spread studies honest: a
 * 90% win rate means nothing until you know the structure needed 88% to break
 * even. Reporting WR without BE-WR is how a tight-wing row looks like an edge
 * when it is actually picking up pennies in front of the bulldozer.
 */

export interface Summary {
  n: number;
  wins: number;
  wr: number;            // % of trades with net P&L > 0
  beWr: number | null;   // % win rate needed to break even, from realised avgWin/avgLoss
  edge: number | null;   // wr - beWr, in points of win rate. Positive = real edge.
  avgPnl: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;       // reported POSITIVE
  profitFactor: number | null;
  p5: number;            // 5th-percentile trade (left tail)
  worst: number;
  maxDD: number;         // peak-to-trough on the date-ordered cumulative curve
}

/**
 * Win rate required to break even given average win and average loss sizes.
 * beWR = avgLoss / (avgWin + avgLoss). Null when either side has no samples —
 * an all-winners sample has no measured loss and therefore no honest BE-WR.
 */
export function breakEvenWinRate(avgWin: number, avgLoss: number): number | null {
  if (!(avgWin > 0) || !(avgLoss > 0)) return null;
  return 100 * avgLoss / (avgWin + avgLoss);
}

/**
 * Nearest-rank percentile of an UNSORTED sample. p is 0-100.
 * percentile(xs, 5) is the 5th-percentile (left-tail) value.
 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1));
  return s[idx];
}

/**
 * Summarise a sequence of net P&L values. Order matters for maxDD only — pass
 * them in chronological order.
 */
export function summarize(pnls: number[]): Summary {
  const n = pnls.length;
  if (!n) return { n: 0, wins: 0, wr: 0, beWr: null, edge: null, avgPnl: 0, totalPnl: 0,
    avgWin: 0, avgLoss: 0, profitFactor: null, p5: NaN, worst: NaN, maxDD: 0 };
  let wins = 0, winSum = 0, lossSum = 0, total = 0, cum = 0, peak = 0, maxDD = 0, worst = Infinity;
  for (const v of pnls) {
    total += v;
    if (v > 0) { wins++; winSum += v; } else lossSum += -v;
    if (v < worst) worst = v;
    cum += v; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const losses = n - wins;
  const avgWin = wins ? winSum / wins : 0;
  const avgLoss = losses ? lossSum / losses : 0;
  const wr = 100 * wins / n;
  const beWr = breakEvenWinRate(avgWin, avgLoss);
  return {
    n, wins, wr: +wr.toFixed(1), beWr: beWr == null ? null : +beWr.toFixed(1),
    edge: beWr == null ? null : +(wr - beWr).toFixed(1),
    avgPnl: +(total / n).toFixed(2), totalPnl: Math.round(total),
    avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    profitFactor: lossSum > 0 ? +(winSum / lossSum).toFixed(2) : null,
    p5: Math.round(percentile(pnls, 5)), worst: Math.round(worst), maxDD: Math.round(maxDD),
  };
}
