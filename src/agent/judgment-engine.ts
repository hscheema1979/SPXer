/**
 * JudgmentEngine — two-tier continuous market assessment via Claude Agent SDK.
 *
 * All model calls go through query() from @anthropic-ai/claude-agent-sdk,
 * using env overrides for third-party providers (Kimi, GLM, MiniMax).
 * Everything runs on Pro subscription — no per-token billing.
 *
 * Tier 1 (Scanner): Kimi K2.5 + GLM-5 + MiniMax M2.5 in parallel
 * Tier 2 (Judge): Claude Opus on escalation only
 */
import type { MarketSnapshot, ContractState, SpyFlow } from './market-feed';
import type { OpenPosition } from './types';
import type { RiskGuard } from './risk-guard';
import { getScannerConfigs, getJudgeConfig, askModel } from './model-clients';
import type { ModelConfig } from './model-clients';

// ---------------------------------------------------------------------------
// System prompts
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

You now have Greeks (delta, gamma, theta, vega, IV) per contract and SPY options flow data:
- Use IV to gauge if options are cheap or expensive relative to recent moves
- High IV + falling price = fear premium, puts may be overpriced
- SPY put/call ratio > 1.2 = bearish sentiment, < 0.8 = bullish
- SPY volume flow shows where institutional money is positioned
- Put skew vs call skew shows directional fear/greed imbalance
- Delta tells you sensitivity to SPX moves — higher delta = more directional exposure
- Theta accelerates into close — factor time decay into entry timing

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

Multiple junior analysts have been scanning the market and flagged potential setups.
You now review their assessments alongside the FULL market data to decide whether to act.

Your edge is reading flow AND technicals together:
- Multi-timeframe alignment (2+ TFs) is ideal but NOT required when macro flow
  provides a clear thesis (e.g., delta unwind into close, gamma squeeze, pin risk).
- SPY put/call ratio, volume flow, and Greeks data tell you WHERE institutions are
  positioned. When flow says "forced buying/selling ahead", that IS the signal —
  don't wait for lagging indicators to confirm what flow already tells you.
- 0DTE's biggest moves happen in the LAST 60 minutes. Do NOT avoid late-day trades.
  Entries with 15-60 minutes left are valid if the thesis is strong.
- Theta accelerates into close — but so do gamma moves. A $2 option can go to $10
  in 20 minutes on a gamma squeeze. Factor both sides.
- When you DO trade, define a clear stop-loss (20-40% of option price).
- Be DECISIVE. If 2+ scanners flag a setup AND flow supports it, ACT. Waiting for
  perfect confirmation on 0DTE means watching the move happen without you.

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

// ---------------------------------------------------------------------------
// Prompt formatting helpers
// ---------------------------------------------------------------------------

function formatBar(b: { close: number; rsi14: number | null; ema9: number | null; ema21: number | null; hma5: number | null } | undefined): string {
  if (!b) return 'n/a';
  return `close=${b.close.toFixed(2)} rsi=${b.rsi14?.toFixed(1) ?? '-'} ema9=${b.ema9?.toFixed(2) ?? '-'} ema21=${b.ema21?.toFixed(2) ?? '-'} hma5=${b.hma5?.toFixed(2) ?? '-'}`;
}

function formatContractBlock(cs: ContractState): string {
  const q = cs.quote;
  const curr1m = cs.bars1m.length > 0 ? cs.bars1m[cs.bars1m.length - 1] : undefined;
  const prev1m = cs.bars1m.length > 1 ? cs.bars1m[cs.bars1m.length - 2] : undefined;
  const curr3m = cs.bars3m.length > 0 ? cs.bars3m[cs.bars3m.length - 1] : undefined;
  const curr5m = cs.bars5m.length > 0 ? cs.bars5m[cs.bars5m.length - 1] : undefined;

  const rsiDir = curr1m?.rsi14 != null && prev1m?.rsi14 != null
    ? (curr1m.rsi14! > prev1m.rsi14! ? '↑' : curr1m.rsi14! < prev1m.rsi14! ? '↓' : '→')
    : '';

  const barsLabel = cs.bars1m.length === 0 ? ' (quote-only, no bars yet)' : '';

  const g = cs.greeks;
  const greeksLine = g.delta != null
    ? `    Greeks: Δ=${g.delta.toFixed(3)} Γ=${g.gamma?.toFixed(4) ?? '-'} Θ=${g.theta?.toFixed(2) ?? '-'} V=${g.vega?.toFixed(2) ?? '-'} IV=${g.iv ? (g.iv * 100).toFixed(1) + '%' : '-'} vol=${g.volume ?? '-'} OI=${g.openInterest ?? '-'}`
    : '    Greeks: unavailable';

  return `  ${cs.meta.symbol} (${cs.meta.side.toUpperCase()} ${cs.meta.strike} ${cs.meta.expiry})${barsLabel}
    Quote: last=$${q.last?.toFixed(2) ?? 'n/a'} bid=$${q.bid?.toFixed(2) ?? 'n/a'} ask=$${q.ask?.toFixed(2) ?? 'n/a'} mid=$${q.mid?.toFixed(2) ?? 'n/a'}${q.changePct !== null ? ` chg=${q.changePct.toFixed(1)}%` : ''}
${greeksLine}
    1m [trend:${cs.trend1m}]: ${formatBar(curr1m)} ${rsiDir}
    3m [trend:${cs.trend3m}]: ${formatBar(curr3m)}
    5m [trend:${cs.trend5m}]: ${formatBar(curr5m)}`;
}

function formatSpyFlow(flow: SpyFlow | null): string {
  if (!flow) return 'SPY FLOW: unavailable';
  const ratio = flow.putCallRatio.toFixed(2);
  const bias = flow.putCallRatio > 1.2 ? 'BEARISH' : flow.putCallRatio < 0.8 ? 'BULLISH' : 'NEUTRAL';
  const skew = flow.putSkewIV != null && flow.callSkewIV != null
    ? `put_IV=${(flow.putSkewIV * 100).toFixed(1)}% call_IV=${(flow.callSkewIV * 100).toFixed(1)}% skew=${((flow.putSkewIV - flow.callSkewIV) * 100).toFixed(1)}%`
    : 'skew=n/a';

  const topPuts = flow.topPutStrikes.map(s => `${s.strike}(${(s.volume / 1000).toFixed(0)}K)`).join(' ');
  const topCalls = flow.topCallStrikes.map(s => `${s.strike}(${(s.volume / 1000).toFixed(0)}K)`).join(' ');

  return `SPY FLOW (sentiment indicator — SPY at $${flow.spyPrice?.toFixed(2) ?? 'n/a'}):
  Volume: ${(flow.totalVolume / 1000000).toFixed(1)}M total | puts=${(flow.putVolume / 1000000).toFixed(1)}M calls=${(flow.callVolume / 1000000).toFixed(1)}M
  P/C ratio: ${ratio} → ${bias}
  ATM IV: ${flow.atmIV ? (flow.atmIV * 100).toFixed(1) + '%' : 'n/a'} | ${skew}
  Top put strikes: ${topPuts}
  Top call strikes: ${topCalls}`;
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
${contractBlock}

${formatSpyFlow(snap.spyFlow)}`;
}

// ---------------------------------------------------------------------------
// Scanner types
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
// Assessment type (from judge)
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
// JSON parser helper
// ---------------------------------------------------------------------------

function extractJSON(text: string): string {
  return text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

// ---------------------------------------------------------------------------
// Tier 1: Scanners via askModel (Claude Agent SDK)
// ---------------------------------------------------------------------------

async function runScanner(config: ModelConfig, prompt: string): Promise<ScannerResult> {
  try {
    const text = await askModel(config, SCANNER_SYSTEM, prompt);
    const clean = extractJSON(text);

    let parsed: any;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return {
        scannerId: config.id,
        marketRead: 'Parse error',
        setups: [],
        nextCheckSecs: 30,
        error: `JSON parse failed: ${text.slice(0, 100)}`,
      };
    }

    return {
      scannerId: config.id,
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
  } catch (e) {
    return {
      scannerId: config.id,
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
  const scanners = getScannerConfigs();

  const results = await Promise.allSettled(
    scanners.map(cfg => runScanner(cfg, prompt))
  );

  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { scannerId: scanners[i].id, marketRead: '', setups: [], nextCheckSecs: 30, error: String(r.reason) }
  );
}

// ---------------------------------------------------------------------------
// Tier 2: Judge (Opus via Claude Agent SDK — Pro subscription)
// ---------------------------------------------------------------------------

export async function judge(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
  scannerResults: ScannerResult[],
): Promise<Assessment> {
  const marketPrompt = buildMarketPrompt(snap, positions, guard);

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

  const opusConfig = getJudgeConfig();

  try {
    const text = await askModel(opusConfig, JUDGE_SYSTEM, judgePrompt);
    const clean = extractJSON(text);

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
    console.error('[judge] Error:', (e as Error).message);
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

const ESCALATION_THRESHOLD = 0.5;

export async function assess(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
): Promise<{ scannerResults: ScannerResult[]; assessment: Assessment }> {
  const scannerResults = await scan(snap, positions, guard);

  const allSetups = scannerResults.flatMap(sr => sr.setups);
  const hotSetups = allSetups.filter(s => s.confidence >= ESCALATION_THRESHOLD);
  const hasOpenPositions = positions.length > 0;

  const scannerNextCheck = Math.min(...scannerResults.map(sr => sr.nextCheckSecs));

  if (hotSetups.length > 0 || hasOpenPositions) {
    const assessment = await judge(snap, positions, guard, scannerResults);
    return { scannerResults, assessment };
  }

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
