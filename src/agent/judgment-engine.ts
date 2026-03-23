/**
 * JudgmentEngine — two-tier market assessment.
 * Tier 1: direct HTTP scanners (Kimi, GLM, MiniMax) — parallel, no SDK bottleneck
 * Tier 2: Claude Sonnet via SDK — fires only on escalation
 */
import type { MarketSnapshot, ContractState, SpyFlow } from './market-feed';
import type { OpenPosition } from './types';
import type { RiskGuard } from './risk-guard';
import { getJudgeConfigs, getActiveJudgeId, askModel } from './model-clients';
import type { ModelConfig } from './model-clients';
import { classify, getSignalGate, formatRegimeContext, getState as getRegimeState } from './regime-classifier';
import type { RegimeState } from './regime-classifier';
import { MarketNarrative } from './market-narrative';

export interface ScannerHttpConfig {
  id: string;
  label: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export function getHttpScannerConfigs(): ScannerHttpConfig[] {
  const configs: ScannerHttpConfig[] = [];

  if (process.env.KIMI_API_KEY) {
    configs.push({
      id: 'kimi',
      label: 'Kimi K2.5',
      model: process.env.KIMI_MODEL || 'kimi-k2',
      apiKey: process.env.KIMI_API_KEY,
      baseUrl: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/',
      timeoutMs: 15000,
    });
  }

  if (process.env.GLM_API_KEY) {
    configs.push({
      id: 'glm',
      label: 'ZAI GLM-5',
      model: process.env.GLM_MODEL || 'glm-5',
      apiKey: process.env.GLM_API_KEY,
      baseUrl: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
      timeoutMs: 15000,
    });
  }

  if (process.env.MINIMAX_API_KEY) {
    configs.push({
      id: 'minimax',
      label: 'MiniMax M2.7',
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
      apiKey: process.env.MINIMAX_API_KEY,
      baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic',
      timeoutMs: 60000,
    });
  }

  return configs;
}

export async function callHttpLLM(
  config: ScannerHttpConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${config.label} HTTP ${response.status}: ${await response.text()}`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  const text = data.content?.[0]?.text ?? '';

  if (!text) {
    console.warn(`[scanner] ${config.label} returned empty response`, { status: response.status });
    throw new Error(`${config.label} returned empty response`);
  }

  return text;
}

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
- RSI EXTREMES are special: RSI <20 = extreme oversold (high-probability call entry),
  RSI >80 = extreme overbought (high-probability put entry). RSI <15 is an emergency
  signal — scale confidence to 0.7+ and urgency to "now". These are rare and reliable.

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

const JUDGE_SYSTEM = `You are a senior 0DTE SPX options regime advisor.

Your role has changed. You NO LONGER pick strikes, set stops, or size positions.
A deterministic system handles execution. Your job is:

1. VALIDATE the current regime classification (MORNING_MOMENTUM, MEAN_REVERSION,
   TRENDING_UP, TRENDING_DOWN, GAMMA_EXPIRY, NO_TRADE)
2. ASSESS whether the trade thesis is sound given the regime
3. IDENTIFY risks the automated system might miss (gamma walls, news, flow traps)
4. RECOMMEND direction only: bullish, bearish, or wait

Your edge is reading flow AND technicals together:
- SPY put/call ratio, volume flow, and Greeks data tell you WHERE institutions are.
- When flow says "forced buying/selling ahead", that IS the signal.
- 0DTE's biggest moves happen in the LAST 60 minutes. Do NOT flag late-day trades
  as too risky — gamma acceleration is the entire thesis.
- RSI extremes on SPX (<15 or >85) are EMERGENCY signals that override regime gates.
  These are rare and high-probability. Do NOT second-guess them.

CRITICAL: You are an ADVISOR, not the decision-maker. The regime classifier and
deterministic strike selector handle execution. Your "wait" recommendation can
block a trade, but your "buy" does NOT pick the strike. Be honest about what
you see, even if it disagrees with the scanners.

Respond ONLY with valid JSON — no markdown, no text outside the JSON.
{
  "market_read": "<your senior assessment of current conditions>",
  "regime_validation": "<agree/disagree with the regime classification and why>",
  "action": "buy" | "sell_to_close" | "wait",
  "direction": "bullish" | "bearish" | null,
  "confidence": <0.0-1.0>,
  "reasoning": "<why this direction or why waiting>",
  "risks": ["<specific risk the system should know about>"],
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
  direction: 'bullish' | 'bearish' | null;
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

async function runScanner(config: ScannerHttpConfig, prompt: string): Promise<ScannerResult> {
  try {
    const text = await callHttpLLM(config, SCANNER_SYSTEM, prompt);
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
  narratives: Map<string, MarketNarrative>,
): Promise<ScannerResult[]> {
  const basePrompt = buildMarketPrompt(snap, positions, guard);
  const scanners = getHttpScannerConfigs();

  if (scanners.length === 0) return [];

  const results = await Promise.allSettled(
    scanners.map(async (cfg: ScannerHttpConfig) => {
      const narrative = narratives.get(cfg.id);
      const narrativeContext = narrative ? '\n\nYOUR NARRATIVE SO FAR:\n' + narrative.buildTLDR() : '';
      const prompt = basePrompt + narrativeContext;
      const result = await runScanner(cfg, prompt);

      if (narrative) {
        narrative.addScannerNote(result.marketRead);
        const spxPrice = snap.spx.price;
        const latestBar = snap.spx.bars1m[snap.spx.bars1m.length - 1];
        const rsi = latestBar?.rsi14 ?? null;
        const regimeState = getRegimeState();
        const regime = regimeState.regime;
        const eventSummary = result.setups.length > 0
          ? `${result.setups[0].setupType} on ${result.setups[0].symbol} conf=${result.setups[0].confidence.toFixed(2)}`
          : 'no setup';
        narrative.appendEvent(
          Math.floor(Date.now() / 1000),
          snap.timeET,
          spxPrice,
          rsi,
          regime,
          eventSummary,
        );
      }

      return result;
    })
  );

  return results.map((r: PromiseSettledResult<ScannerResult>, i: number) =>
    r.status === 'fulfilled'
      ? r.value
      : { scannerId: scanners[i].id, marketRead: '', setups: [], nextCheckSecs: 30, error: String(r.reason) }
  );
}

// ---------------------------------------------------------------------------
// Tier 2: Judge (Opus via Claude Agent SDK — Pro subscription)
// ---------------------------------------------------------------------------

export interface JudgeResult {
  judgeId: string;
  assessment: Assessment;
  error?: string;
}

async function runSingleJudge(
  config: ModelConfig,
  judgePrompt: string,
): Promise<JudgeResult> {
  try {
    const text = await askModel(config, JUDGE_SYSTEM, judgePrompt);
    const clean = extractJSON(text);

    let parsed: any;
    try {
      parsed = JSON.parse(clean);
    } catch {
      return { judgeId: config.id, assessment: fallbackAssessment(`${config.id} parse error`), error: `Parse: ${text.slice(0, 80)}` };
    }

    return {
      judgeId: config.id,
      assessment: {
        marketRead: String(parsed.market_read || ''),
        scannerAgreement: String(parsed.regime_validation || parsed.scanner_agreement || ''),
        action: ['buy', 'sell_to_close', 'wait'].includes(parsed.action) ? parsed.action : 'wait',
        direction: ['bullish', 'bearish'].includes(parsed.direction) ? parsed.direction : null,
        targetSymbol: parsed.target_symbol || null,
        confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0)),
        positionSize: parsed.position_size ? parseInt(parsed.position_size) : 1,
        stopLoss: parsed.stop_loss ? parseFloat(parsed.stop_loss) : null,
        takeProfit: parsed.take_profit ? parseFloat(parsed.take_profit) : null,
        reasoning: String(parsed.reasoning || ''),
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) :
                  Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        nextCheckSecs: Math.max(15, Math.min(120, parseInt(parsed.next_check_secs) || 30)),
        ts: Date.now(),
        tier: 'judge',
      },
    };
  } catch (e) {
    return { judgeId: config.id, assessment: fallbackAssessment((e as Error).message), error: (e as Error).message };
  }
}

/** Run ALL judges in parallel. Returns all results + the active judge's assessment. */
export async function judge(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
  scannerResults: ScannerResult[],
  escalationBanner: string | null = null,
): Promise<{ allJudges: JudgeResult[]; activeAssessment: Assessment }> {
  const marketPrompt = buildMarketPrompt(snap, positions, guard);

  const scannerBlock = scannerResults.map(sr => {
    const setupLines = sr.setups.length === 0
      ? '    No setups flagged'
      : sr.setups.map(s =>
          `    - ${s.symbol}: ${s.setupType} (conf=${s.confidence.toFixed(2)}, urgency=${s.urgency}) — ${s.notes}`
        ).join('\n');
    return `  ${sr.scannerId.toUpperCase()} says: "${sr.marketRead}"\n${setupLines}`;
  }).join('\n\n');

  const judgePrompt = `${escalationBanner ?? ''}${marketPrompt}

SCANNER ASSESSMENTS:
${scannerBlock}

---
Review the scanner flags alongside the full data. Make the call.`;

  const judgeConfigs = getJudgeConfigs();
  const activeId = getActiveJudgeId();

  // Run ONLY the active judge synchronously for execution speed
  const activeConfig = judgeConfigs.find(c => c.id === activeId) ?? judgeConfigs[0];
  const activeResult = await runSingleJudge(activeConfig, judgePrompt);
  const activeAssessment = activeResult.assessment;

  // Fire remaining judges in background for logging — don't await
  const otherConfigs = judgeConfigs.filter(c => c.id !== activeConfig.id);
  const backgroundPromise = Promise.allSettled(
    otherConfigs.map(cfg => runSingleJudge(cfg, judgePrompt))
  ).then(results => {
    const others: JudgeResult[] = results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { judgeId: otherConfigs[i].id, assessment: fallbackAssessment(String(r.reason)), error: String(r.reason) }
    );
    // Log background judge results for replay analysis
    for (const j of others) {
      console.log(`[judge:bg] ${j.judgeId}: ${j.assessment.action} conf=${j.assessment.confidence.toFixed(2)} → ${j.assessment.targetSymbol ?? 'none'}`);
    }
  }).catch(() => {}); // swallow — background logging only

  // Prevent unhandled rejection warnings
  void backgroundPromise;

  return { allJudges: [activeResult], activeAssessment };
}

function fallbackAssessment(reason: string): Assessment {
  return {
    marketRead: 'Error', scannerAgreement: '', action: 'wait', targetSymbol: null,
    direction: null,
    confidence: 0, positionSize: 0, stopLoss: null, takeProfit: null,
    reasoning: `Judge error: ${reason}`, concerns: ['judge error'],
    nextCheckSecs: 30, ts: Date.now(), tier: 'judge',
  };
}

// ---------------------------------------------------------------------------
// Combined: scan → decide if judge is needed → return assessment
// ---------------------------------------------------------------------------

const ESCALATION_THRESHOLD = 0.5;
// RSI extremes bypass the scanner threshold — direct escalation to judge
const RSI_OVERSOLD_EXTREME = 20;
const RSI_OVERBOUGHT_EXTREME = 80;

export async function assess(
  snap: MarketSnapshot,
  positions: OpenPosition[],
  guard: RiskGuard,
  narratives: Map<string, MarketNarrative>,
): Promise<{ scannerResults: ScannerResult[]; assessment: Assessment; allJudges?: JudgeResult[] }> {
  const scannerResults = await scan(snap, positions, guard, narratives);

  const allSetups = scannerResults.flatMap(sr => sr.setups);
  const hotSetups = allSetups.filter(s => s.confidence >= ESCALATION_THRESHOLD);
  const hasOpenPositions = positions.length > 0;

  // RSI extreme auto-escalation: bypass scanner threshold when SPX RSI is extreme
  const spxRsi = snap.spx.bars1m[snap.spx.bars1m.length - 1]?.rsi14 ?? null;
  const rsiExtreme = spxRsi !== null && (spxRsi < RSI_OVERSOLD_EXTREME || spxRsi > RSI_OVERBOUGHT_EXTREME);
  let rsiEscalationBanner: string | null = null;
  if (rsiExtreme) {
    const direction = spxRsi! < RSI_OVERSOLD_EXTREME ? 'oversold' : 'overbought';
    const severity = spxRsi! < 15 || spxRsi! > 85 ? 'EMERGENCY' : 'EXTREME';
    const action = spxRsi! < RSI_OVERSOLD_EXTREME ? 'BUY CALLS (mean reversion)' : 'BUY PUTS (mean reversion)';
    rsiEscalationBanner = `\n⚡ ESCALATION ALERT: SPX RSI = ${spxRsi!.toFixed(1)} — ${severity} ${direction.toUpperCase()}\nYou are being called specifically because SPX RSI has hit a statistically rare extreme.\nThis is a high-probability mean-reversion signal. Strong bias toward: ${action}.\nDo NOT let normal caution override this signal without a clear counter-thesis.\n`;
    console.log(`[assess] ⚡ RSI ${severity} (${spxRsi!.toFixed(1)}) — ${direction} — escalating to judge with banner`);
  }

  const scannerNextCheck = Math.min(...scannerResults.map(sr => sr.nextCheckSecs));

  if (hotSetups.length > 0 || hasOpenPositions || rsiExtreme) {
    const latestBar = snap.spx.bars1m[snap.spx.bars1m.length - 1];
    const regimeState = latestBar
      ? classify({ close: latestBar.close, high: latestBar.close, low: latestBar.close, ts: Date.now() / 1000 })
      : getRegimeState();
    const regimeContext = formatRegimeContext(regimeState);

    let escalationBanner = rsiExtreme ? rsiEscalationBanner! : null;

    if (!escalationBanner) {
      const escalatingScanner = scannerResults.find(sr => sr.setups.some(s => s.confidence >= ESCALATION_THRESHOLD));
      if (escalatingScanner) {
        const narrative = narratives.get(escalatingScanner.scannerId);
        if (narrative) {
          const hotSetup = escalatingScanner.setups.find(s => s.confidence >= ESCALATION_THRESHOLD)!;
          const brief = narrative.buildEscalationBrief(
            escalatingScanner.marketRead,
            `${hotSetup.urgency} ${hotSetup.setupType} on ${hotSetup.symbol}`,
            hotSetup.confidence,
            buildMarketPrompt(snap, positions, guard),
          );
          escalationBanner = brief;
        }
      }
    }

    const fullBanner = `\n${regimeContext}\n${escalationBanner ?? ''}`;
    const { allJudges, activeAssessment } = await judge(snap, positions, guard, scannerResults, fullBanner);

    // ── REGIME GATE: block trades that conflict with current regime ──
    if (activeAssessment.action === 'buy' && activeAssessment.targetSymbol) {
      const gate = getSignalGate(regimeState.regime, spxRsi);
      const sym = activeAssessment.targetSymbol.toUpperCase();
      const isCallTrade = sym.includes('C0') || sym.match(/C\d{4,}/);
      const isPutTrade = sym.includes('P0') || sym.match(/P\d{4,}/);

      const blocked =
        (isCallTrade && !gate.allowOversoldFade) ||
        (isPutTrade && !gate.allowOverboughtFade);

      if (blocked) {
        console.log(`[assess] 🚫 REGIME GATE BLOCKED: ${regimeState.regime} blocks ${isCallTrade ? 'CALL' : 'PUT'} trade (${activeAssessment.targetSymbol}, conf=${activeAssessment.confidence.toFixed(2)})`);
        const blockedAssessment: Assessment = {
          ...activeAssessment,
          action: 'wait',
          reasoning: `REGIME BLOCKED: ${regimeState.regime} regime does not allow ${isCallTrade ? 'oversold fade (calls)' : 'overbought fade (puts)'}. Original: ${activeAssessment.reasoning}`,
          concerns: [...activeAssessment.concerns, `Blocked by ${regimeState.regime} regime gate`],
        };
        return { scannerResults, assessment: blockedAssessment, allJudges };
      }
    }

    return { scannerResults, assessment: activeAssessment, allJudges };
  }

  const bestRead = scannerResults.find(sr => sr.marketRead)?.marketRead || 'No data';
  return {
    scannerResults,
    assessment: {
      marketRead: bestRead,
      scannerAgreement: 'N/A (scanners only, no escalation)',
      action: 'wait',
      targetSymbol: null,
      direction: null,
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
