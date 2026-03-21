# SPXer — 0DTE SPX Options Trading Agent

Autonomous trading agent for S&P 500 (SPX) 0-day-to-expiration options. Collects real-time market data, runs multi-model AI scanners to read market conditions, and executes aggressive OTM option trades targeting asymmetric returns.

**Philosophy**: An agentic system that builds a rolling narrative throughout the day. Scanners don't just react to current bars — they track trajectory, record what they see building, and escalate to the judge with the full story of how the session unfolded. The judge doesn't receive isolated signals; it receives context-rich escalations that include overnight setup, session trajectory, and the scanner's own evolving interpretation.

**Status**: Paper trading. Live monitor running with 6 AI models in parallel.

See [CLAUDE.md](CLAUDE.md) for full technical documentation.

---

## Today's Goals (March 20, 2026)

1. **Live monitor running** — 6 models (Haiku, Sonnet, Opus, Kimi, GLM, MiniMax) watching today's session with neutral prompts. Each signal fires 12 parallel calls (6 models x with/without regime). Compare decisions.
2. **Fix serialization timeout** — Claude models (Haiku/Sonnet/Opus) all timed out at first signal because `query()` serializes through one session. Need to run third-party models (Kimi, GLM, MiniMax) via direct HTTP instead of Claude Agent SDK, or increase timeout.
3. **Iterate backtester (US-003/US-004)** — Re-run `backtest-multi.ts` with widened price band ($0.20-$8.00). Get win rate from 20% → 40%+. Separate session handling this.
4. **Collect today's full replay** — At market close, run today's data through backtester and generate `2026-03-20-replay.md`. Compare what the live scanners said vs what the deterministic system would have done.
5. **Validate MiniMax as lead scanner** — First signal today: MiniMax was the only model that responded in time AND made a call (BUY C6595/C6600 at RSI=11.7). Track if its calls are correct through the day.

---

## Scanning Agents & Judge Agents

### Scanners (Tier 1) — "What do you see?"
Fast, cheap models that read raw market data every 15-60 seconds. Their job is to assess conditions and flag setups. All use the Claude Agent SDK with `env` overrides to route to third-party APIs.

| Model | Provider | Speed | Personality | API |
|-------|----------|-------|-------------|-----|
| **Kimi K2.5** | Moonshot | ~2.6s | Cautious, analytical. Wants confirmation before committing. | api.kimi.com/coding/ |
| **ZAI GLM-5** | Zhipu AI | ~3-5s | Fundamentals-focused. Considers macro context. Passed on March 20 signal ("too far OTM"). | api.z.ai/api/anthropic |
| **MiniMax M2.7** | MiniMax | ~40-47s | Aggressive, decisive. Only model to respond AND say BUY on first live signal. Picks specific strikes. | api.minimax.io/anthropic |

### Judges (Tier 2) — "Should we trade?"
Claude models that review scanner output + full market context and make the final call. Currently all timing out due to `query()` serialization bug — all 3 share one Claude session and each waits for the others.

| Model | Speed | Personality | Status |
|-------|-------|-------------|--------|
| **Claude Haiku** | Fast | Quick tiebreaker, momentum reader | TIMEOUT (serialization bug) |
| **Claude Sonnet** | Medium | Structured, decisive, good at formatted output | TIMEOUT (serialization bug) |
| **Claude Opus** | Slow | Deep reasoning, considers edge cases, sometimes overly cautious | TIMEOUT (serialization bug) |

### Prompt Philosophy
All models receive the same neutral prompt — raw OHLC bars, RSI value, and the contract chain. **No guidance on what RSI means, no "emergency" language, no bias.** We're testing whether the models are naturally good market readers or just parroting what we tell them.

Two variants run for each model:
- **+REGIME**: Prompt includes a one-line tag like `[Regime classifier says: TRENDING_DOWN]`
- **-REGIME**: No regime context at all

### What We're Testing After Market Close

**Test 1: Model Accuracy Scorecard**
For every signal that fired today, compare what each model said vs what actually happened in the next 30 minutes. Score each model on:
- Did it say BUY or PASS? (decisiveness)
- Did it pick the right direction? (call vs put)
- Did it pick a strike that would have been profitable? (strike selection)
- How confident was it? (confidence calibration — was 72% confidence better than 62%?)

**Test 2: Regime Filter Value**
Compare +REGIME vs -REGIME decisions for every model. Questions:
- Did the regime tag change any model's decision? (If not, it's useless)
- When it changed the decision, was the change correct? (Does regime improve accuracy or hurt it?)
- Does regime make models more conservative? (We don't want that — we're aggressive)

**Test 3: Deterministic vs LLM**
Run today's bars through `backtest-multi.ts` (deterministic: RSI trigger → regime gate → auto-select cheapest OTM). Compare its trades against what the live scanners recommended. Questions:
- Did the deterministic system catch the same signals?
- Did it pick better or worse strikes?
- Was its P&L higher or lower?
- Did any LLM catch a signal the deterministic system missed?

**Test 4: Speed vs Quality**
MiniMax was the only model that responded in time (40-47s). All others timed out at 60s. Questions:
- Is a 47s response fast enough for 0DTE? (Option prices can move 50% in that time)
- Would a dumber but instant system (deterministic) outperform a smarter but slow system (LLM)?
- Can we fix the Claude timeout by running Haiku/Sonnet/Opus via LiteLLM proxy instead of Claude Agent SDK?

**Test 5: MiniMax Deep Dive**
MiniMax made two calls at the first signal:
- +REGIME: BUY C6595 @ 62% confidence ("overdue short-covering bounce")
- -REGIME: BUY C6600 @ 72% confidence ("extreme RSI oversold with 37-point pullback")

After market, we check: Did C6595 or C6600 go up? Was C6600 (no regime, more aggressive) a better pick than C6595 (with regime, more conservative)? Did the regime tag make MiniMax less aggressive — and was that good or bad?

---

## Current Sprint — Backtest & Go-Live

### US-001: Build multi-day backtester script
**Status**: DONE

- [x] `backtest-multi.ts` exists and runs without errors
- [x] Accepts date range args or auto-detects all available days in DB
- [x] For each day: runs regime classifier, applies signal gate, uses deterministic strike selector
- [x] Generates per-day P&L summary and overall scorecard
- [x] Outputs to console AND saves per-day replay markdown to `replay-library/`

### US-002: Generate chapter-by-chapter replay logs for each day
**Status**: DONE

- [x] Each trading day gets a markdown file in `replay-library/` (e.g., `2026-02-18-replay.md`)
- [x] Each file includes: SPX price timeline, regime classifications, signals fired/blocked, trades taken, P&L
- [ ] SQL queries included for each chapter so user can reproduce from DB
- [ ] Escalation events show regime state, gate decision, and strike selection reasoning

### US-003: Run backtest across all 22 backfilled days and score
**Status**: IN PROGRESS

- [x] Backtest runs successfully across all days with option data in DB
- [ ] Overall scorecard shows: win rate >40%, total P&L positive, max single-day loss <$500
- [ ] Emergency oversold signals (RSI <15) are caught on every day they occur
- [ ] Regime classifier correctly blocks counter-trend signals
- **Blocker**: 15/20 days had sparse option data (42 contracts/day from Polygon). Price band widened to $0.20-$8.00. Need to re-run and validate.

### US-004: Iterate parameters until targets met
**Status**: NOT STARTED

- [ ] Win rate > 40% across all tested days
- [ ] Average P&L positive per day
- [ ] No single day loses more than $500
- [ ] Emergency oversold/overbought trades consistently caught and profitable
- [ ] Parameter changes documented with before/after comparison
- **Depends on**: US-003 completing with valid data

### US-005: Final validation and live-readiness check
**Status**: NOT STARTED

- [ ] Final backtest scorecard saved to `replay-library/SCORECARD.md`
- [ ] All parameter values documented and committed
- [ ] Live system uses validated parameters
- [ ] PM2 restart command documented for deployment
- [ ] `AGENT_PAPER=false` tested in dry-run
- **Depends on**: US-004 meeting all targets

---

## Quick Start

```bash
# Data pipeline (always running)
pm2 start spxer

# Live monitor — 6 models in parallel, with/without regime
pm2 start live-monitor

# Run multi-day backtest
npx tsx backtest-multi.ts

# Single day
npx tsx backtest-multi.ts 2026-03-19

# Compare with/without regime filter
npx tsx backtest-multi.ts        # with regime
npx tsx backtest-no-regime.ts    # without regime
```

## Architecture

```
Data Pipeline (spxer)          Agent Layer                    Execution
───────────────────          ───────────                    ─────────
Tradier → SPX/ES bars    →    Scanners (Kimi, GLM, MiniMax) → Regime classifier
Yahoo  → ES overnight         Judges (Haiku, Sonnet, Opus)    Strike selector
           ↓                         ↓                         (deterministic)
        SQLite DB              MarketNarrative (per-scanner)         ↓
        (1m OHLCV +            — rolling trajectory, session build    Trade executor
         indicators)           — overnight + pre-mkt + intraday       Stop/TP/time-exit
                              — escalation with full context
```

## Key Principles

> "We're not collecting dividends." — OTM only. Aggressive asymmetric bets.

**Anticipation over reaction.** A human trader doesn't just react to each bar — they watch a story unfold. They see RSI climbing from 30, notice the trajectory, and anticipate the breakout before it happens. The system should work the same way. Scanners build narrative state across the session: session trajectory (SPX/RSI high/low with timestamps), overnight context, pre-market setup, notable moves, their own notes. When they escalate, it's not "I see something now" — it's "here's how we got here and what I'm watching."

**Deterministic execution, agentic oversight.** Strike selection, stops, and position sizing are handled by deterministic code — no hallucination risk. LLM scanners are the eyes: they read the market, build the narrative, and escalate with context. The judge validates or blocks based on the full story. Price-action confluence provides a parallel, instantaneous trigger for when deterministic conditions fire simultaneously.

**LLMs advise, code executes. No AI in the hot path.**
