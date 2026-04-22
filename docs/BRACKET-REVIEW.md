# Bracket Order Modeling — Code Review

**Date:** 2026-04-19
**Scope:** OTOCO bracket submission (live), bracket cancellation (live), TP/SL modeling (replay), reconciliation (live), TP re-entry interaction, tick rounding, and friction asymmetry.

This review captures verified findings on the in-progress bracket order work. Each finding cites exact file:line and categorizes severity. Fixes are tracked in `docs/BRACKET-PLAN.md`.

---

## Critical — Live Execution Gaps

### C1. No tick-size rounding on OTOCO prices

**File:** `src/agent/trade-executor.ts:346, 352, 357`

```ts
'price[1]': tpPrice.toFixed(2),      // TP limit
'stop[2]': slPrice.toFixed(2),       // SL stop
params['price[0]'] = entryPrice.toFixed(2);  // entry limit
```

`toFixed(2)` formats to 2 decimals but does **not** round to a valid tick increment. SPX/SPXW option ticks:
- `< $3.00` → $0.05 ticks
- `≥ $3.00` → $0.10 ticks (with penny-pilot series on $0.01)

Example failure: `entryPrice = 1.52`, `takeProfitMultiplier = 2.0` → `tpPrice = 3.04`. Tradier rejects (not a valid tick at $3+), the OTOCO is aborted, and the fallback at lines 256–259 submits a bare entry order with **no server-side protection**.

### C2. OTOCO fallback leaves position unprotected

**File:** `src/agent/trade-executor.ts:245–260`

If the atomic OTOCO request fails for any reason (tick, buying-power, malformed leg), the fallback submits a plain buy order. No subsequent code path attaches OCO protection on the filled position. The only recovery is startup reconciliation — meaning a naked position can sit on a margin account for the remainder of the session.

### C3. Entry fill detection ignores OCO leg status

**File:** `src/agent/trade-executor.ts:63–74`

`waitForFill()` returns `{ status: 'filled' }` as soon as `leg[0].status === 'filled'`. Never inspects `leg[1]` or `leg[2]`. If the entry leg fills but one OCO leg is rejected (partial OTOCO accept), the caller proceeds as if fully protected — but the agent's `position.bracketOrderId` / `tpLegId` / `slLegId` will be undefined for the rejected leg.

---

## High — Replay Modeling Asymmetry

### H1. Friction model is symmetric; TP and SL have different fill mechanics

**Files:** `src/core/friction.ts`, `src/core/fill-model.ts`

Live mechanics:
- **TP**: limit sell. Fills at limit price or better. You provide liquidity → no half-spread cost.
- **SL**: stop → market sell. Pays full half-spread + additional slippage.

`frictionExit()` subtracts a half-spread unconditionally. This **understates TP P&L**: a $2.00 TP reported as $1.95 (after friction) should actually fill near $2.00.

Net backtest effect: TP wins systematically undercounted → composite-score optimization biases toward shorter holds / larger TP multipliers than are truly optimal.

### H2. Intrabar tie-breaker always favors SL

**File:** `src/core/position-manager.ts:59–72`

When a 1m bar has both `bar.low <= stopLoss` AND `bar.high >= takeProfit`, the code returns `stop_loss`. Conservative and safe for replay honesty, but introduces live/replay divergence on bars where the broker actually hits TP first (e.g., gap-up open triggers TP before an intraday dip hits SL).

### H3. Stop-trigger slippage doesn't scale with market conditions

**File:** `src/core/fill-model.ts` (slipSellPrice)

A stop order converts to market on trigger. Fill quality depends on spread width and volatility at that moment. Current model appears to use a fixed slippage; for 0DTE SPX options near the close (wide spreads, high theta), real slippage can be multiples of the modeled value.

---

## Medium — Reconciliation & Re-entry

### M1. Orphan-position TP/SL recomputed from current config, not persisted

**File:** `src/agent/position-manager.ts:127–129`

```ts
const stopLoss = entryPrice * (1 - this.cfg.position.stopLossPercent / 100);
const takeProfit = entryPrice * this.cfg.position.takeProfitMultiplier;
```

After restart, TP/SL are recomputed from current config. If config changed between entry and restart (common during autoresearch), the newly attached bracket may move SL below or TP above the current mark.

### M2. `submitStandaloneOco` has no retry on failure

**File:** `src/agent/position-manager.ts:171–173`

A single `await` with no retry. A 429/5xx or transient network error leaves the orphan position orphaned until the next reconcile cycle (startup only).

### M3. TP re-entry bracket attachment unverified

**Files:** `src/replay/machine.ts:867–907`, `src/agent/trade-executor.ts` (openPosition)

Replay models re-entry as a plain new position with TP/SL fields set. Live agent goes through `openPosition()` → `submitOtocoOrder()`, so re-entries should get brackets. But no test confirms this, and if `submitOtocoOrder()` fails (e.g. C1), the re-entry is unprotected.

---

## Lower Priority

### L1. Cancel race: leg fills between `cancelOcoLegs` and market sell

**File:** `src/agent/position-manager.ts:239–278`

Mitigated by `closePosition()`'s open-order scan at lines 451–483, and Tradier rejects "no position" sells gracefully. Worth a regression test but low real-world impact.

### L2. OTOCO failure paths have no tests

`tests/agent/` lacks a test that simulates Tradier rejecting the OCO leg. Highest-impact untested code path for live safety.

---

## Summary Matrix

| ID | Severity | File | One-line |
|----|----------|------|----------|
| C1 | Critical | trade-executor.ts:346,352,357 | toFixed(2) doesn't round to option tick |
| C2 | Critical | trade-executor.ts:245–260 | OTOCO fallback leaves position unprotected |
| C3 | Critical | trade-executor.ts:63–74 | waitForFill ignores OCO leg status |
| H1 | High | friction.ts + fill-model.ts | TP treated as market sell in friction model |
| H2 | High | position-manager.ts:59–72 | SL always wins tie in intrabar detection |
| H3 | High | fill-model.ts | Stop slippage doesn't scale with spread/vol |
| M1 | Medium | position-manager.ts:127–129 | Orphan TP/SL recomputed from current config |
| M2 | Medium | position-manager.ts:171–173 | submitStandaloneOco has no retry |
| M3 | Medium | machine.ts:867–907 | TP re-entry bracket attachment unverified |
| L1 | Low | position-manager.ts:239–278 | Cancel-vs-fill race |
| L2 | Low | tests/agent/ | OTOCO rejection paths untested |

## Out of Scope (noted during review but tracked elsewhere)

- EOD safety-net loop at `machine.ts:1062–1078` uses `pos.entryPrice` as fallback instead of `0`; however this path should be dead code because `position-manager.ts:127–129` enforces `ts >= closeCutoffTs` exit. Adding a warn-log when this path fires is tracked separately.
- `evaluateEntry` docstring at `trade-manager.ts:154` describes the API contract incorrectly ("BEFORE exits"), though math cancels out correctly. Documentation-only fix.
