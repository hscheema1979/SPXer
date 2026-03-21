# Implementation Plan: Per-Scanner MarketNarrative
## Status: IMPLEMENTED

## Problem

Each LLM scanner is stateless — each scan is isolated with no memory of what happened earlier in the session. When a scanner escalates to the judge, it can only say "I see a setup right now" rather than "I've been watching this all morning and here's how we got here." The judge has no context for why it should trust the escalation.

The `MarketNarrative` class exists in `src/agent/market-narrative.ts` but is never instantiated or used anywhere in the agent loop.

## Design

Each of the 3 scanners (Kimi, GLM, MiniMax) has its own `MarketNarrative` instance. They all receive the same underlying market data, but:
- They each form their own interpretation of the overnight story
- They each track their own trajectory (session SPX high/low, RSI high/low)
- They each write their own scanner notes
- They each build their own escalation brief when escalating to the judge

## Regime Intraday

The regime changes throughout the day based on time-of-day AND 20-bar trend slope:
- 09:30-10:15 → MORNING_MOMENTUM (or TRENDING if slope exceeds threshold)
- 10:15-14:00 → MEAN_REVERSION or TRENDING_UP/DOWN
- 14:00-15:30 → GAMMA_EXPIRY or TRENDING_UP/DOWN
- 15:30+ → NO_TRADE

- `initSession(priorClose)` — one-time morning setup, sets gap calculation baseline. Only called once per day.
- `classify(bar)` — called every bar, computes regime from time-of-day + trend slope. Already wired in `judgment-engine.ts`.
- `getSignalGate(regime, rsi)` — called per-escalation to get signal gate rules.

## Files to Modify

### 1. `src/agent/judgment-engine.ts`

**`scan()` signature changes:**
```typescript
// Before
export async function scan(snap, positions, guard): Promise<ScannerResult[]>

// After
export async function scan(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
  narratives: Map<string, MarketNarrative>
): Promise<ScannerResult[]>
```

For each scanner's prompt: append that scanner's `narrative.buildTLDR()` to the user prompt.

After `runScanner()` returns, update that narrative:
```typescript
narratives.get(id).addScannerNote(result.marketRead);
narratives.get(id).appendEvent(ts, timeET, spx, rsi, regime, eventSummary);
```

**`assess()` signature changes:**
```typescript
// Before
export async function assess(snap, positions, guard): Promise<{scannerResults, assessment, allJudges?}>

// After
export async function assess(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
  narratives: Map<string, MarketNarrative>
): Promise<{scannerResults, assessment, allJudges?}>
```

**Escalation to judge:** Use `narratives.get(escalatingScannerId).buildEscalationBrief()` instead of raw market prompt.

### 2. `agent.ts`

**Add narrative instances (module-level):**
```typescript
const narratives = new Map<string, MarketNarrative>([
  ['kimi',    new MarketNarrative('kimi',    'Kimi K2.5')],
  ['glm',     new MarketNarrative('glm',     'ZAI GLM-5')],
  ['minimax', new MarketNarrative('minimax', 'MiniMax M2.7')],
]);
```

**Morning sequence changes:**
- After `runPreSessionAgent()` returns:
  - For each narrative: `setOvernight(preSession.overnight)`, `setPreMarket(preSession.preMarket)`
  - `startSession(snap.spx.price, Date.now() / 1000)` on each
  - `initSession(priorDayClose)` — prior close from yesterday's daily bar
- After judge overnight validation:
  - For each narrative: `setJudgeValidation(validation)`
- After market open, first `processBar()` call:
  - For each narrative: `appendEvent(firstBar.ts, timeET, spx, rsi, regime, 'session open')`

**`runCycle()` changes:**
- Pass `narratives` to `assess(snap, positions.getAll(), guard, narratives)`
- After `assess()` returns, append event to all narratives with current state:
  - `appendEvent(ts, timeET, spx, rsi, regime, summary)` where summary = top scanner read or "watching"

### 3. `src/agent/regime-classifier.ts`

**`initSession(priorDayClose)` call in morning sequence:**
- Currently not called from `agent.ts` — wire once per day in morning sequence with prior day's SPX close
- `classify(bar)` already called per-bar in `judgment-engine.ts`

## Implementation Order

1. Add `initSession()` call to `agent.ts` morning sequence (prior day close from DB)
2. Add narrative instances and morning initialization to `agent.ts`
3. Update `judgment-engine.ts` `scan()` to accept and use narratives
4. Update `judgment-engine.ts` `assess()` to pass narratives to `scan()` and build escalation briefs
5. Update `agent.ts` `runCycle()` to pass narratives to `assess()` and log narrative events
6. Update `runCycle()` to append event after each cycle with current SPX/RSI/regime

## Backward Compatibility

- `assess()` gets new required `narratives` parameter — caller (`agent.ts`) must pass it
- `scan()` gets new required `narratives` parameter — caller must pass it
- No changes to `MarketNarrative` class itself — already fully implemented

## Testing

- Run `npm run agent` in paper mode — verify no crashes for 5+ cycles
- Check logs: each scanner's narrative should show distinct `buildTLDR()` output in escalation
- Check that narrative events accumulate across cycles (not reset each cycle)
- Verify morning sequence initializes all 3 narratives with overnight data
