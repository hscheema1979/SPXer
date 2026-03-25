/**
 * Model Clients — ALL models use Claude Agent SDK (query()).
 *
 * This gives us session JSONL logs for every single model call,
 * enabling full post-market review of what each scanner saw.
 *
 * Scanners (Tier 1):
 *   - Kimi K2.5   → api.kimi.com/coding/
 *   - GLM-5       → api.z.ai/api/anthropic
 *   - MiniMax M2.7 → api.minimax.io/anthropic
 *
 * Judge (Tier 2):
 *   - Claude Opus  → default Anthropic endpoint (Pro subscription)
 *
 * No per-token billing — everything covered by subscriptions.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelConfig {
  id: string;
  label: string;
  model: string;
  env?: Record<string, string>;  // ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY overrides
}

// ---------------------------------------------------------------------------
// Scanner configs (Tier 1) — all via Claude Agent SDK
// ---------------------------------------------------------------------------

export function getScannerConfigs(): ModelConfig[] {
  const configs: ModelConfig[] = [];

  // Kimi K2.5 via Claude Agent SDK
  if (process.env.KIMI_API_KEY) {
    configs.push({
      id: 'kimi',
      label: 'Kimi K2.5',
      model: process.env.KIMI_MODEL || 'kimi-k2',
      env: {
        ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/',
        ANTHROPIC_API_KEY: process.env.KIMI_API_KEY,
      },
    });
  }

  // ZAI GLM-5 via Claude Agent SDK
  if (process.env.GLM_API_KEY) {
    configs.push({
      id: 'glm',
      label: 'ZAI GLM-5',
      model: process.env.GLM_MODEL || 'glm-5',
      env: {
        ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
        ANTHROPIC_API_KEY: process.env.GLM_API_KEY,
      },
    });
  }

  // MiniMax M2.7 via Claude Agent SDK
  if (process.env.MINIMAX_API_KEY) {
    configs.push({
      id: 'minimax',
      label: 'MiniMax M2.7',
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
      env: {
        ANTHROPIC_BASE_URL: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: process.env.MINIMAX_API_KEY,
      },
    });
  }

  // Claude Haiku via Claude Agent SDK (Pro subscription, fast + cheap)
  configs.push({
    id: 'haiku',
    label: 'Claude Haiku',
    model: process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001',
    // No env override — uses default Pro subscription
  });

  if (configs.length === 0) {
    throw new Error('No scanner credentials configured. Set KIMI_API_KEY, GLM_API_KEY, or MINIMAX_API_KEY in .env');
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Judge panel — multiple judges evaluate in parallel, we log all and compare
// ---------------------------------------------------------------------------

export function getJudgeConfigs(): ModelConfig[] {
  const judges: ModelConfig[] = [];

  // Claude Haiku — fast, cheap, acts as a tiebreaker / momentum reader
  judges.push({
    id: 'haiku',
    label: 'Claude Haiku',
    model: process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  });

  // Claude Sonnet — fast, decisive, good at structured output
  judges.push({
    id: 'sonnet',
    label: 'Claude Sonnet',
    model: process.env.SONNET_MODEL || 'claude-sonnet-4-6',
  });

  // Claude Opus — deep reasoning, but can be overly cautious
  judges.push({
    id: 'opus',
    label: 'Claude Opus',
    model: process.env.OPUS_MODEL || 'claude-opus-4-6',
  });

  // Kimi K2.5 as judge — different perspective from its scanner role
  if (process.env.KIMI_API_KEY) {
    judges.push({
      id: 'kimi-judge',
      label: 'Kimi K2.5 (Judge)',
      model: process.env.KIMI_MODEL || 'kimi-k2',
      env: {
        ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/',
        ANTHROPIC_API_KEY: process.env.KIMI_API_KEY,
      },
    });
  }

  // GLM-5 as judge
  if (process.env.GLM_API_KEY) {
    judges.push({
      id: 'glm-judge',
      label: 'ZAI GLM-5 (Judge)',
      model: process.env.GLM_MODEL || 'glm-5',
      env: {
        ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
        ANTHROPIC_API_KEY: process.env.GLM_API_KEY,
      },
    });
  }

  // MiniMax as judge — via Claude Agent SDK like the others
  if (process.env.MINIMAX_API_KEY) {
    judges.push({
      id: 'minimax-judge',
      label: 'MiniMax M2.7 (Judge)',
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
      env: {
        ANTHROPIC_BASE_URL: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: process.env.MINIMAX_API_KEY,
      },
    });
  }

  return judges;
}

/** Get the "active" judge — the one whose decision we actually execute on.
 *  Configurable via AGENT_ACTIVE_JUDGE env var. Default: sonnet */
export function getActiveJudgeId(): string {
  return process.env.AGENT_ACTIVE_JUDGE || 'sonnet';
}

// ---------------------------------------------------------------------------
// Unified query helper — all models go through Claude Agent SDK
// ---------------------------------------------------------------------------

export async function askModel(config: ModelConfig, systemPrompt: string, userPrompt: string, timeoutMs = 45000, forceDirect = false): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // When forced or using third-party models, use direct HTTP (proper cancellation support)
    if (forceDirect || config.env) {
      const result = await askModelDirect(config, systemPrompt, userPrompt, controller.signal);
      clearTimeout(timeoutId);
      return result;
    }

    // For Claude models via SDK, use Agent SDK (limited cancellation support)
    const result = await askModelInner(config, systemPrompt, userPrompt, controller.signal);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`askModel timeout after ${timeoutMs}ms (${config.id})`);
    }
    throw err;
  }
}

async function askModelInner(config: ModelConfig, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
  let result = '';
  let lastAssistantText = '';

  // Embed system prompt into the user prompt to override any default system prompts
  // that the SDK injects (which can confuse third-party models).
  const combinedPrompt = `INSTRUCTIONS:\n${systemPrompt}\n\n---\n\n${userPrompt}`;

  // Check if aborted before starting
  if (signal?.aborted) {
    throw new Error('Aborted before query started');
  }

  for await (const message of query({
    prompt: combinedPrompt,
    options: {
      model: config.model,
      maxTurns: 1,
      allowedTools: [],
      ...(config.env ? { env: config.env } : {}),
    },
  })) {
    // Capture text from assistant messages (works for thinking models like Kimi)
    if (message.type === 'assistant' && (message as any).message?.content) {
      for (const block of (message as any).message.content) {
        if (block.type === 'text' && block.text) {
          lastAssistantText = block.text;
        }
      }
    }
    // Also capture from result (works for standard models)
    if ('result' in message && (message as any).result) {
      result = (message as any).result;
    }
  }

  return result || lastAssistantText;
}

// ---------------------------------------------------------------------------
// Direct HTTP implementation for third-party APIs with proper cancellation
// ---------------------------------------------------------------------------

async function askModelDirect(config: ModelConfig, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
  // Determine base URL and API key
  // Priority: config.env > process.env > defaults
  const baseUrl = config.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const apiKey = config.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(`ANTHROPIC_API_KEY required for ${config.id}`);
  }

  // Check if aborted before starting
  if (signal?.aborted) {
    throw new Error('Aborted before request started');
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json() as { content?: Array<{ text?: string }> };
  return data?.content?.[0]?.text || '';
}
