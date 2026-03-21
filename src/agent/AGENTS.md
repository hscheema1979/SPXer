<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-20 | Updated: 2026-03-20 -->

# agent — Autonomous Trading Agent

## Purpose

Multi-tier autonomous trading agent that reads market conditions, makes trade decisions, and executes via Tradier API:

**Tier 1 (Scanners)**: Run every 15-60s, assess market setups, flag potential opportunities
- Kimi K2.5 (cautious, wants confirmation)
- GLM-5 (fundamentals-focused)
- MiniMax M2.7 (aggressive, decisive)

**Tier 2 (Judges)**: Run on escalation, weigh full context, make final trade decision
- Claude Haiku (fast tiebreaker)
- Claude Sonnet (structured, decisive)
- Claude Opus (deep reasoning)

**Code Path (No LLM)**: Strike selection and execution are deterministic (< 100ms)

Entry point: `agent.ts` at repository root.

## Key Files

| File | Description |
|------|-------------|
| `market-feed.ts` | Snapshot current market state (SPX price, RSI, active contracts, options chain) |
| `regime-classifier.ts` | Tag current market regime (MORNING_MOMENTUM, MEAN_REVERSION, TRENDING_UP/DOWN, GAMMA_EXPIRY, NO_TRADE) |
| `market-narrative.ts` | Build rolling narrative throughout the day (overnight context, session trajectory, notable events) |
| `pre-session-agent.ts` | Overnight + pre-market analysis (runs at 9:20 ET) |
| `signal-detector.ts` | Deterministic signal detection (RSI extremes, EMA/HMA crosses, volume spikes) |
| `price-action.ts` | Price action patterns (session high/low breaks, range expansion, V-reversals) |
| `judgment-engine.ts` | Two-tier: 3 LLM scanners → optional judge escalation |
| `model-clients.ts` | Claude Agent SDK with env overrides for routing third-party models |
| `strike-selector.ts` | Deterministic OTM strike selection ($0.50-$3.00 range, 15-30pts OTM on extremes) |
| `trade-executor.ts` | Tradier order execution (paper or live based on `AGENT_PAPER` env var) |
| `position-manager.ts` | Monitor open positions, track P&L, manage exits |
| `risk-guard.ts` | Daily loss limits, position limits, time cutoffs |
| `audit-log.ts` | JSON audit trail of every decision (for replay analysis) |
| `reporter.ts` | Status file + activity log for monitoring |
| `replay-framework.ts` | Backtesting harness for replay scripts |
| `types.ts` | Agent-specific types (TradeDecision, MarketSnapshot, SignalGate, etc.) |

## Agent Loop Architecture

```
Main Loop (every 15-60 seconds):
├─ market-feed.ts — Snapshot current market state
├─ regime-classifier.ts — Tag regime (time-of-day + trend)
├─ signal-detector.ts — Check for RSI/EMA/price-action triggers
│  └─ If signal detected:
│     ├─ position-manager.ts — Check if already in a position (prevent dupes)
│     ├─ risk-guard.ts — Check daily loss limit, position count limit
│     └─ judgment-engine.ts — Run 3 scanners in parallel
│        ├─ Each scanner gets (regime, narrative, market state, chain)
│        ├─ If scanner flags confidence >= threshold
│        └─ Optional: escalate to judge (Sonnet/Haiku/Opus)
│
├─ strike-selector.ts — Pick deterministic OTM strike
├─ trade-executor.ts — Place order
├─ audit-log.ts — Record decision
├─ reporter.ts — Update status
└─ market-narrative.ts — Log event for trajectory tracking
```

## Two-Tier Assessment Philosophy

### Tier 1: Scanners (Cheap, Fast, Reactive)

Run every 15-60 seconds. Three parallel models:

| Model | Provider | Speed | Personality |
|-------|----------|-------|-------------|
| **Kimi K2.5** | Moonshot | ~2.6s | Cautious, wants confirmation before committing |
| **GLM-5** | Zhipu AI | ~3-5s | Fundamentals-focused, considers macro context |
| **MiniMax M2.7** | MiniMax | ~40-47s | Aggressive, decisive, picks specific strikes |

**What they get**: Current bar, RSI, regime tag, options chain, market narrative
**What they do**: Assess conditions, flag setups (don't trade)
**Confidence threshold**: 0.5 (default) — if any scanner >= 0.5, escalate to judge

### Tier 2: Judges (Expensive, Slow, Deliberate)

Run only on escalation. Three Claude models (via Agent SDK):

| Model | Speed | Personality |
|-------|-------|-------------|
| **Claude Haiku** | Fast | Quick tiebreaker, momentum reader |
| **Claude Sonnet** | Medium | Structured, decisive, good at formatted output |
| **Claude Opus** | Slow | Deep reasoning, considers edge cases |

**What they get**: Full scanner escalation + market context + audit trail
**What they do**: Weigh full context, approve or deny trade
**Decision**: Binary (BUY or PASS); if BUY, code handles execution

## Key Concepts

### Market Narrative

Per-scanner rolling narrative built throughout the day:

- **Overnight**: Pre-session agent reads ES bars, builds overnight context (range, character, gap, key levels)
- **Pre-market**: Implied open, auction range, regime expectation
- **Intraday**: Each cycle appends events (bar time, SPX price, RSI, regime, notable moves)
- **Trajectory tracking**: Session high/low, RSI high/low with timestamps
- **Escalation brief**: When escalating, narrative built into judge's context (e.g., "RSI traveled from 18→85 in 47 minutes")

Purpose: Judge doesn't receive isolated signals — it receives context. "RSI is 85" means nothing without "...because of the 37-point rally since 10 AM."

### Regime Gates

Regime classifier tags current market regime, which defines signal gate (what's allowed):

| Regime | Time | Confidence | Signals Allowed |
|--------|------|-----------|-----------------|
| **MORNING_MOMENTUM** | 09:30-10:15 | High | Breakout follow (not fade) |
| **MEAN_REVERSION** | 10:15-14:00 | High | RSI fade (overbought/oversold) |
| **TRENDING_UP** | Any time | High | Break follow (oversold fade blocked) |
| **TRENDING_DOWN** | Any time | High | Break follow (overbought fade blocked) |
| **GAMMA_EXPIRY** | 14:00-15:30 | Medium | All signals (high gamma risk) |
| **NO_TRADE** | 15:30-16:00 | N/A | No signals (too close to expiry) |

Regime gates filter signals BEFORE scanners run — first line of defense.

### Signal Detection (Deterministic)

Checked every bar:

1. **RSI Extremes**: RSI < 25 (oversold, consider calls) or RSI > 80 (overbought, consider puts)
   - EMERGENCY: RSI < 15 or > 85 (escalate immediately)
   - EXTREME: RSI < 20 or > 80 (escalate immediately)
2. **EMA/HMA Crosses**: 5-period crosses 20-period (momentum reversal)
3. **Price Action**: Session high/low breaks, range expansion, V-reversals
4. **Volume Spikes**: Volume > 2× average (confirmation of momentum)

## Strike Selection Rules

**Deterministic, no LLM**:

- **Only OTM**: Calls only below SPX, puts only above SPX
- **Price range**: $0.50-$3.00 (sweet spot for gamma exposure)
- **Distance OTM**:
  - Emergency (RSI <15 or >85): 20-30 points OTM
  - Extreme (RSI <20 or >80): 15-25 points OTM
  - Normal: 10-15 points OTM
- **Risk control**: Position size (1-2 contracts), not strike proximity
- **Greedy pick**: First contract in target range (don't overthink)

Per trader mandate: "We're ONLY trading out-of-the-money. Otherwise we'd be collecting dividends."

## For AI Agents

### Working In This Directory

1. **Don't modify judgment-engine** — Two-tier assessment is core architecture. Consult before changes.
2. **Narrative is immutable history** — MarketNarrative appends events, never rewrites. Immutability enables audit trail.
3. **Strike selection is deterministic** — No LLM choice of strike. Code picks deterministically.
4. **Risk guard is final arbiter** — Even if judge says BUY, risk-guard can block (daily loss limit, max positions).
5. **Audit log everything** — JSON trail of every decision, used for replay analysis.
6. **Testing**: Run replay scripts on historical data, validate P&L vs expected outcomes.

### Testing Requirements

- Unit tests for signal detection (RSI thresholds, crossover detection)
- Regime classification edge cases (time boundaries, gap detection)
- Backtests on 5+ trading days, validate P&L and win rate
- Replay framework runs full day with AI calls (slow but most realistic)

### Common Patterns

- **Narrative append**: `narrative.append({ ts, spx, rsi, regime, note })`
- **Immutable state**: Use spreads and new objects, never mutate
- **Escalation context**: Include narrative + regime + market state in judge prompt
- **Error handling**: All API calls wrapped in try-catch; log and continue

## Key Architecture Decisions

### Why Two-Tier?

**Simple signals are too reactive**: RSI > 80 can last 30 minutes in a strong rally. Reacting instantly is whipsaw-prone.

**Complex indicators are fragile**: Overfitting to historical patterns breaks on regime changes.

**Two-tier is Goldilocks**: Scanners observe and flag, judges weigh context. Agentic, not reactive. Mirrors human decision-making.

### Why Deterministic Strike Selection?

**LLMs can hallucinate strikes**: "Buy $5100 call" when max strike is $5000 (real bug found).

**Speed matters in 0DTE**: 1-second delay costs 2-3% in option value.

**Code is auditable**: Deterministic selection is reproducible and verifiable; LLM choices are opaque.

### Why Narrative Over Signals?

**Trajectory matters**: A stock at RSI 85 after rallying 30 points is different from RSI 85 after grinding higher for 3 hours.

**Context prevents false signals**: Overnight gap down changes meaning of RSI values.

**Audit trail**: Full narrative enables replay analysis ("why did we trade here?").

## Dependencies

### Internal
- `src/market-feed.ts` — Market state snapshot
- `src/regime-classifier.ts` — Market regime tagging
- `src/storage/queries.ts` — Database queries for historical bars
- `src/types.ts` — Bar, Contract types

### External
- **AI**: Anthropic Claude SDK, third-party LLM APIs (Kimi, GLM, MiniMax)
- **Trading**: Tradier API for order execution
- **Server**: Data service on port 3600 for market snapshots

## Known Issues (Fixed March 19-20)

1. ✅ **Call/Put parsing bug** — `isCall = sym.includes('C0')` didn't match `C6xxx`. Fixed.
2. ✅ **TP below entry** — Judge returned underlying price as option TP. Sanity check added.
3. ✅ **DST bug** — Hardcoded UTC-5 instead of Intl timezone. Fixed.
4. ✅ **Promise.allSettled contention** — Claude `query()` serializes. Changed to sequential for judges.
5. ✅ **Indicator pipeline resets** — Fixed by ensuring state continuity across data gaps.

<!-- MANUAL: Add agent-specific notes on model behavior, escalation thresholds, or trader preferences below -->
