# Session 9: Prompt Framing

## Goal
Find the optimal prompt lens for scanner agents. How you frame the scanner's role and what you tell it to prioritize changes what it sees.

## Scope
`src/replay/prompt-library.ts` — create new prompt variants. `src/replay/config.ts` — switch `scanners.promptId` to test each variant.

## Metric
Win rate (higher is better). Output from verify command. NOTE: This session requires scanner API calls (costs money, slower).

## Direction
Higher is better.

## Verify
```bash
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19,2026-03-20
```
(Smaller date set because scanner calls are expensive)

## Guard
```bash
npx vitest run --reporter=silent 2>&1 | tail -1 | grep -q "passed"
```

## Iterations
8

## What to Test (one prompt variant per iteration)

### Regime-aware variants
1. **Regime-guided**: "Today's regime is [X]. Look for [continuation/reversal] setups accordingly."
2. **Regime-blind**: "Analyze this data with no macro context. Each moment stands alone."

### Priority lens variants
3. **Trend-first**: "Prioritize HMA/EMA alignment and trend confirmation. RSI is secondary."
4. **Reversal-first**: "Prioritize pivot points, RSI extremes, V-reversals. Look for overextension."
5. **Price-action-first**: "Focus on session high/low breaks, candle range expansion, and key levels."

### Context depth variants
6. **Narrative-rich**: Full overnight build + session trajectory + "here's how we got here today"
7. **Snapshot-only**: Just current bar + indicators, no history
8. **Risk-framed**: "Max risk $X. If unclear, wait. Only flag high-conviction setups."

## Prerequisites
- Scanners must be enabled (`scanners.enabled: true`)
- API keys for scanner models must be set
- New prompt variants need to be added to `src/replay/prompt-library.ts`

## Hypothesis
Scanners given all indicator data but told to prioritize trend indicators (HMA/EMA) over RSI will produce better signals. Narrative-rich context helps the scanner understand "how we got here" vs isolated snapshots. The neutral baseline prompt may actually be the best — don't bias the model, let it find patterns.

## Hold Constant
All other config values remain at DEFAULT_CONFIG defaults. Use best deterministic config from Sessions 1-8.
