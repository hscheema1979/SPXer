/**
 * JudgmentEngine: sends the FULL market snapshot to Claude every 15-30s.
 * Claude is the signal detector AND the decision maker — it reviews all
 * timeframes, all contracts, determines what matters today, and says
 * what to do right now.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MarketSnapshot, ContractState } from './market-feed';
import type { OpenPosition } from './types';
import type { RiskGuard } from './risk-guard';

// Default: haiku for continuous 15-30s polling (cost-effective).
// Override with AGENT_MODEL=claude-sonnet-4-6 for heavier analysis.
const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-haiku-4-5-20251001';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expert 0DTE SPX options trader running autonomously.

You are called every 15-60 seconds with a full snapshot of the current market state
across sub-minute quotes, 1m, 3m, and 5m bars for all tracked contracts.

Your job: decide what action (if any) to take RIGHT NOW.

Trading philosophy:
- Different days call for different signals. You adapt — don't use the same ruleset every day.
- High RSI momentum on 1m confirmed by 3m and 5m = strong entry. One timeframe alone = weak.
- Trend alignment matters: SPX direction should match the option type (puts when SPX falling, calls when rising).
- Sub-minute quote flow tells you real-time pressure: bid rising faster than ask = accumulation.
- Time of day: 9:30-10:30 chaotic, 11-1 PM cleanest setups, 1-3 PM range-bound or trend, after 3 PM moves fast but risky.
- Skip trades with fewer than 75 minutes to close unless the setup is exceptional.
- A "wait" with shorter next_check_secs means you see something building — increase monitoring tempo.
- A "wait" with longer next_check_secs means market is quiet — no need to watch as often.
- Never trade just because you haven't traded yet. Patience is the edge.

Risk rules (enforced externally — you still must respect them in sizing):
- Stop loss must be defined. Stop distance should be 20-40% of current option price.
- Take profit should target at least 2x the risk distance.
- Respect max positions and daily loss limits shown in context.

Respond ONLY with valid JSON — no markdown, no text outside the JSON.`;

function formatBar(b: { close: number; rsi14: number | null; ema9: number | null; ema21: number | null; hma5: number | null } | undefined): string {
  if (!b) return 'n/a';
  return `close=${b.close.toFixed(2)} rsi=${b.rsi14?.toFixed(1) ?? '-'} ema9=${b.ema9?.toFixed(2) ?? '-'} ema21=${b.ema21?.toFixed(2) ?? '-'} hma5=${b.hma5?.toFixed(2) ?? '-'}`;
}

function formatContractBlock(cs: ContractState): string {
  const q = cs.quote;
  const curr1m = cs.bars1m[cs.bars1m.length - 1];
  const prev1m = cs.bars1m[cs.bars1m.length - 2];
  const curr3m = cs.bars3m[cs.bars3m.length - 1];
  const curr5m = cs.bars5m[cs.bars5m.length - 1];

  const rsiDir = curr1m?.rsi14 !== null && prev1m?.rsi14 !== null
    ? (curr1m!.rsi14! > prev1m!.rsi14! ? '↑' : curr1m!.rsi14! < prev1m!.rsi14! ? '↓' : '→')
    : '';

  return `  ${cs.meta.symbol} (${cs.meta.side.toUpperCase()} ${cs.meta.strike} ${cs.meta.expiry})
    Quote: last=$${q.last?.toFixed(2) ?? 'n/a'} bid=$${q.bid?.toFixed(2) ?? 'n/a'} ask=$${q.ask?.toFixed(2) ?? 'n/a'} mid=$${q.mid?.toFixed(2) ?? 'n/a'}${q.changePct !== null ? ` chg=${q.changePct.toFixed(1)}%` : ''}
    1m [trend:${cs.trend1m}]: ${formatBar(curr1m)} rsi${rsiDir}
    3m [trend:${cs.trend3m}]: ${formatBar(curr3m)}
    5m [trend:${cs.trend5m}]: ${formatBar(curr5m)}`;
}

function buildPrompt(snap: MarketSnapshot, positions: OpenPosition[], guard: RiskGuard): string {
  const spx = snap.spx;
  const curr1m = spx.bars1m[spx.bars1m.length - 1];
  const curr3m = spx.bars3m[spx.bars3m.length - 1];
  const curr5m = spx.bars5m[spx.bars5m.length - 1];

  const posBlock = positions.length === 0
    ? '  None'
    : positions.map(p =>
        `  ${p.symbol} x${p.quantity} @ $${p.entryPrice.toFixed(2)} | stop=$${p.stopLoss.toFixed(2)}${p.takeProfit ? ` tp=$${p.takeProfit.toFixed(2)}` : ''} | entry ${Math.round((Date.now() - p.openedAt) / 60000)}m ago`
      ).join('\n');

  const contractBlock = snap.contracts.length === 0
    ? '  No contracts tracked'
    : snap.contracts.map(formatContractBlock).join('\n\n');

  return `TIME: ${snap.timeET} | ${snap.minutesToClose}m to close | Mode: ${snap.mode}

SPX UNDERLYING:
  Price: ${spx.price.toFixed(2)} (${spx.changePct >= 0 ? '+' : ''}${spx.changePct.toFixed(2)}% this session)
  1m [trend:${spx.trend1m}]: ${formatBar(curr1m)}
  3m [trend:${spx.trend3m}]: ${formatBar(curr3m)}
  5m [trend:${spx.trend5m}]: ${formatBar(curr5m)}

OPEN POSITIONS (${positions.length}/${guard.config.maxPositions} max):
${posBlock}

RISK:
  Daily P&L: $${guard.currentDailyLoss >= 0 ? '+' : ''}${guard.currentDailyLoss.toFixed(2)} | Daily loss limit: $${guard.config.maxDailyLoss}
  Max risk/trade: $${guard.config.maxRiskPerTrade} | Paper mode: ${guard.isPaper}

TRACKED CONTRACTS (${snap.contracts.length}, sorted by 1m RSI desc):
${contractBlock}

---
What do you see? Review all timeframes and decide what action to take RIGHT NOW.
If you see a setup building but not ready, set next_check_secs=15.
If market is quiet, set next_check_secs=30-60.

Respond with JSON:
{
  "market_read": "<1-2 sentences on what you observe about current conditions>",
  "action": "buy" | "sell_to_close" | "wait",
  "target_symbol": "<full option symbol or null>",
  "confidence": <0.0-1.0>,
  "position_size": <contracts, 0 if wait>,
  "stop_loss": <price or null>,
  "take_profit": <price or null>,
  "reasoning": "<why this action or why waiting>",
  "concerns": ["<concern>"],
  "next_check_secs": <15-60>
}`;
}

export interface Assessment {
  marketRead: string;
  action: 'buy' | 'sell_to_close' | 'wait';
  targetSymbol: string | null;
  confidence: number;
  positionSize: number;
  stopLoss: number | null;
  takeProfit: number | null;
  reasoning: string;
  concerns: string[];
  nextCheckSecs: number;
  ts: number;
}

export async function assess(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
): Promise<Assessment> {
  const prompt = buildPrompt(snap, positions, guard);

  const response = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    console.error('[judgment] Parse error:', text);
    return {
      marketRead: 'Parse error', action: 'wait', targetSymbol: null,
      confidence: 0, positionSize: 0, stopLoss: null, takeProfit: null,
      reasoning: 'Response parse failed — waiting', concerns: ['parse error'],
      nextCheckSecs: 30, ts: Date.now(),
    };
  }

  return {
    marketRead: String(parsed.market_read || ''),
    action: ['buy', 'sell_to_close', 'wait'].includes(parsed.action) ? parsed.action : 'wait',
    targetSymbol: parsed.target_symbol || null,
    confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
    positionSize: parseInt(parsed.position_size) || 0,
    stopLoss: parsed.stop_loss ? parseFloat(parsed.stop_loss) : null,
    takeProfit: parsed.take_profit ? parseFloat(parsed.take_profit) : null,
    reasoning: String(parsed.reasoning || ''),
    concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
    nextCheckSecs: Math.max(15, Math.min(120, parseInt(parsed.next_check_secs) || 30)),
    ts: Date.now(),
  };
}
