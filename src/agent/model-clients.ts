/**
 * Model Clients — hybrid approach:
 *
 * Claude Agent SDK (query()) for Anthropic-compatible endpoints:
 *   - Kimi K2.5 (api.kimi.com/coding/) — Pro subscription via SDK
 *   - GLM-5 (api.z.ai/api/anthropic) — Pro subscription via SDK
 *   - Claude Opus (default Anthropic) — Pro subscription via SDK
 *
 * OpenAI SDK for LiteLLM-only models:
 *   - MiniMax M2.5 (localhost:4010 → Chutes) — OpenAI-compatible
 *
 * No per-token billing — everything covered by subscriptions.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClientType = 'sdk' | 'anthropic-direct' | 'openai';

export interface ModelConfig {
  id: string;
  label: string;
  model: string;
  clientType: ClientType;
  env?: Record<string, string>;       // for SDK (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY)
  anthropic?: Anthropic;              // for direct Anthropic SDK calls
  openai?: OpenAI;                    // for OpenAI-compatible (LiteLLM)
}

// ---------------------------------------------------------------------------
// Scanner configs (Tier 1)
// ---------------------------------------------------------------------------

export function getScannerConfigs(): ModelConfig[] {
  const configs: ModelConfig[] = [];

  // Kimi K2.5 direct via Claude Agent SDK
  if (process.env.KIMI_API_KEY) {
    configs.push({
      id: 'kimi',
      label: 'Kimi K2.5',
      model: 'kimi-k2',
      clientType: 'sdk',
      env: {
        ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/',
        ANTHROPIC_API_KEY: process.env.KIMI_API_KEY,
      },
    });
  }

  // ZAI GLM-5 direct via Anthropic SDK (not Agent SDK — avoids system prompt conflict)
  if (process.env.GLM_API_KEY) {
    configs.push({
      id: 'glm',
      label: 'ZAI GLM-5',
      model: 'glm-5',
      clientType: 'anthropic-direct',
      anthropic: new Anthropic({
        apiKey: process.env.GLM_API_KEY,
        baseURL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
      }),
    });
  }

  // MiniMax M2.5 via LiteLLM (OpenAI-compatible, not Anthropic-compatible)
  if (process.env.LITELLM_KEY) {
    configs.push({
      id: 'minimax',
      label: 'MiniMax M2.5 (Chutes)',
      model: process.env.MINIMAX_MODEL || 'minimaxai-minimax-m2.5-tee',
      clientType: 'openai',
      openai: new OpenAI({
        apiKey: process.env.LITELLM_KEY,
        baseURL: process.env.LITELLM_BASE_URL || 'http://localhost:4010/v1',
      }),
    });
  }

  if (configs.length === 0) {
    throw new Error('No scanner credentials configured. Set KIMI_API_KEY, GLM_API_KEY, or LITELLM_KEY in .env');
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Judge config (Opus via Claude Agent SDK — Pro subscription)
// ---------------------------------------------------------------------------

export function getJudgeConfig(): ModelConfig {
  return {
    id: 'opus',
    label: 'Claude Opus',
    model: process.env.OPUS_MODEL || 'claude-opus-4-6',
    clientType: 'sdk',
    // No env override — uses default Claude Code Pro subscription
  };
}

// ---------------------------------------------------------------------------
// Unified query helper
// ---------------------------------------------------------------------------

async function askViaSDK(config: ModelConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  let result = '';
  let lastAssistantText = '';

  // Embed system prompt into the user prompt to override any default system prompts
  // that the SDK injects (which can confuse third-party models).
  const combinedPrompt = `INSTRUCTIONS:\n${systemPrompt}\n\n---\n\n${userPrompt}`;

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

async function askViaAnthropicDirect(config: ModelConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await config.anthropic!.messages.create({
    model: config.model,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return response.content[0]?.type === 'text' ? response.content[0].text : '';
}

async function askViaOpenAI(config: ModelConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await config.openai!.chat.completions.create({
    model: config.model,
    max_tokens: 800,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });
  return response.choices[0]?.message?.content || '';
}

export async function askModel(config: ModelConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  switch (config.clientType) {
    case 'sdk':              return askViaSDK(config, systemPrompt, userPrompt);
    case 'anthropic-direct': return askViaAnthropicDirect(config, systemPrompt, userPrompt);
    case 'openai':           return askViaOpenAI(config, systemPrompt, userPrompt);
  }
}
