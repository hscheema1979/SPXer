import 'dotenv/config';
import { askModel } from '../../src/agent/model-clients';

const PROMPT = `You are a senior quantitative trading systems architect specializing in 0DTE SPX options.

We are building an automated 0DTE SPX options trading agent. After a full-day replay of March 19, 2026 that lost $991 (1 winner, 6 losers), and reviewing with 6 AI models, we have consensus on a redesign.

KEY CONSTRAINT: "We're ONLY trading out-of-the-money. The goal is aggressive — not safe. Otherwise we'd be collecting dividends."
- ONLY OTM strikes priced $0.50-$3.00. Risk controlled by position size (1-2 contracts).
- A $1.62 entry that can 20x is the trade. A $5.40 ITM entry is NOT.

WHAT FAILED ON MARCH 19:
- RSI-14 as primary trigger: 7 signals, 6 losers, -$991
- Bug flipped all call entries to puts (parsing error)
- RSI=85.7 at 09:50 shorted into morning momentum (wrong regime)
- RSI=8.4 at 14:34 judges picked safe ITM C6585($5.40) instead of OTM C6600($1.62→$33.82=+1,986%)
- RSI=82.2 at 14:57 entered PUT while calls ran +1,867% (gamma squeeze, wrong regime)

PROPOSED 4-LAYER FIX:
Layer 1 (bugs): Fix call/put parsing, TP/SL sanity, pipeline resets, judge serialization
Layer 2 (regime classifier): MORNING_MOMENTUM / MEAN_REVERSION / TRENDING / GAMMA_EXPIRY gates
Layer 3 (price-action triggers): Session break+hold, range expansion (95th pctl), RSI rate-of-change. Require 2+ confluence.
Layer 4 (judge prompts): Inject regime context + OTM mandate. "ONLY select strikes $0.50-$3.00, 15-30pts OTM on emergency signals."

YOUR TASK (be concise, ~300 words max):
1. Score the plan 1-10
2. Single biggest risk
3. What's MISSING for production?
4. Is OTM-only correct for 0DTE or suicidal?
5. Top 3 actionable suggestions
6. Would you trade this with real money? Yes/No + why`;

const SYS = 'You are a senior quantitative trading systems architect. Be direct and concise (~300 words).';

async function main() {
  const models = [
    { id: 'haiku', label: 'Claude Haiku', model: 'claude-haiku-4-5-20251001' },
    { id: 'sonnet', label: 'Claude Sonnet', model: 'claude-sonnet-4-6' },
    { id: 'opus', label: 'Claude Opus', model: 'claude-opus-4-6' },
    { id: 'glm', label: 'ZAI GLM-5', model: process.env.GLM_MODEL || 'glm-5',
      env: { ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL!, ANTHROPIC_API_KEY: process.env.GLM_API_KEY! } },
  ];

  for (const m of models) {
    const start = Date.now();
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  [${m.label}] reviewing...`);
    console.log(`${'─'.repeat(80)}`);
    try {
      const r = await askModel(m as any, SYS, PROMPT, 90000);
      console.log(r);
      console.log(`  (${((Date.now()-start)/1000).toFixed(1)}s)`);
    } catch(e:any) { console.log(`  ERROR: ${e.message} (${((Date.now()-start)/1000).toFixed(1)}s)`); }
  }
}
main().catch(console.error);
