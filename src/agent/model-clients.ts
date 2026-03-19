/**
 * Model Clients — multi-model setup for the trading agent.
 *
 * Scanner tier (every 15-30s):
 *   - Kimi K2.5 direct (api.kimi.com/coding/, Anthropic-compatible, ~2.6s)
 *   - GLM-5 direct (api.z.ai/api/anthropic, Anthropic-compatible, ~3s)
 *   - MiniMax M2.5 via LiteLLM → Chutes (OpenAI-compatible, ~6.5s)
 *
 * Judge tier (on-demand):
 *   - Claude Opus via direct Anthropic API
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Types — unified interface for scanners regardless of SDK
// ---------------------------------------------------------------------------

export type ScannerType = 'anthropic' | 'openai';

export interface ScannerClient {
  id: string;
  label: string;
  model: string;
  type: ScannerType;
  anthropic?: Anthropic;
  openai?: OpenAI;
}

export interface JudgeClient {
  id: string;
  label: string;
  model: string;
  client: Anthropic;
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

let _scanners: ScannerClient[] | null = null;

export function getScanners(): ScannerClient[] {
  if (!_scanners) {
    _scanners = [];

    // Kimi K2.5 direct (Anthropic-compatible, fastest)
    if (process.env.KIMI_API_KEY) {
      _scanners.push({
        id: 'kimi',
        label: 'Kimi K2.5 (direct)',
        model: process.env.KIMI_MODEL || 'kimi-k2',
        type: 'anthropic',
        anthropic: new Anthropic({
          apiKey: process.env.KIMI_API_KEY,
          baseURL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/',
        }),
      });
    }

    // GLM-5 direct (Anthropic-compatible)
    if (process.env.GLM_API_KEY) {
      _scanners.push({
        id: 'glm',
        label: 'ZAI GLM-5 (direct)',
        model: process.env.GLM_MODEL || 'glm-5',
        type: 'anthropic',
        anthropic: new Anthropic({
          apiKey: process.env.GLM_API_KEY,
          baseURL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
        }),
      });
    }

    // MiniMax M2.5 via LiteLLM → Chutes (OpenAI-compatible)
    const litellmKey = process.env.LITELLM_KEY;
    if (litellmKey) {
      const litellm = new OpenAI({
        apiKey: litellmKey,
        baseURL: process.env.LITELLM_BASE_URL || 'http://localhost:4010/v1',
      });
      _scanners.push({
        id: 'minimax',
        label: 'MiniMax M2.5 (Chutes)',
        model: process.env.MINIMAX_MODEL || 'minimaxai-minimax-m2.5-tee',
        type: 'openai',
        openai: litellm,
      });
    }

    if (_scanners.length === 0) {
      throw new Error('No scanner credentials configured. Set KIMI_API_KEY, GLM_API_KEY, or LITELLM_KEY in .env');
    }
  }
  return _scanners;
}

// ---------------------------------------------------------------------------
// Judge (Opus via direct Anthropic)
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
