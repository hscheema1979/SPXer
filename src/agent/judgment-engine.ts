/**
 * JudgmentEngine — two-tier continuous market assessment.
 *
 * Tier 1 (Scanner): Kimi K2.5 + GLM-5 run in parallel every 15-30s via
 *   LiteLLM proxy (OpenAI-compatible). They scan all timeframes and flag
 *   setups building. Cheap and fast.
 *
 * Tier 2 (Judge): Claude Opus fires ONLY when a scanner flags something
 *   interesting (confidence >= 0.5). Gets the full market context PLUS
 *   both scanner reads. Makes the actual trade decision.
 *
 * Cost: scanners ~free via Chutes, Opus ~$0.03/call × 5-15 calls/day = ~$0.15-0.45/day
 */
import type { MarketSnapshot, ContractState } from './market-feed';
import type { OpenPosition } from './types';
import type { RiskGuard } from './risk-guard';
import { getScanners, getJudge } from './model-clients';
import type { ScannerClient } from './model-clients';

// ---------------------------------------------------------------------------
// Shared prompt building
// ---------------------------------------------------------------------------

const SCANNER_SYSTEM = `You are an expert 0DTE SPX options day-trader scanning for setups.

You are called every 15-60 seconds with the current market state across sub-minute
quotes, 1m, 3m, and 5m bars for all tracked contracts.

Your job: quickly assess whether ANY setup is building right now. You are NOT making
the trade decision — a senior trader reviews your flags. Be honest about what you see.

Different days call for different signals. Adapt to current conditions:
- Trend days: momentum entries (RSI break of 40-50, EMA crossovers)
- Range days: mean-reversion at extremes (RSI <25 or >75, Bollinger touches)
- Time matters: 9:30-10:30 chaotic, 11-1 PM cleanest, after 3 PM fast but risky

Respond ONLY with valid JSON — no markdown, no text outside the JSON.
{
  "market_read": "<1-2 sentences on current conditions>",
  "setups": [
    {
      "symbol": "<option symbol>",
      "setup_type": "<what you see forming>",
      "confidence": <0.0-1.0>,
      "urgency": "now" | "building" | "watch",
      "notes": "<what to watch for confirmation>"
    }
  ],
  "next_check_secs": <15-60>
}

If nothing is happening, return empty setups array and longer next_check_secs.`;

const JUDGE_SYSTEM = `You are a senior 0DTE SPX options trader making the final call.

Two junior analysts (Kimi K2.5 and GLM-5) have been scanning the market and flagged
potential setups. You now review their assessments alongside the FULL market data
to decide whether to act.

Your edge is patience and multi-timeframe confirmation:
- One timeframe alone is weak. Require 2+ timeframes aligning.
- SPX direction should match option type (puts when falling, calls when rising).
- Skip trades with <75 minutes to close unless setup is exceptional.
- Never trade just because the juniors flagged something. Most flags are noise.
- When you DO trade, define a clear stop-loss (20-40% of option price).

Respond ONLY with valid JSON — no markdown, no text outside the JSON.
{
  "market_read": "<your senior assessment of current conditions>",
  "scanner_agreement": "<do the juniors agree? what did they miss?>",
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

function buildMarketPrompt(snap: MarketSnapshot, positions: OpenPosition[], guard: RiskGuard): string {
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
${contractBlock}`;
}

// ---------------------------------------------------------------------------
// Scanner output type
// ---------------------------------------------------------------------------

export interface ScannerSetup {
  symbol: string;
  setupType: string;
  confidence: number;
  urgency: 'now' | 'building' | 'watch';
  notes: string;
}

export interface ScannerResult {
  scannerId: string;
  marketRead: string;
  setups: ScannerSetup[];
  nextCheckSecs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Assessment output type (from judge)
// ---------------------------------------------------------------------------

export interface Assessment {
  marketRead: string;
  scannerAgreement: string;
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
  tier: 'scanner' | 'judge';
}

// ---------------------------------------------------------------------------
// Tier 1: Scanners (Kimi/GLM direct via Anthropic SDK, MiniMax via OpenAI SDK)
// ---------------------------------------------------------------------------

/** Call an Anthropic-compatible scanner (Kimi direct, GLM-5 direct) */
async function callAnthropicScanner(scanner: ScannerClient, prompt: string): Promise<string> {
  const isThinkingModel = scanner.id === 'kimi';
  const response = await scanner.anthropic!.messages.create({
    model: scanner.model,
    max_tokens: isThinkingModel ? 4000 : 800,
    system: SCANNER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0]?.type === 'text' ? response.content[0].text : '';
}

/** Call an OpenAI-compatible scanner (MiniMax via LiteLLM/Chutes) */
async function callOpenAIScanner(scanner: ScannerClient, prompt: string): Promise<string> {
  const response = await scanner.openai!.chat.completions.create({
    model: scanner.model,
    max_tokens: 800,
    messages: [
      { role: 'system', content: SCANNER_SYSTEM },
      { role: 'user', content: prompt },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

function parseScannerResponse(scannerId: string, text: string): ScannerResult {
  const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return {
      scannerId,
      marketRead: 'Parse error',
      setups: [],
      nextCheckSecs: 30,
      error: `JSON parse failed: ${text.slice(0, 100)}`,
    };
  }

  return {
    scannerId,
    marketRead: String(parsed.market_read || ''),
    setups: (Array.isArray(parsed.setups) ? parsed.setups : []).map((s: any) => ({
      symbol: String(s.symbol || ''),
      setupType: String(s.setup_type || ''),
      confidence: Math.max(0, Math.min(1, parseFloat(s.confidence) || 0)),
      urgency: ['now', 'building', 'watch'].includes(s.urgency) ? s.urgency : 'watch',
      notes: String(s.notes || ''),
    })),
    nextCheckSecs: Math.max(15, Math.min(120, parseInt(parsed.next_check_secs) || 30)),
  };
}

async function runScanner(scanner: ScannerClient, prompt: string): Promise<ScannerResult> {
  try {
    const text = scanner.type === 'anthropic'
      ? await callAnthropicScanner(scanner, prompt)
      : await callOpenAIScanner(scanner, prompt);

    return parseScannerResponse(scanner.id, text);
  } catch (e) {
    return {
      scannerId: scanner.id,
      marketRead: '',
      setups: [],
      nextCheckSecs: 30,
      error: (e as Error).message,
    };
  }
}

export async function scan(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
): Promise<ScannerResult[]> {
  const prompt = buildMarketPrompt(snap, positions, guard);
  const scanners = getScanners();

  // Run both scanners in parallel
  const results = await Promise.allSettled(
    scanners.map(s => runScanner(s, prompt))
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { scannerId: scanners[i].id, marketRead: '', setups: [], nextCheckSecs: 30, error: String(r.reason) }
  );
}

// ---------------------------------------------------------------------------
// Tier 2: Judge (Opus via Anthropic)
// ---------------------------------------------------------------------------

export async function judge(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
  scannerResults: ScannerResult[],
): Promise<Assessment> {
  const marketPrompt = buildMarketPrompt(snap, positions, guard);

  // Append scanner reads for the judge
  const scannerBlock = scannerResults.map(sr => {
    const setupLines = sr.setups.length === 0
      ? '    No setups flagged'
      : sr.setups.map(s =>
          `    - ${s.symbol}: ${s.setupType} (conf=${s.confidence.toFixed(2)}, urgency=${s.urgency}) — ${s.notes}`
        ).join('\n');
    return `  ${sr.scannerId.toUpperCase()} says: "${sr.marketRead}"\n${setupLines}`;
  }).join('\n\n');

  const judgePrompt = `${marketPrompt}

SCANNER ASSESSMENTS:
${scannerBlock}

---
Review the scanner flags alongside the full data. Make the call.`;

  const opus = getJudge();

  try {
    const response = await opus.client.messages.create({
      model: opus.model,
      max_tokens: 800,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: judgePrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(clean);
    } catch {
      console.error('[judge] Parse error:', text);
      return fallbackAssessment('Judge parse error');
    }

    return {
      marketRead: String(parsed.market_read || ''),
      scannerAgreement: String(parsed.scanner_agreement || ''),
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
      tier: 'judge',
    };
  } catch (e) {
    console.error('[judge] API error:', (e as Error).message);
    return fallbackAssessment((e as Error).message);
  }
}

function fallbackAssessment(reason: string): Assessment {
  return {
    marketRead: 'Error', scannerAgreement: '', action: 'wait', targetSymbol: null,
    confidence: 0, positionSize: 0, stopLoss: null, takeProfit: null,
    reasoning: `Judge error: ${reason}`, concerns: ['judge error'],
    nextCheckSecs: 30, ts: Date.now(), tier: 'judge',
  };
}

// ---------------------------------------------------------------------------
// Combined: scan → decide if judge is needed → return assessment
// ---------------------------------------------------------------------------

const ESCALATION_THRESHOLD = 0.5; // scanner confidence to escalate to Opus

export async function assess(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
): Promise<{ scannerResults: ScannerResult[]; assessment: Assessment }> {
  // Tier 1: parallel scanners
  const scannerResults = await scan(snap, positions, guard);

  // Check if any scanner flagged a high-confidence setup
  const allSetups = scannerResults.flatMap(sr => sr.setups);
  const hotSetups = allSetups.filter(s => s.confidence >= ESCALATION_THRESHOLD);
  const hasOpenPositions = positions.length > 0;

  // Determine next check from scanners (use the shorter interval)
  const scannerNextCheck = Math.min(...scannerResults.map(sr => sr.nextCheckSecs));

  // Escalate to Opus if: (a) hot setup flagged, or (b) we have open positions to manage
  if (hotSetups.length > 0 || hasOpenPositions) {
    const assessment = await judge(snap, positions, guard, scannerResults);
    return { scannerResults, assessment };
  }

  // No escalation — return scanner-only assessment (no trade action)
  const bestRead = scannerResults.find(sr => sr.marketRead)?.marketRead || 'No data';
  return {
    scannerResults,
    assessment: {
      marketRead: bestRead,
      scannerAgreement: 'N/A (scanners only, no escalation)',
      action: 'wait',
      targetSymbol: null,
      confidence: 0,
      positionSize: 0,
      stopLoss: null,
      takeProfit: null,
      reasoning: `Scanners see ${allSetups.length} setups, none above ${ESCALATION_THRESHOLD} threshold. Watching.`,
      concerns: [],
      nextCheckSecs: scannerNextCheck,
      ts: Date.now(),
      tier: 'scanner',
    },
  };
}
