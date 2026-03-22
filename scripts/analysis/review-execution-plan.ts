import 'dotenv/config';
import { getJudgeConfigs, askModel } from '../../src/agent/model-clients';
import { execSync } from 'child_process';

const EXECUTION_PLAN = `You are a senior quantitative trading systems architect specializing in 0DTE SPX options.

We are building an automated 0DTE SPX options trading agent. After a full-day replay of March 19, 2026 that lost $991 (1 winner, 6 losers), and after reviewing with 6 different AI models, we have consensus on a redesign.

KEY CONSTRAINT FROM THE TRADER:
"We're ONLY trading out-of-the-money. The goal is to be aggressive — we're not in this pool to play it safe, otherwise we'd be collecting dividends."
- ONLY OTM strikes priced $0.50-$3.00
- Risk controlled by position size (1-2 contracts), NOT strike proximity
- A $1.62 entry that can 20x is the trade. A $5.40 ITM entry that can 5x is NOT.
- Stop-loss at 50-70% of premium is acceptable — winners need to be 5-20x

CURRENT SYSTEM (what failed):
- RSI-14 is the PRIMARY trigger (RSI <20 or >80 escalates to judge panel)
- 4 scanners (Kimi K2.5, GLM-5, MiniMax M2.7, Claude Haiku) run every 15-60s
- 6 judges (Haiku, Sonnet, Opus, Kimi, GLM, MiniMax) run in parallel on escalation
- Only the "active judge" (Opus) decision is executed
- All calls go through Claude Agent SDK with env overrides for third-party models

MARCH 19 EVIDENCE:
- 7 RSI signals fired, 6 losers, 1 winner. Net: -$991
- Bug: call/put parsing flipped ALL call recommendations to puts
- Bug: TP/SL sanity check missing (judge returned SPX price instead of option price)
- RSI=85.7 at 09:50 → shorted into morning momentum rally (wrong regime)
- RSI=8.4 at 14:34 → judges picked C6585 (ITM, $5.40) instead of C6600 ($1.62 → $33.82 = +1,986%)
- RSI=82.2 at 14:57 → entered PUT while C6600 went $1.72→$33.82 (gamma squeeze, wrong regime)
- RSI blind for first 14min (warmup) AND 40min mid-session (pipeline resets)
- RSI=79.0 at 14:15 missed by 1 point below 80 threshold — was the local top

PROPOSED 4-LAYER REDESIGN:

LAYER 1: BUG FIXES (Day 1)
- Fix call/put parsing: isCall must handle C6xxx format, not just C0xxx
- Add TP/SL sanity: stop < entry AND stop > entry*0.3; TP > entry AND TP < entry*20
- Fix indicator pipeline resets (investigate PM2/websocket disconnects)
- Run only active judge live; log others async to prevent timeout cascade
- Fix MiniMax model name (already done: MiniMax-M2.7)

LAYER 2: REGIME CLASSIFIER (Day 2)
New file: regime-classifier.ts (~100 lines). Runs every bar.

Inputs:
1. Gap classification at open (|open - prior close| vs 20-day ATR)
2. Trend state: 20-bar linear regression slope
3. Time of day

Output: One of four regimes:
- MORNING_MOMENTUM (09:30-10:15): Suppress ALL counter-trend signals
- MEAN_REVERSION (10:15-14:00): RSI extremes + support/resistance valid
- TRENDING (any time, when slope > threshold): Follow momentum
- GAMMA_EXPIRY (14:00-15:30): Follow breakouts, don't fade

Gate rules:
| Regime | RSI Overbought | RSI Oversold | Breakout |
|--------|---------------|-------------|----------|
| MORNING_MOMENTUM | = continuation (no puts) | = continuation (no calls) | TRADE WITH |
| MEAN_REVERSION | = fade (puts OK) | = fade (calls OK) | suppress |
| TRENDING | = momentum (trade WITH) | = momentum (trade WITH) | TRADE WITH |
| GAMMA_EXPIRY | = momentum (follow) | = momentum (follow) | TRADE WITH |

This blocks 4 of 6 March 19 losers.

LAYER 3: PRICE-ACTION TRIGGERS (Days 3-4)
New file: price-action.ts (~150 lines). Supplements RSI, doesn't replace.

Trigger A: Session Extreme Break + Hold
- Price < session low AND next bar closes below = confirmed breakdown
- 0-1 bar lag

Trigger B: Range Expansion (adaptive)
- Current bar range > 95th percentile of last 50 bars
- Auto-calibrates to volatility

Trigger C: RSI Rate of Change
- RSI dropping 30+ points in 3 bars = exhaustion velocity
- Catches speed of move, not just level

Signal confluence: Require 2+ triggers within 3-bar window before escalating.

LAYER 4: JUDGE PROMPT REDESIGN (Day 4)
Inject regime context + OTM mandate into judge prompts:

"STRIKE SELECTION RULES:
- ONLY select OTM strikes priced $0.50-$3.00
- On EMERGENCY signals (RSI <15 or >85): go 20-30pts OTM
- On EXTREME signals (RSI <20 or >80): go 15-25pts OTM
- Risk controlled by POSITION SIZE (1-2 contracts), not strike proximity
- A $1.62 entry that can 20x is the trade. A $5.40 entry that can 5x is NOT."

Plus regime context:
"CURRENT REGIME: GAMMA_EXPIRY — Follow breakouts. Do NOT fade RSI extremes.
RSI overbought in this regime = MOMENTUM, not reversal."

VALIDATION: Re-run March 19 replay with all changes. Success criteria:
1. Signal #1 (09:50 PUT) → BLOCKED by MORNING_MOMENTUM regime
2. Signal #4 (13:14 CALL) → CORRECTLY enters C6600 at $1.62-$3.00, not C6585 at $5.40
3. Signal #6 (14:34 CALL) → Enters C6600 @ $1.62 or C6615 @ $0.55
4. Signal #7 (14:57 PUT) → BLOCKED by GAMMA_EXPIRY regime
5. Total signal count for the day ≤ 10
6. Net P&L positive on the March 19 replay

YOUR TASK:
1. Score the plan 1-10. Be specific about what loses points.
2. Identify the single biggest risk in this plan.
3. What's MISSING that would make this fail in production (not just on the March 19 replay)?
4. Score the OTM-only mandate specifically: is this correct for 0DTE, or suicidal?
5. Give your top 3 specific, actionable suggestions for improvement.
6. Would you trade this system with real money after these changes? Yes/No and why.

Be brutally honest. No hedging.`;

async function main() {
  const judges = getJudgeConfigs();

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  EXECUTION PLAN REVIEW — All Models + Gemini`);
  console.log(`${'═'.repeat(80)}\n`);

  // Run all Claude Agent SDK models sequentially
  for (const judge of judges) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  [${judge.label}] reviewing...`);
    console.log(`${'─'.repeat(80)}`);

    try {
      const response = await askModel(
        judge,
        'You are a senior quantitative trading systems architect. Be direct, specific, and brutally honest.',
        EXECUTION_PLAN,
        120000
      );
      console.log(response);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`);
    }
    console.log();
  }

  // Run Gemini 3.1 Pro via LiteLLM (Claude Agent SDK with env override)
  const geminiConfig = {
    id: 'gemini-3.1-pro',
    label: 'Gemini 3.1 Pro',
    model: 'gemini-3.1-pro-preview',
    env: {
      ANTHROPIC_BASE_URL: process.env.LITELLM_BASE_URL || 'http://localhost:4010/v1',
      ANTHROPIC_API_KEY: process.env.LITELLM_KEY || 'sk-litellm-master-simplepilot',
    },
  };

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  [${geminiConfig.label}] reviewing...`);
  console.log(`${'─'.repeat(80)}`);

  try {
    const response = await askModel(
      geminiConfig,
      'You are a senior quantitative trading systems architect. Be direct, specific, and brutally honest.',
      EXECUTION_PLAN,
      180000
    );
    console.log(response);
  } catch (e: any) {
    console.log(`  ERROR: ${e.message}`);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  REVIEW COMPLETE`);
  console.log(`${'═'.repeat(80)}\n`);
}

main().catch(console.error);
