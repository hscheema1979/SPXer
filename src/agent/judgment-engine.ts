/**
 * JudgmentEngine: sends a candidate signal to Claude with full market context
 * and receives a structured trading decision.
 *
 * Claude acts as an expert 0DTE options trader — reviewing not just the signal
 * itself but the full situation: SPX trend, time of day, risk/reward, concerns.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AgentSignal, AgentDecision } from './types';
import type { RiskGuard } from './risk-guard';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are an expert 0DTE SPX options trader with a disciplined, risk-first approach.

Your role: Review a real-time trading signal and decide whether to enter a position.

Core principles:
- Skip more trades than you take — selectivity is your edge
- Risk/reward must be at least 2:1 before considering entry
- RSI signals on 0DTE options are momentum plays, not reversals — trend alignment matters
- Time of day matters: 9:30-10:30 AM is chaotic, 11-2 PM is cleanest, 2-3 PM can have strong moves
- For PUTS: SPX should be declining or at resistance. For CALLS: SPX should be rising or at support
- If the option's RSI just crossed 40, the move may just be starting — but check if SPX is supportive
- High ATR (>10% of price) means volatile — size down or skip
- Never fight the primary SPX trend for more than 1-2 bars

Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.`;

function buildUserMessage(signal: AgentSignal, guard: RiskGuard): string {
  const { spxContext, indicators, recentBars } = signal;
  const mid = signal.bid && signal.ask ? ((signal.bid + signal.ask) / 2).toFixed(2) : signal.currentPrice.toFixed(2);
  const stopDistance = (signal.currentPrice - signal.signalBarLow).toFixed(2);
  const riskPerContract = ((signal.currentPrice - signal.signalBarLow) * 100).toFixed(0);
  const maxContracts = guard.maxContracts(signal.currentPrice, signal.signalBarLow);

  const recentSummary = recentBars.slice(-5).map(b =>
    `  {close:${b.close.toFixed(2)}, rsi:${b.rsi14?.toFixed(1) ?? 'n/a'}, ema9:${b.ema9?.toFixed(2) ?? 'n/a'}, ema21:${b.ema21?.toFixed(2) ?? 'n/a'}}`
  ).join('\n');

  return `SIGNAL: ${signal.type} on ${signal.symbol}
Type: ${signal.side.toUpperCase()} | Strike: ${signal.strike} | Expiry: ${signal.expiry} (0DTE)

OPTION PRICE:
  Current: $${signal.currentPrice.toFixed(2)} (mid: $${mid})
  Bid: $${signal.bid?.toFixed(2) ?? 'n/a'} | Ask: $${signal.ask?.toFixed(2) ?? 'n/a'}

OPTION INDICATORS:
  RSI(14): ${indicators.rsi14?.toFixed(1) ?? 'n/a'}
  EMA9: ${indicators.ema9?.toFixed(2) ?? 'n/a'} | EMA21: ${indicators.ema21?.toFixed(2) ?? 'n/a'}
  HMA5: ${indicators.hma5?.toFixed(2) ?? 'n/a'} | HMA19: ${indicators.hma19?.toFixed(2) ?? 'n/a'}

RECENT BARS (oldest → newest):
${recentSummary}

SPX CONTEXT:
  Price: ${spxContext.price.toFixed(2)} | Change: ${spxContext.changePercent.toFixed(2)}%
  Trend: ${spxContext.trend.toUpperCase()} | RSI: ${spxContext.rsi14?.toFixed(1) ?? 'n/a'}
  Time to close: ${spxContext.minutesToClose}m | Mode: ${spxContext.mode}

RISK PARAMETERS:
  Proposed stop: $${signal.signalBarLow.toFixed(2)} (distance: $${stopDistance})
  Risk/contract: $${riskPerContract} (×100 shares)
  Max contracts at ${guard.config.maxRiskPerTrade} risk: ${maxContracts}
  Daily loss so far: $${Math.abs(guard.currentDailyLoss).toFixed(2)} of $${guard.config.maxDailyLoss} limit
  Paper mode: ${guard.isPaper}

DECISION REQUIRED:
Respond with JSON only:
{
  "action": "buy" or "skip",
  "confidence": <0.0-1.0>,
  "position_size": <contracts, 0 if skip>,
  "stop_loss": <price level>,
  "take_profit": <price level or null>,
  "reasoning": "<2-3 sentence explanation>",
  "concerns": ["<concern1>", "<concern2>"]
}`;
}

export async function getJudgment(
  signal: AgentSignal,
  guard: RiskGuard,
): Promise<AgentDecision> {
  const userMessage = buildUserMessage(signal, guard);

  console.log(`[judgment] Calling Claude for ${signal.symbol} (${signal.type})...`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  let parsed: any;
  try {
    // Strip any accidental markdown fences
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error('[judgment] Failed to parse Claude response:', text);
    return {
      action: 'skip',
      confidence: 0,
      positionSize: 0,
      stopLoss: signal.signalBarLow,
      takeProfit: null,
      reasoning: 'Claude response parse error — skipping for safety',
      concerns: ['Parse error'],
      ts: Date.now(),
    };
  }

  const decision: AgentDecision = {
    action: parsed.action === 'buy' ? 'buy' : 'skip',
    confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
    positionSize: parseInt(parsed.position_size) || 0,
    stopLoss: parseFloat(parsed.stop_loss) || signal.signalBarLow,
    takeProfit: parsed.take_profit ? parseFloat(parsed.take_profit) : null,
    reasoning: String(parsed.reasoning || ''),
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
    ts: Date.now(),
  };

  console.log(`[judgment] ${signal.symbol}: ${decision.action.toUpperCase()} (${(decision.confidence * 100).toFixed(0)}% confidence)`);
  console.log(`[judgment] Reasoning: ${decision.reasoning}`);
  if (decision.concerns.length > 0) {
    console.log(`[judgment] Concerns: ${decision.concerns.join('; ')}`);
  }

  return decision;
}
