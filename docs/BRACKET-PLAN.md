# Bracket Order Modeling — Implementation Plan

**Source review:** `docs/BRACKET-REVIEW.md`
**Goal:** Close the gaps that can leave live positions unprotected and remove the systematic bias in replay P&L around bracket fills.
**Ordering principle:** Fix live-safety defects first (C1–C3), then correct replay accuracy (H1–H3), then reconciliation/cleanup (M1–M3, L1–L2).

Each phase is independently shippable. Replay parity must be validated after every phase (autoresearch composite score should change in expected direction, not silently break existing behavior).

---

## Phase 1 — Live Safety (Critical)

### Task 1.1 — Add option tick-size helper and use it everywhere (C1)

**New file:** `src/core/option-tick.ts`

```ts
/**
 * Round an option price to a valid exchange tick increment.
 * SPX/SPXW tick rules (as of 2026):
 *   - price < $3.00 → $0.05 ticks
 *   - price >= $3.00 → $0.10 ticks (penny-pilot classes honor $0.01;
 *     SPXW does not qualify — keep $0.10)
 * Rounds to nearest tick (not floor/ceil) to keep TP/SL intent.
 */
export function roundToOptionTick(price: number): number;
```

**Edits:**
- `src/agent/trade-executor.ts:346` → `roundToOptionTick(tpPrice).toFixed(2)`
- `src/agent/trade-executor.ts:352` → `roundToOptionTick(slPrice).toFixed(2)`
- `src/agent/trade-executor.ts:357` → `roundToOptionTick(entryPrice).toFixed(2)`
- `src/agent/position-manager.ts:208` → `roundToOptionTick(tp).toFixed(2)`
- `src/agent/position-manager.ts:214` → `roundToOptionTick(sl).toFixed(2)`

**Tests:** `tests/core/option-tick.test.ts` — boundary cases: `2.99→2.95`, `3.00→3.00`, `3.04→3.00`, `3.06→3.10`, `0.03→0.05`, `0.00→0.05` floor.

**Risk:** Changing entry/SL/TP by up to one tick may marginally change replay results — acceptable; replay should also use the same helper so live↔replay parity is preserved (see Task 2.4).

---

### Task 1.2 — Verify OCO protection exists after entry fill; if missing, attach (C2 + C3)

**Edit:** `src/agent/trade-executor.ts`

After `submitOtocoOrder()` returns (or after the fallback path at 256–259 fills), add a verification step:

1. Poll Tradier for the parent OTOCO order status up to N seconds.
2. Parse all three legs. Record which are `open`, `filled`, `rejected`.
3. If entry is `filled` and (tpLegId is undefined OR any child leg is `rejected`):
   - Log `[executor] OTOCO protection incomplete — attaching standalone OCO`.
   - Call `submitStandaloneOco(position, accountId, execCfg)` (already exists in position-manager.ts).
   - If standalone OCO also fails, emit ALERT severity to audit log and retry per Task 3.2.

**New function:** `waitForOtocoLegs(bracketOrderId, timeoutMs)` in trade-executor.ts — returns `{ entry: LegStatus, tp: LegStatus, sl: LegStatus }`.

**Tests:** `tests/agent/trade-executor.test.ts` — mock Tradier responses for:
- Happy path (all three legs accepted)
- Entry filled, TP rejected → expect standalone OCO call
- Entry filled, both legs rejected → expect standalone OCO call
- Entry rejected → expect no OCO attachment attempt

---

### Task 1.3 — Fail loudly when OTOCO falls back to bare entry (C2)

**Edit:** `src/agent/trade-executor.ts:256–259`

In the catch path, before returning success:
- Log `ALERT: OTOCO submission failed (${err.message}) — position will be unprotected until Task 1.2 verification runs`
- Set a flag on the returned position or write to audit log so the monitor agent can surface it
- Ensure Task 1.2's verification fires even on this path (currently it may not, if the fallback uses a different return type)

---

## Phase 2 — Replay Modeling Corrections (High)

### Task 2.1 — Split TP and SL friction (H1)

**Edit:** `src/core/friction.ts`

Replace single `frictionExit()` with three typed exits:

```ts
/** TP limit sell: no half-spread (you provide liquidity) + commission only. */
export function frictionTpExit(limitPrice: number): number {
  return limitPrice;  // fills at limit; commission applied separately
}

/** SL stop→market sell: full half-spread paid. */
export function frictionSlExit(stopPrice: number): number {
  return Math.max(0.01, stopPrice - HALF_SPREAD);
}

/** Signal/time exit: market sell at current bar close. Full half-spread. */
export function frictionMarketExit(midPrice: number): number {
  return Math.max(0.01, midPrice - HALF_SPREAD);
}

/** @deprecated — use typed variants. Kept for migration only. */
export function frictionExit(midPrice: number): number {
  return frictionMarketExit(midPrice);
}
```

**Edit:** `src/core/friction.ts` `computeRealisticPnl()` — accept an optional `exitKind: 'tp' | 'sl' | 'market'` param that routes to the right friction function. Default `'market'` preserves existing behavior until callers migrate.

**Edit callers** (grep `computeRealisticPnl(`):
- `src/core/trade-manager.ts:128–130` — pass exit kind based on `check.reason`:
  - `take_profit` → `'tp'`
  - `stop_loss` → `'sl'`
  - `signal_reversal` / `time_exit` / `scannerReverse` → `'market'`
- `src/replay/machine.ts` (search all call sites) — pass same kind

**Tests:** `tests/core/friction.test.ts` — verify TP P&L is `$0.05` higher per contract than previous symmetric model; SL unchanged.

**Expected backtest impact:** TP-heavy configs score modestly higher. Autoresearch should re-run on current best configs to detect any ranking changes.

---

### Task 2.2 — Make intrabar tie-breaker configurable (H2)

**Edit:** `src/core/position-manager.ts:59–72`

Add to `Config.position`:
```ts
intrabarTieBreaker?: 'sl_wins' | 'tp_wins' | 'by_open';  // default 'sl_wins'
```

- `sl_wins` (default, current) — conservative, matches today's behavior.
- `tp_wins` — if gap-up or gap-down favors TP at the open.
- `by_open` — if `bar.open` is closer to TP than to SL, TP wins; else SL. Most realistic for replay parity with live.

**Tests:** `tests/core/position-manager.test.ts` — one bar with both breached, assert the right exit fires per mode.

---

### Task 2.3 — Spread-scaled stop slippage (H3)

**Edit:** `src/core/fill-model.ts`

Extend `slipSellPrice()` signature:
```ts
export function slipSellPrice(
  stopPrice: number,
  qty: number,
  cfg: ResolvedSlippage,
  context?: { spread?: number; barRange?: number; minutesToClose?: number }
): number
```

If `context` is provided, compute additional slippage term:
```
extraSlip = (context.spread ?? 0) * 0.5            // half the spread width
          + (context.minutesToClose < 15 ? 0.05 : 0) // EOD wide-spread penalty
```

Keep current linear `slSlipPerContract * qty` term. Cap at `slSlipMax`.

**Config additions** (all optional, preserve defaults):
```ts
fill.slippage.slSpreadFactor?: number;      // default 0.5
fill.slippage.slEodPenalty?: number;        // default 0.05
fill.slippage.slEodWindowMin?: number;      // default 15
```

**Edit callers:** `src/replay/machine.ts` — pass `{ spread, barRange, minutesToClose }` computed from the bar.

**Tests:** verify slippage is unchanged when context is absent (backwards compat), and increases with spread/EOD proximity when provided.

---

### Task 2.4 — Use `roundToOptionTick` in replay too

**Edit:** `src/replay/machine.ts` — wherever `stopLoss` and `takeProfit` are set on a `CorePosition`, call `roundToOptionTick()`.

Rationale: if live rounds, replay must round identically or backtest results diverge from live fills.

---

## Phase 3 — Reconciliation & Cleanup (Medium / Low)

### Task 3.1 — Persist TP/SL with position, prefer persisted over recomputed (M1)

**Edit:** `src/agent/position-manager.ts:127–129` and session persistence.

On position open: record `{ stopLossPrice, takeProfitPrice, configSnapshotId }` to the session file.
On reconcile:
1. Look up the position's entry order in session file.
2. If found with persisted TP/SL, use those.
3. If not found (truly orphaned), fall back to current recompute logic — but log a WARN that the adopted position may not match original intent.

**Migration:** existing session files lack the new fields; reconcile must tolerate missing values.

---

### Task 3.2 — Retry on `submitStandaloneOco` failure (M2)

**Edit:** `src/agent/position-manager.ts:171–173` and surrounding.

Wrap the call in `retry(op, { attempts: 3, backoffMs: [500, 2000, 5000] })`. Use the existing helper in `src/utils/resilience.ts`.

On all-attempts-failed: write an ALERT-severity audit entry with position details and raise a flag the monitor agent can detect.

---

### Task 3.3 — Audit counter for TP re-entry bracket attachment (M3)

**Edit:** `src/agent/trade-executor.ts`

Add counters logged per session:
- `tpReentriesAttempted`
- `tpReentriesProtected` (got a valid bracketOrderId)
- `tpReentriesUnprotected` (fell back to bare buy)

Surface in `/agent/status` endpoint for monitoring. Any non-zero `tpReentriesUnprotected` should alert.

---

### Task 3.4 — Test: OTOCO rejection paths (L2)

**New tests:** `tests/agent/trade-executor-otoco.test.ts`

- Entry fills but TP leg rejected → standalone OCO attached
- Both legs rejected → standalone OCO attached
- Entire OTOCO rejected → fallback path runs AND verification still attaches protection
- Standalone OCO fails 3× → ALERT written, position flagged unprotected

### Task 3.5 — Test: cancel-vs-fill race (L1)

**New test:** mock Tradier cancel succeeds, but one leg shows as `filled` simultaneously. Verify `closePosition()` detects and does not double-sell.

---

## Rollout & Validation

### Per-phase validation

After each phase:
1. `npm run test` — all green
2. `npm run replay -- --dates=2026-03-18,2026-03-19,2026-03-20` — no crashes, trades reconcile
3. Compare composite scores before/after on the 22-day replay library. Document expected direction of change in the PR description.

### Live rollout

1. Ship Phase 1 to `spxer-agent` in paper mode first (`AGENT_PAPER=true`) for one full session. Verify audit log shows zero unprotected positions.
2. Ship Phase 2 after at least two green paper sessions.
3. Phase 3 can ship continuously — it's defense-in-depth without behavior changes.

### Rollback criteria

Any of:
- `tpReentriesUnprotected` > 0 in a session
- Replay composite score drops > 5 points on existing best configs without explanation
- New test coverage uncovers additional critical bugs

---

## Review Clarifications (added after self-review)

### Task 1.2 must be non-blocking
Verification polls Tradier for OTOCO leg status with a **3-second timeout**. It runs in a fire-and-forget promise after `openPosition()` returns — the agent's main loop must not stall waiting for verification. If verification detects missing protection, remediation (standalone OCO) happens on the next loop iteration, not inline.

### Task 1.1 prerequisite: validate Tradier tick rules
Before landing tick rounding, confirm the exact SPXW tick schedule by either (a) checking Tradier API documentation, or (b) submitting a paper order with `price=3.03` and observing rejection/acceptance. Record findings in the PR description. Wrong rules = same rejection problem we're trying to fix.

### Task 2.1 deprecated-alias removal target
`frictionExit()` is retained as an alias for `frictionMarketExit()` for one release cycle. Remove after:
- Two weeks of clean replay+live runs
- Zero call sites remaining (grep `frictionExit(` returns nothing outside friction.ts itself)

Explicit caller migration checklist (to be filled during implementation):
- `src/core/trade-manager.ts:128–130` — pass exitKind from `check.reason`
- `src/replay/machine.ts` — TODO: enumerate each call site during implementation

### Task 2.3 data prerequisite: bar-level spread in replay
Spread-scaled SL slippage needs per-bar spread. Current `Bar` type does not carry spread. Prerequisite subtask:
- **Task 2.3a**: Extend `Bar` with optional `spread?: number`. Bar builder should populate from Tradier quote data when available. Replay cache should preserve it. Fallback when unavailable: use bar range or a constant.
- Only then can Task 2.3's context plumb real data. Without this, Task 2.3 degrades to current behavior.

### Task 3.1 session-file migration strategy
- **Read path**: treat `stopLossPrice`, `takeProfitPrice`, `configSnapshotId` as optional. Missing fields → fall back to current recompute logic with a WARN log.
- **Write path**: always write the new schema on next position open.
- **No backfill**: existing sessions age out naturally at EOD. Agents restart clean each morning.

### Rollback criteria (expanded)
Additional triggers for rollback of a phase:
- Live paper session fails smoke test (any unprotected position detected post-entry)
- Tradier rejects > 1% of live orders in a paper session (suggests tick rules wrong)
- Autoresearch can't reproduce prior-best composite scores within ±3 points after Phase 2

---

## Out of Scope (this plan)

- Spread trading (see `docs/SPREAD-PLAN.md`)
- EOD safety-net warn-log (separate 1-line fix)
- `evaluateEntry` docstring cleanup (docs-only)
- Generic OTOCO support for non-SPX symbols (SPX-only by design per CLAUDE.md)

---

## Effort Estimate

| Phase | Tasks | Rough LOC | Risk |
|-------|-------|-----------|------|
| 1 — Live Safety | 1.1, 1.2, 1.3 | ~200 LOC + tests | Medium (live code path) |
| 2 — Replay Correctness | 2.1, 2.2, 2.3, 2.4 | ~300 LOC + tests | Low (isolated, replay-only) |
| 3 — Reconciliation | 3.1–3.5 | ~250 LOC + tests | Low |

**Total:** ~750 LOC across ~15 files. One to two sessions of focused work, gated by replay parity validation.
