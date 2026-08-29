/**
 * side-cap.ts — shared-pool position-cap simulation.
 *
 * Models the REAL execution constraint (per live evidence 2026-05-22): one shared
 * pool of `maxPositions` slots that both sides draw from, plus an optional per-side
 * sub-cap (e.g. maxCallPositions). Crowding-out is the whole point: a slow side
 * (calls that don't close) squats the shared slots and, once the pool is full,
 * blocks the fast-recycling side (puts that TP and free slots). A per-side sub-cap
 * reserves pool capacity for the side being crowded out.
 *
 * A signal is taken iff: (total open < pool) AND (same-side open < that side's sub-cap).
 * Drop-and-wait, real exit times → captures recycling. 0DTE resets each day.
 * Goal is DIRECTIONAL (point the strategy the right way), not precise — reality differs.
 */
export interface CapEvent { entry: number; exit: number; side: 'call' | 'put'; pnl: number; }
export interface CapPolicy { pool: number; c: number; p: number; }   // pool = shared maxPositions; c = call/bull sub-cap; p = put/bear sub-cap

// Pools to test (11 = the current live cap; higher tests "should the pool be bigger?"; ∞ = capture-all ceiling).
const POOLS = [11, 15, 20, Infinity];
const SUBCAPS = [3, 4, 5, 6];
export const CAP_POLICIES: CapPolicy[] = (() => {
  const out: CapPolicy[] = [];
  for (const pool of POOLS) {
    out.push({ pool, c: Infinity, p: Infinity });               // global pool only — no per-side reservation
    for (const k of SUBCAPS) out.push({ pool, c: k, p: Infinity });  // throttle the call/bull side
    for (const k of SUBCAPS) out.push({ pool, c: Infinity, p: k });  // throttle the put/bear side
  }
  return out;
})();
// Baseline = current live behavior: pool 11, no sub-cap (calls free to squat). Index 0.
export const CAP_BASELINE_IDX = 0;

export const capFmt = (n: number) => (n === Infinity ? '∞' : String(n));
export function capPolicyLabel(p: CapPolicy, aName = 'call', bName = 'put'): string {
  const sub = p.c !== Infinity ? ` ${aName}≤${p.c}` : p.p !== Infinity ? ` ${bName}≤${p.p}` : '';
  return `pool${capFmt(p.pool)}${sub}`;
}

/** Net P&L of one day's events under a shared pool + per-side sub-caps. */
export function capDayNet(events: CapEvent[], pool: number, capCall: number, capPut: number): number {
  const ev = events.length > 1 ? [...events].sort((a, b) => a.entry - b.entry) : events;
  const openC: number[] = [], openP: number[] = [];
  let net = 0;
  for (const e of ev) {
    for (let i = openC.length - 1; i >= 0; i--) if (openC[i] <= e.entry) openC.splice(i, 1);
    for (let i = openP.length - 1; i >= 0; i--) if (openP[i] <= e.entry) openP.splice(i, 1);
    const open = e.side === 'call' ? openC : openP;
    const sub = e.side === 'call' ? capCall : capPut;
    if (openC.length + openP.length < pool && open.length < sub) { open.push(e.exit); net += e.pnl; }
  }
  return net;
}

/** Derive dashboard cap columns from a config's per-policy cumulative nets. */
export function capSummary(capNets: number[], aName: string, bName: string) {
  const base = capNets[CAP_BASELINE_IDX];   // pool 11, no sub-cap (current live)
  let best = -Infinity, bestI = 0, best11 = -Infinity, best11I = CAP_BASELINE_IDX;
  for (let i = 0; i < CAP_POLICIES.length; i++) {
    if (capNets[i] > best) { best = capNets[i]; bestI = i; }
    if (CAP_POLICIES[i].pool === 11 && capNets[i] > best11) { best11 = capNets[i]; best11I = i; }
  }
  return {
    capBaseNet: Math.round(base),                                              // current: pool 11, no sub-cap
    capBest11Net: Math.round(best11), capBest11Pol: capPolicyLabel(CAP_POLICIES[best11I], aName, bName),  // best sub-cap AT pool 11 (actionable now)
    capLift11: Math.round(best11 - base),                                      // gain from the sub-cap fix, same total exposure
    capBestNet: Math.round(best), capBestPol: capPolicyLabel(CAP_POLICIES[bestI], aName, bName),          // best over all pools (incl. raising the cap)
  };
}
