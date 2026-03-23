# Narrative Sharing Issue - Investigation Needed

**Created**: 2025-03-23
**Status**: PENDING INVESTIGATION
**Priority**: HIGH - Core design intent not working

## Problem Description

The MarketNarrative system exists and is being populated with overnight data, session events, and scanner notes, but scanner outputs show NO evidence of receiving or using this narrative context. Each scanner cycle appears to be a fresh read with no memory of previous analysis.

## Evidence of the Problem

### 1. Scanner Outputs Show No Narrative Awareness

Scanners never reference:
- Previous reads they made 15-60 minutes ago
- Overnight data or pre-market context
- Session trajectory (SPX/RSI highs/lows with timestamps)
- Their own previous notes or evolving interpretation

**Example pattern**:
- Scanner flags "EXTREME_OVERSOLD_PUT_MEAN_REVERSION" at 10:15
- Scanner flags SAME signal again at 10:45
- Scanner flags SAME signal again at 11:20
- No acknowledgment: "As I noted earlier, this appears to be theta decay, not actual oversold"

### 2. Narrative System Exists and Should Work

**File**: `src/agent/market-narrative.ts`

```typescript
export class MarketNarrative {
  overnightNarrative?: string;  // Populated by pre-session-agent
  preMarket?: PreMarketData;     // Populated by pre-session-agent
  sessionEvents: SessionEvent[]; // Populated every cycle in agent.ts
  scannerNotes: string[];        // Should accumulate scanner thoughts

  buildTLDR(): string {
    // Returns formatted narrative:
    // OVERNIGHT: ...
    // PRE-MKT: ...
    // RECENT EVENTS: ...
    // MY NOTES: ...
  }
}
```

### 3. Narratives Are Being Populated

**File**: `agent.ts` (main loop)

```typescript
// Narratives created for each scanner
const narratives = new Map<string, MarketNarrative>([
  ['kimi',    new MarketNarrative('kimi',    'Kimi K2.5')],
  ['glm',     new MarketNarrative('glm',     'ZAI GLM-5')],
  ['minimax', new MarketNarrative('minimax', 'MiniMax M2.7')],
  ['haiku',   new MarketNarrative('haiku',   'Claude Haiku')],
]);

// Session events logged every cycle
for (const narrative of narratives.values()) {
  narrative.appendEvent(
    Math.floor(Date.now() / 1000),
    snap.timeET,
    snap.spx.price,
    spxRsi,
    regimeState.regime,
    cycleSummary,
  );
}
```

### 4. buildPrompt() Adds Narrative Context

**File**: `src/agent/judgment-engine.ts`

```typescript
function buildPrompt(scannerId: string): string {
  const narrative = narratives.get(scannerId);
  const narrativeContext = narrative ? '\n\nYOUR NARRATIVE SO FAR:\n' + narrative.buildTLDR() : '';
  return basePrompt + narrativeContext;
}
```

## What Should Be Happening

Scanner outputs should look like:

```
OVERNIGHT: ES closed at 5975, range 5960-5990, tight overnight range.
PRE-MKT: Implied open 5982, auction 5978-5985.
RECENT EVENTS:
  - 09:35 SPX 5980 RSI 52 regime MORNING_MOMENTUM
  - 09:50 SPX 5995 RSI 68 regime TRENDING_UP
  - 10:05 SPX 5992 RSI 65 regime TRENDING_UP
MY NOTES:
  - 09:35: Watching for momentum breakout above 6000
  - 09:50: Breakout confirmed, staying cautious on puts

CURRENT READ: SPX at 5992 (session high), RSI 65, trending up.
As I noted at 09:50, we're in momentum mode - put signals are likely theta decay.
Setup: NONE - wait for RSI exhaustion or session high break.
```

## What's Actually Happening

Scanner outputs look like:

```
CURRENT READ: SPX at 5992, RSI 65.
Puts showing extreme oversold: C6000 at $0.35 (RSI 9).
Setup: EXTREME_OVERSOLD_PUT_MEAN_REVERSION on C6000.
```

**No mention of**:
- Previous notes
- Session trajectory
- The fact that SPX is at session highs
- Why a put with RSI 9 is oversold when SPX is rallying (theta decay, not mean reversion)

## Investigation Checklist

- [ ] Verify narrative is actually being included in the prompt sent to scanners
  - Check: Is `YOUR NARRATIVE SO FAR` section present in the actual API call?
  - Check: Is `narrative.buildTLDR()` returning empty string or valid content?

- [ ] Verify narrative content is complete
  - Check: Is `overnightNarrative` populated?
  - Check: Is `preMarket` data populated?
  - Check: Are `sessionEvents` being appended?
  - Check: Are `scannerNotes` being saved?

- [ ] Verify scanner prompts are receiving the narrative
  - Add debug logging to print the full prompt being sent to each scanner
  - Compare prompt content with scanner output to see if they're ignoring it

- [ ] Check if scanner notes are being saved
  - `scannerNotes` array should accumulate over time
  - Are scanners' thoughts being appended after each cycle?

- [ ] Check narrative persistence between cycles
  - Are narratives being recreated fresh each cycle (losing state)?
  - Are narratives properly stored in the Map and reused?

## Related Issues

- **Limited timeframe context**: Scanners only receive 1m/3m/5m bars (24 minutes max), no 15m/1h for session structure
- **Contract-first analysis**: Scanners look at individual contracts in isolation instead of SPX-first approach
- **MiniMax parse errors**: MiniMax consistently returns "Parse error" (may be related to narrative formatting)

## Expected Impact If Fixed

- Scanners should build on previous analysis instead of starting fresh each cycle
- Reduced false signals (they'll remember why they rejected similar setups before)
- More coherent decision-making (trajectory tracking, regime evolution awareness)
- Better escalation quality to judge (richer context)

## Files to Investigate

1. `src/agent/judgment-engine.ts` - `buildPrompt()` function
2. `src/agent/market-narrative.ts` - `buildTLDR()` method
3. `agent.ts` - Narrative initialization and event logging
4. `src/agent/pre-session-agent.ts` - Overnight/pre-market population
5. `src/agent/model-clients.ts` - How prompts are sent to each model

## Next Steps

1. Add debug logging to print the full prompt being sent to each scanner
2. Verify `narrative.buildTLDR()` returns non-empty content
3. Check if scanner notes are being saved to the narrative
4. Test with a simple prompt: "Repeat your narrative context back to me" to verify it's received
