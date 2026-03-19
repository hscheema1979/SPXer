/**
 * Model Clients — multi-model setup for the trading agent.
 *
 * Scanner tier (every 15-30s, cheap via LiteLLM → Chutes):
 *   - Kimi K2.5 (moonshotai-kimi-k2.5-tee)
 *   - GLM-5 (zai-org-glm-5-tee)
 *   Both go through LiteLLM proxy on localhost:4010 (OpenAI-compatible).
 *
 * Judge tier (on-demand, direct Anthropic API):
 *   - Claude Opus
 *
 * ZAI direct (api.z.ai, Anthropic-compatible) available as fallback.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScannerClient {
  id: string;
  label: string;
  model: string;
  client: OpenAI;
}

export interface JudgeClient {
  id: string;
  label: string;
  model: string;
  client: Anthropic;
}

// ---------------------------------------------------------------------------
// LiteLLM proxy (OpenAI-compatible) — for scanners
// ---------------------------------------------------------------------------

const LITELLM_BASE = process.env.LITELLM_BASE_URL || 'http://localhost:4010/v1';
const LITELLM_KEY = process.env.LITELLM_KEY || 'sk-litellm-master-simplepilot';

function litellmClient(): OpenAI {
  return new OpenAI({ apiKey: LITELLM_KEY, baseURL: LITELLM_BASE });
}

let _scanners: ScannerClient[] | null = null;

export function getScanners(): ScannerClient[] {
  if (!_scanners) {
    const shared = litellmClient();
    _scanners = [
      {
        id: 'kimi',
        label: 'Kimi K2.5',
        model: process.env.KIMI_MODEL || 'moonshotai-kimi-k2.5-tee',
        client: shared,
      },
      {
        id: 'glm',
        label: 'ZAI GLM-5',
        model: process.env.GLM_MODEL || 'zai-org-glm-5-tee',
        client: shared,
      },
      {
        id: 'minimax',
        label: 'MiniMax M2.5',
        model: process.env.MINIMAX_MODEL || 'minimaxai-minimax-m2.5-tee',
        client: shared,
      },
    ];
  }
  return _scanners;
}

// ---------------------------------------------------------------------------
// Anthropic direct — for judge (Opus)
// ---------------------------------------------------------------------------

let _opus: JudgeClient | null = null;

export function getJudge(): JudgeClient {
  if (!_opus) {
    _opus = {
      id: 'opus',
      label: 'Claude Opus',
      model: process.env.OPUS_MODEL || 'claude-opus-4-6',
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    };
  }
  return _opus;
}

// ---------------------------------------------------------------------------
// ZAI direct fallback (Anthropic-compatible) — if LiteLLM is down
// ---------------------------------------------------------------------------

let _zaiDirect: JudgeClient | null = null;

export function getZaiDirect(): JudgeClient {
  if (!_zaiDirect) {
    _zaiDirect = {
      id: 'glm-direct',
      label: 'ZAI GLM-5 (direct)',
      model: process.env.GLM_DIRECT_MODEL || 'glm-5',
      client: new Anthropic({
        apiKey: process.env.GLM_API_KEY || '3a0a74b801cb443093af4c044b86e34e.jZlvAnKR9yBbISsM',
        baseURL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
      }),
    };
  }
  return _zaiDirect;
}
