# Session 10: Calendar/Macro Context

## Goal
Test whether feeding economic calendar and earnings data to scanners improves their signal quality.

## Scope
Create `src/data/economic-calendar.json` with event data for backtest dates. Modify scanner prompt to inject calendar context. `src/replay/config.ts` — add `prompts.includeCalendar` flag.

## Metric
Win rate (higher is better). Output from verify command. NOTE: This session requires scanner API calls.

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
3

## What to Test (one change per iteration)
1. **No calendar** — Current behavior, scanner gets raw market data only
2. **Economic calendar** — Scanner prompt includes: "Today: [event] at [time]. Impact: [high/medium/low]."
3. **Calendar + earnings** — Adds mega-cap earnings dates: "NVDA reports after close. Expect hedging flows."

## Calendar Data Needed (for 22 backtest days)
Build `src/data/economic-calendar.json`:
```json
{
  "2026-02-20": { "events": ["Initial Jobless Claims 8:30AM"], "impact": "medium" },
  "2026-03-07": { "events": ["NFP/Jobs Report 8:30AM"], "impact": "high" },
  "2026-03-12": { "events": ["CPI 8:30AM"], "impact": "high" },
  "2026-03-18": { "events": ["PPI 8:30AM"], "impact": "medium" },
  "2026-03-19": { "events": ["FOMC Rate Decision 2:00PM", "Powell Presser 2:30PM"], "impact": "critical" }
}
```

## Prerequisites
- Session 9 results (use best prompt variant as base)
- Economic calendar JSON built for all 22 backtest dates
- Scanner prompt modified to conditionally include calendar context
- API keys for scanner models

## Hypothesis
High-impact events (FOMC, CPI, NFP) create predictable volatility patterns. Telling the scanner "FOMC at 2PM" should make it avoid entries before the event and look for breakouts after. Calendar context should improve win rate on event days and have no effect on non-event days.

## Hold Constant
All other config values from best Sessions 1-8 + Session 9 results.
