# SPXer Replay Configuration Questionnaire

This document guides you through building a replay config step-by-step. Answer each section, and the agent will compile your answers into a `ReplayConfig` object.

---

## 1. Basic Setup

### Trading Date
- **Question:** Which trading day do you want to replay?
- **Format:** YYYY-MM-DD (e.g., 2026-03-20)
- **Available:** 2026-02-18 through 2026-03-19 (22 trading days backfilled)
- **Your Answer:** _______________

### Strategy Preset (Optional)
- **Question:** Do you want to start with a preset strategy, or build a custom config?
- **Options:**
  - `aggressive` — high confidence thresholds, 2-3 open positions, 5x TP, 50% stop
  - `conservative` — only extreme setups, 1 position max, 3x TP, 30% stop, tight gates
  - `balanced` — moderate thresholds, 2 positions, 4x TP, 50% stop
  - `custom` — build from scratch (use DEFAULT_CONFIG as base)
- **Your Answer:** _______________

---

## 2. Scanner Configuration

### Scanner Engines
- **Question:** Which AI scanner models should participate in setup detection?
- **Options:**
  - `disabled` — Use deterministic signals only (no LLM calls)
  - `haiku` — Haiku scanner only (fast, ~2.5s per call, good tiebreaker)
  - `allParallel` — All 4 scanners in parallel: Haiku + Kimi + GLM + MiniMax (expensive, ~30-50s per cycle)
  - `custom` — Pick specific subset (comma-separated: haiku, kimi, glm, minimax)
- **Your Answer:** _______________

### Scanner Prompt Version
- **Question:** Which scanner prompt should scanners use?
- **Options:**
  - `baseline-2026-03-18-v1.0` — Original prompt (Greeks + SPY flow, RSI 25/75)
  - `rsi-extremes-2026-03-19-v2.0` — Added RSI extremes section (20/80 + emergency at 15)
- **How to choose:**
  - Use `baseline` if you want consistent moderate signals
  - Use `rsi-extremes` if you want scanner to aggressively flag RSI breaks at 20/80
- **Your Answer:** _______________

### Minimum Confidence to Escalate
- **Question:** What's the minimum scanner confidence (0.0-1.0) to escalate a setup to the judge?
- **Typical:** 0.5 (50% confidence)
- **Your Answer:** _______________

---

## 3. Judge Configuration

**Note:** Judges are advisory—they don't execute trades, just evaluate setups. You can run multiple judges in parallel and log all decisions.

### Which Judges to Consult?
- **Question:** Which judge models should evaluate each setup?
- **Options:**
  - `sonnet` only — Single balanced judge (default, simplest)
  - `haiku + sonnet + opus` — All three judges in parallel (compare all perspectives)
  - `haiku + sonnet` — Fast + balanced
  - `sonnet + opus` — Balanced + deep reasoning
  - `custom` — Pick your own combination
- **Your Answer:** _______________

### Judge Decision Rule
- **Question:** How should multiple judges' decisions be combined?
- **Options:**
  - `primary-decides` — Primary judge makes the call, others logged for comparison
  - `majority` — Need 2+ judges to agree before trading
  - `unanimous` — All judges must agree
  - `first-agree` — Execute on first judge approval, log the rest
- **Your Answer:** _______________

### Primary Judge (if using "primary-decides")
- **Question:** Which judge should make the final decision?
- **Typical:** `sonnet` (balanced, reliable)
- **Your Answer:** _______________

---

## 4. Escalation Logic

This defines which events trigger a trade evaluation (signal → judge, scanner → judge, or both).

### Signal-Based Escalation
- **Question:** Should deterministic signals (RSI crosses, HMA crosses) escalate to the judge?
- **Yes/No:** _______________

### Scanner-Based Escalation
- **Question:** Should scanner setups escalate to the judge?
- **Yes/No:** _______________

### Agreement Requirements

**If both signals AND scanners are enabled:**

- **Question:** If a signal fires, should it require scanner confirmation before escalating?
  - **Yes/No:** _______________

- **Question:** If a scanner flags a setup, should it require a signal confirmation before escalating?
  - **Yes/No:** _______________

### Minimum Scanner Consensus
- **Question:** If multiple scanners run, what's the minimum number that must agree to escalate?
- **Options:** 1, 2, 3, or 4 (or `undefined` for "any scanner can escalate")
- **Your Answer:** _______________

**Escalation Summary:**
- Signals escalate: _______________
- Scanners escalate: _______________
- Signals need scanner agreement: _______________
- Scanners need signal agreement: _______________
- Minimum scanners to escalate: _______________

---

## 5. Signal Thresholds

These are the deterministic triggers for trade evaluation.

### RSI Oversold Threshold
- **Question:** Below what RSI value is the market oversold (call entry signal)?
- **Typical:** 20-25
- **Your Answer:** _______________

### RSI Overbought Threshold
- **Question:** Above what RSI value is the market overbought (put entry signal)?
- **Typical:** 75-80
- **Your Answer:** _______________

### HMA Fast Crossing HMA Slow
- **Question:** Should HMA 3m crossing HMA 5m generate a signal?
- **Yes/No:** _______________

### Volume Spike Multiplier
- **Question:** At what multiple of average volume is a spike significant?
- **Typical:** 2.0x (2x normal volume)
- **Your Answer:** _______________

---

## 6. Position Sizing & Risk Management

### Maximum Open Positions
- **Question:** How many simultaneous positions can the system hold?
- **Typical:** 1-3
- **Your Answer:** _______________

### Max Risk Per Trade
- **Question:** Maximum USD loss per single trade (stop loss)?
- **Typical:** $100-$300
- **Your Answer:** _______________

### Stop Loss Percent
- **Question:** At what % loss should a position exit?
- **Typical:** 30-70% (e.g., 50% = exit if contract value drops 50% from entry)
- **Your Answer:** _______________

### Take Profit Multiplier
- **Question:** Profit target as a multiple of risk?
- **E.g.:** 5x risk = risk $100, target $500 profit
- **Typical:** 3x-5x
- **Your Answer:** _______________

---

## 7. Regime & Time Gating

### Allow Trades During Morning Momentum (9:30-10:30 ET)
- **Question:** Morning can be chaotic. Allow trades then?
- **Yes/No:** _______________

### Allow Trades During Midday Consolidation (11:00-13:00 ET)
- **Question:** Cleanest trading window. Allow trades?
- **Yes/No:** _______________

### Allow Trades During Afternoon (13:00-15:00 ET)
- **Question:** Still good, but speed picks up. Allow trades?
- **Yes/No:** _______________

### Allow Trades During Close (15:00-16:15 ET)
- **Question:** Fast but risky. Allow trades?
- **Yes/No:** _______________

### Allow Trades During Trending Regimes
- **Question:** Allow entries during detected uptrends/downtrends?
- **Yes/No:** _______________

### Allow Trades During Ranging Markets
- **Question:** Allow mean-reversion trades in choppy ranges?
- **Yes/No:** _______________

---

## 8. Exit Strategy

### How Should Positions Exit?
- **Question:** When should open positions be closed or reversed?
- **Options:**
  - `takeProfit` — Standard: exit when take-profit hit OR stop loss hit (first run)
  - `scannerReverse` — If scanners flip sentiment, reverse position instead of just exiting (second run)
- **Example:**
  - Mode 1 (takeProfit): Long call entered, RSI recovers → exit at TP, done
  - Mode 2 (scannerReverse): Long call entered, scanner flips to bearish → exit call, enter put, continue trading
- **Your Answer:** _______________

### Reversal Size Multiplier (for scannerReverse mode)
- **Question:** When reversing, reload with what % of original size?
- **Typical:** 1.0 (same size) or 0.8 (reduce size on reversal)
- **Your Answer:** _______________

---

## 9. Strike Selection & Options Contract Rules

(Previously section 8)

### Target Strike Range (OTM)
- **Question:** What's the maximum OTM delta for entries?
- **Options:** delta 0.10-0.30 (lower = further OTM, more leverage)
- **Your Answer:** _______________

### Maximum Contracts Per Expiry
- **Question:** Max number of different contracts to track?
- **Typical:** 50-100
- **Your Answer:** _______________

### Only Trade 0DTE
- **Question:** Limit to 0DTE expirations only?
- **Yes/No:** _______________

---

## 10. Narrative & Learning

### Build Narrative State
- **Question:** Should scanners build a session narrative (gap detection, trajectory tracking)?
- **Yes/No:** _______________
- **Note:** Required for scanners to have context (e.g., "RSI traveled from 18→85 in 47 min")

### Track Session Gap
- **Question:** Detect and log gap from prior close on first bar?
- **Yes/No:** _______________

### Track Trajectory
- **Question:** Log RSI/SPX highs/lows with timestamps as day unfolds?
- **Yes/No:** _______________

### Escalation Detail Level
- **Question:** How much context in escalation brief to judge?
- **Options:**
  - `brief` — Setup type, confidence, notes only
  - `detailed` — Full trajectory, overnight context, session events
- **Your Answer:** _______________

---

## Summary Table

Fill this in to verify your choices:

| Setting | Value |
|---------|-------|
| Date(s) | __________ |
| Strategy | __________ |
| Scanners | __________ |
| Scanner Prompt | __________ |
| Judge Models | __________ |
| Judge Consensus Rule | __________ |
| Primary Judge | __________ |
| Signal Escalation | __________ |
| Scanner Escalation | __________ |
| RSI Oversold | __________ |
| RSI Overbought | __________ |
| Max Positions | __________ |
| Max Risk per Trade | __________ |
| Stop Loss % | __________ |
| Take Profit x | __________ |
| Exit Strategy | __________ |
| Reversal Size Multiplier | __________ |
| Morning Trading (after 9:45) | __________ |
| Midday Trading | __________ |
| Narrative Enabled | __________ |

---

## Next Steps

1. **Complete this questionnaire** — Answer all sections
2. **Agent compiles config** — Agent converts answers to `ReplayConfig` object
3. **Run replay** — `npx tsx scripts/backtest/run-replay.ts --config-id=<your-id>`
4. **Analyze results** — Review trades, P&L, signal quality
5. **Iterate** — Refine thresholds, try different scanners, test prompt versions

---

## Questions?

- **Config structure:** See `src/replay/types.ts` for `ReplayConfig` interface
- **Default values:** See `src/replay/config.ts` for `DEFAULT_CONFIG`
- **Prompts:** See `src/replay/prompt-library.ts` for scanner prompt details
- **Presets:** See `src/replay/config.ts` for `STRATEGY_PRESETS` (aggressive, conservative, balanced)
