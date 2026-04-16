import 'dotenv/config';

const PROMPT = `You are a senior quantitative trading systems architect specializing in 0DTE SPX options.

We are building an automated 0DTE SPX options trading agent. After a full-day replay of March 19, 2026 that lost $991 (1 winner, 6 losers), and reviewing with 6 AI models, we have consensus on a redesign.

KEY CONSTRAINT: "We're ONLY trading out-of-the-money. The goal is aggressive — not safe. Otherwise we'd be collecting dividends."
- ONLY OTM strikes priced $0.50-$3.00. Risk controlled by position size (1-2 contracts).
- A $1.62 entry that can 20x is the trade. A $5.40 ITM entry is NOT.

WHAT FAILED ON MARCH 19:
- RSI-14 as primary trigger: 7 signals, 6 losers, -$991
- Bug flipped all call entries to puts (parsing error)
- RSI=85.7 at 09:50 → shorted into morning momentum (wrong regime)
- RSI=8.4 at 14:34 → judges picked safe ITM C6585($5.40) instead of OTM C6600($1.62→$33.82=+1,986%)
- RSI=82.2 at 14:57 → entered PUT while calls ran +1,867% (gamma squeeze, wrong regime)
- RSI blind for 14min warmup + 40min pipeline resets

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

interface ModelEndpoint {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function getEndpoints(): ModelEndpoint[] {
  const endpoints: ModelEndpoint[] = [];

  // Anthropic models (direct API, not SDK)
  const anthropicKey = process.env.ANTHROPIC_API_KEY!;
  endpoints.push(
    { id: 'haiku', label: 'Claude Haiku', baseUrl: 'https://api.anthropic.com', apiKey: anthropicKey, model: 'claude-haiku-4-5-20251001' },
    { id: 'sonnet', label: 'Claude Sonnet', baseUrl: 'https://api.anthropic.com', apiKey: anthropicKey, model: 'claude-sonnet-4-6' },
    { id: 'opus', label: 'Claude Opus', baseUrl: 'https://api.anthropic.com', apiKey: anthropicKey, model: 'claude-opus-4-6' },
  );

  // Third-party via their Anthropic-compatible endpoints
  if (process.env.KIMI_API_KEY) {
    endpoints.push({ id: 'kimi', label: 'Kimi K2.5', baseUrl: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/', apiKey: process.env.KIMI_API_KEY, model: process.env.KIMI_MODEL || 'kimi-k2' });
  }
  if (process.env.GLM_API_KEY) {
    endpoints.push({ id: 'glm', label: 'ZAI GLM-5', baseUrl: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic', apiKey: process.env.GLM_API_KEY, model: process.env.GLM_MODEL || 'glm-5' });
  }
  if (process.env.MINIMAX_API_KEY) {
    endpoints.push({ id: 'minimax', label: 'MiniMax M2.7', baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic', apiKey: process.env.MINIMAX_API_KEY, model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7' });
  }

  // Gemini via LiteLLM (OpenAI-compatible)
  endpoints.push({ id: 'gemini', label: 'Gemini 3.1 Pro', baseUrl: 'LITELLM', apiKey: process.env.LITELLM_KEY || 'sk-litellm-master-simplepilot', model: 'gemini-3.1-pro-preview' });

  return endpoints;
}

async function callAnthropic(ep: ModelEndpoint): Promise<string> {
  const url = ep.baseUrl.replace(/\/+$/, '') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ep.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ep.model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: PROMPT }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.[0]?.text || JSON.stringify(data);
}

async function callLiteLLM(ep: ModelEndpoint): Promise<string> {
  const url = (process.env.LITELLM_BASE_URL || 'http://localhost:4010/v1') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ep.apiKey}`,
    },
    body: JSON.stringify({
      model: ep.model,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: 'You are a senior quantitative trading systems architect. Be direct and concise.' },
        { role: 'user', content: PROMPT },
      ],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}

async function callModel(ep: ModelEndpoint): Promise<{ id: string; label: string; response: string; error?: string; elapsed: number }> {
  const start = Date.now();
  try {
    const response = ep.baseUrl === 'LITELLM'
      ? await callLiteLLM(ep)
      : await callAnthropic(ep);
    return { id: ep.id, label: ep.label, response, elapsed: Date.now() - start };
  } catch (e: any) {
    return { id: ep.id, label: ep.label, response: '', error: e.message, elapsed: Date.now() - start };
  }
}

async function main() {
  const endpoints = getEndpoints();
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  EXECUTION PLAN REVIEW — ${endpoints.length} Models in PARALLEL`);
  console.log(`${'═'.repeat(80)}\n`);
  console.log(`  Launching all ${endpoints.length} calls simultaneously...\n`);

  const startAll = Date.now();
  const results = await Promise.all(endpoints.map(callModel));
  const totalElapsed = ((Date.now() - startAll) / 1000).toFixed(1);

  for (const r of results) {
    console.log(`${'─'.repeat(80)}`);
    console.log(`  [${r.label}] (${(r.elapsed / 1000).toFixed(1)}s)`);
    console.log(`${'─'.repeat(80)}`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
    } else {
      console.log(r.response);
    }
    console.log();
  }

  console.log(`${'═'.repeat(80)}`);
  console.log(`  COMPLETE — ${totalElapsed}s total (parallel)`);
  console.log(`${'═'.repeat(80)}\n`);
}

main().catch(console.error);
