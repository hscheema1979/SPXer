/**
 * Model Clients — Uses pi SDK for all Claude models (OAuth from ~/.pi/agent/auth.json).
 *
 * This gives us access to your Anthropic Max subscription without API keys.
 * Third-party models (Kimi, GLM, MiniMax) use direct HTTP with their API keys.
 *
 * Scanners (Tier 1):
 *   - Kimi K2.5   → pi SDK (kimi-coding provider from auth.json)
 *   - GLM-5       → direct HTTP (api.z.ai)
 *   - MiniMax M2.7 → direct HTTP (api.minimax.io)
 *   - Claude Haiku → pi SDK (Anthropic OAuth subscription)
 *
 * Judge (Tier 2):
 *   - Claude Haiku/Sonnet/Opus → pi SDK (Anthropic OAuth subscription)
 *
 * No per-token billing — everything covered by subscriptions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelConfig {
  id: string;
  label: string;
  model: string;
  provider: string;  // pi provider name
  env?: Record<string, string>;  // For third-party direct HTTP
}

// ---------------------------------------------------------------------------
// Scanner configs (Tier 1)
// ---------------------------------------------------------------------------

export function getScannerConfigs(): ModelConfig[] {
  const configs: ModelConfig[] = [];

  // Kimi K2.5 via pi SDK (kimi-coding provider from auth.json)
  if (process.env.KIMI_API_KEY) {
    configs.push({
      id: 'kimi',
      label: 'Kimi K2.5',
      provider: 'kimi-coding',
      model: process.env.KIMI_MODEL || 'kimi-k2',
      env: {
        ANTHROPIC_BASE_URL: process.env.KIMI_BASE_URL || 'https://api.kimi.com/coding/',
        ANTHROPIC_API_KEY: process.env.KIMI_API_KEY,
      },
    });
  }

  // ZAI GLM-5 via direct HTTP
  if (process.env.GLM_API_KEY) {
    configs.push({
      id: 'glm',
      label: 'ZAI GLM-5',
      provider: 'glm',
      model: process.env.GLM_MODEL || 'glm-5',
      env: {
        ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
        ANTHROPIC_API_KEY: process.env.GLM_API_KEY,
      },
    });
  }

  // MiniMax M2.7 via direct HTTP
  if (process.env.MINIMAX_API_KEY) {
    configs.push({
      id: 'minimax',
      label: 'MiniMax M2.7',
      provider: 'minimax',
      model: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',
      env: {
        ANTHROPIC_BASE_URL: process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic',
        ANTHROPIC_API_KEY: process.env.MINIMAX_API_KEY,
      },
    });
  }

  // Claude Haiku via pi SDK (Anthropic OAuth subscription)
  configs.push({
    id: 'haiku',
    label: 'Claude Haiku',
    provider: 'anthropic',
    model: process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  });

  return configs;
}

// ---------------------------------------------------------------------------
// Judge panel — multiple judges evaluate in parallel
// ---------------------------------------------------------------------------

export function getJudgeConfigs(): ModelConfig[] {
  const judges: ModelConfig[] = [];

  // Claude Haiku — fast, cheap, acts as a tiebreaker
  judges.push({
    id: 'haiku',
    label: 'Claude Haiku',
    provider: 'anthropic',
    model: process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001',
  });

  // Claude Sonnet — fast, decisive, good at structured output
  judges.push({
    id: 'sonnet',
    label: 'Claude Sonnet',
    provider: 'anthropic',
    model: process.env.SONNET_MODEL || 'claude-sonnet-4-20250514',
  });

  // Claude Opus — deep reasoning, but can be overly cautious
  judges.push({
    id: 'opus',
    label: 'Claude Opus',
    provider: 'anthropic',
    model: process.env.OPUS_MODEL || 'claude-opus-4-5',
  });

  // Kimi K2.5 as judge
  if (process.env.KIMI_API_KEY) {
    judges.push({
      id: 'kimi-judge',
      label: 'Kimi K2.5 (Judge)',
      provider: 'kimi-coding',
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
      provider: 'glm',
      model: process.env.GLM_MODEL || 'glm-5',
      env: {
        ANTHROPIC_BASE_URL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
        ANTHROPIC_API_KEY: process.env.GLM_API_KEY,
      },
    });
  }

  // MiniMax as judge
  if (process.env.MINIMAX_API_KEY) {
    judges.push({
      id: 'minimax-judge',
      label: 'MiniMax M2.7 (Judge)',
      provider: 'minimax',
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
// Unified query helper
// ---------------------------------------------------------------------------

// Lazy-loaded pi SDK (ESM module loaded dynamically)
let _piSdk: {
  AuthStorage: typeof import('@mariozechner/pi-coding-agent').AuthStorage;
  ModelRegistry: typeof import('@mariozechner/pi-coding-agent').ModelRegistry;
  SessionManager: typeof import('@mariozechner/pi-coding-agent').SessionManager;
  SettingsManager: typeof import('@mariozechner/pi-coding-agent').SettingsManager;
  createAgentSession: typeof import('@mariozechner/pi-coding-agent').createAgentSession;
  createExtensionRuntime: typeof import('@mariozechner/pi-coding-agent').createExtensionRuntime;
} | null = null;

let _authStorage: InstanceType<typeof import('@mariozechner/pi-coding-agent').AuthStorage> | null = null;
let _modelRegistry: InstanceType<typeof import('@mariozechner/pi-coding-agent').ModelRegistry> | null = null;

async function loadPiSdk() {
  if (!_piSdk) {
    _piSdk = await import('@mariozechner/pi-coding-agent');
  }
  return _piSdk;
}

async function getAuthStorage() {
  if (!_authStorage) {
    const { AuthStorage } = await loadPiSdk();
    _authStorage = AuthStorage.create();  // Uses ~/.pi/agent/auth.json
  }
  return _authStorage;
}

async function getModelRegistry() {
  if (!_modelRegistry) {
    const { ModelRegistry } = await loadPiSdk();
    _modelRegistry = new ModelRegistry(await getAuthStorage());
  }
  return _modelRegistry;
}

export async function askModel(config: ModelConfig, systemPrompt: string, userPrompt: string, timeoutMs = 60000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Third-party models with env config use direct HTTP
    if (config.env && config.provider !== 'anthropic') {
      const result = await askModelDirect(config, systemPrompt, userPrompt, controller.signal);
      clearTimeout(timeoutId);
      return result;
    }

    // Claude models use pi SDK with OAuth
    const result = await askModelViaPiSdk(config, systemPrompt, userPrompt, controller.signal);
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

// ---------------------------------------------------------------------------
// pi SDK implementation for Claude models (OAuth subscription)
// ---------------------------------------------------------------------------

async function askModelViaPiSdk(config: ModelConfig, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
  // Check if aborted before starting
  if (signal?.aborted) {
    throw new Error('Aborted before query started');
  }

  const { createAgentSession, SessionManager, SettingsManager, createExtensionRuntime } = await loadPiSdk();
  const authStorage = await getAuthStorage();
  const modelRegistry = await getModelRegistry();

  // Get the model from pi's model registry
  const model = modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new Error(`Model not found: ${config.provider}/${config.model}`);
  }

  // Minimal resource loader for pi SDK (no tools, no extensions)
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  // In-memory settings (no compaction, no retry)
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  // Create the session
  const { session } = await createAgentSession({
    model,
    thinkingLevel: 'off',
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [],  // No tools for scanner/judge calls
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  // Collect the response
  let result = '';
  
  return new Promise((resolve, reject) => {
    const abortHandler = () => {
      session.dispose();
      reject(new Error('Aborted during query'));
    };
    signal?.addEventListener('abort', abortHandler);

    session.subscribe((event: any) => {
      if (signal?.aborted) return;

      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        result += event.assistantMessageEvent.delta;
      }

      if (event.type === 'agent_end') {
        signal?.removeEventListener('abort', abortHandler);
        session.dispose();
        resolve(result);
      }
    });

    session.prompt(userPrompt).catch((err: Error) => {
      signal?.removeEventListener('abort', abortHandler);
      session.dispose();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Direct HTTP implementation for third-party APIs
// ---------------------------------------------------------------------------

async function askModelDirect(config: ModelConfig, systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
  const baseUrl = config.env?.ANTHROPIC_BASE_URL;
  const apiKey = config.env?.ANTHROPIC_API_KEY;

  if (!apiKey || !baseUrl) {
    throw new Error(`API key and base URL required for ${config.id}`);
  }

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

  const data = await response.json() as { 
    content?: Array<{ 
      type?: string;
      text?: string;
      thinking?: string;
    }> 
  };

  // MiniMax returns thinking block first, then text block - find the text block
  const textBlock = data?.content?.find(b => b.type === 'text' && b.text);
  if (textBlock?.text) {
    return textBlock.text;
  }

  // Fallback: first block with text field (works for standard Anthropic format)
  return data?.content?.[0]?.text || '';
}
