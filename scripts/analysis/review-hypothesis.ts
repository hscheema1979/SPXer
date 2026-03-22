import 'dotenv/config';
import { getScannerConfigs, getJudgeConfigs, askModel } from '../../src/agent/model-clients';

const HYPOTHESIS = `You are an expert 0DTE SPX options system architect. A colleague has proposed a FUNDAMENTAL redesign of our trading signal engine. 

CURRENT SYSTEM:
- RSI-14 is the PRIMARY trigger (RSI <20 or >80 escalates to judge)
- Scanners (Kimi, GLM, MiniMax, Haiku) run every 15-60s reading market data
- When RSI extreme detected OR scanner confidence >0.5, escalates to judge panel
- Judge panel (Haiku, Sonnet, Opus, Kimi, GLM, MiniMax) decides whether to trade
- Only the "active judge" (Opus) decision is executed; others logged for comparison

PROBLEM EVIDENCE FROM MARCH 19 2026 REPLAY:
- 7 signals fired, 6 losers, 1 winner. Net P&L: -$991
- The system ENTERED PUTS at 14:57 (RSI=82.2 overbought) while C6600 went from $1.72→$33.82 (+1,867%)
- RSI needs 14 bars to warm up — system was BLIND for first 14 minutes AND during 40-min data gaps
- RSI=79.0 at 14:15 missed by 1 point (threshold=80) — this was the local top before a 20pt drop
- Morning overbought (RSI=85.7 at 09:50) was a MOMENTUM signal, not reversal — system shorted into a rally
- The 13:27 overbought (RSI=89.5) was a whipsaw after a sharp bounce from oversold — false signal

PROPOSED REDESIGN — "Price Action First":
Replace RSI as the primary trigger with these price-action signals:

1. Break of session high/low: Price < min(all prior closes) → instant, 0 lag
2. Candle size spike: Current bar range > 2x average range → 1 bar lag  
3. V-reversal: 3+ red bars then green bar reclaiming 50%+ of drop → 1 bar lag
4. Level break with acceleration: Price crosses round number AND next bar continues → 2 bar lag
5. Volume spike: Volume > 3x rolling average → 1 bar lag
6. RSI extreme: Keep as SECONDARY confirmation only, not primary trigger → 14 bar lag

The argument: "Price action IS the primary signal. RSI is a lagging derivative of it. By the time RSI says oversold, your eyes already saw 14 red candles. On 0DTE where $1.62 becomes $33.82 in 10 minutes, lag is death."

At 14:34 (RSI=8.4), a price-action system would have seen: "SPX broke below 6580 support, candle wicks getting longer (buyers absorbing), range contracting after a series of red bars" — a bottoming pattern visible BEFORE RSI computed 8.4.

At 15:00, a price-action system would have seen: "SPX printed a candle 3x the size of the last 20, broke above 6595 resistance with volume spike" — a breakout. The RSI system saw RSI=82 and entered a PUT.

YOUR TASK:
1. Do you AGREE or DISAGREE with this redesign? Why?
2. What specific risks or blind spots does the price-action approach introduce?
3. What would YOU add or change to this proposal?
4. How would you handle the "morning momentum vs reversal" problem specifically?
5. Rate the proposal 1-10 and give your single most important recommendation.

Be direct and specific. No hedging. Give your honest expert opinion.`;

async function main() {
  // Get all unique model configs
  const judges = getJudgeConfigs();
  
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  HYPOTHESIS REVIEW: Price-Action-First Redesign`);
  console.log(`  Reviewing with ${judges.length} models (sequential to avoid timeout)`);
  console.log(`${'═'.repeat(80)}\n`);

  for (const judge of judges) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  [${judge.label}] reviewing...`);
    console.log(`${'─'.repeat(80)}`);
    
    try {
      const response = await askModel(judge, 'You are a senior quantitative trading systems architect specializing in 0DTE SPX options. Respond directly and concisely.', HYPOTHESIS, 120000);
      console.log(response);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`);
    }
    console.log();
  }
}

main().catch(console.error);
