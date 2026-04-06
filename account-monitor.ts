/**
 * Unified Account Monitor — SPX + XSP
 *
 * LLM-powered oversight agent using the Pi SDK.
 * Monitors BOTH trading accounts, agent processes, data pipeline, and system health.
 * Does NOT trade — observe and alert only.
 *
 * Architecture:
 *   1. Pre-collect all data via src/monitor/engine.collectPreLLMData()
 *   2. Send snapshot to LLM as a single prompt (no tool round-trips for normal path)
 *   3. LLM returns JSON { severity, assessment }
 *   4. Dedup + log
 *
 * Features vs old agent-xsp-monitor.ts:
 *   - Both accounts (SPX margin + XSP cash)
 *   - Market-hours-aware scheduling (30s RTH, 5min pre-market, 30min overnight, off weekends)
 *   - Alert deduplication (no spam)
 *   - Session reset every 20 cycles (prevents context bloat / OOM)
 *   - Pre-collected data pattern (cheaper than LLM tool-calling each cycle)
 *
 * Usage:
 *   npx tsx account-monitor.ts
 *
 * Replaces: agent-xsp-monitor.ts
 * Brief: docs/account-monitor-design.md
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import {
  getMonitorInterval,
  AlertDedup,
  SessionCycleManager,
  collectPreLLMData,
  logEntry,
  type MonitorMode,
  type MonitorTools,
} from './src/monitor/engine';
import { MONITOR_TOOLS } from './src/monitor/tools';
import { SYSTEM_PROMPT, buildCyclePrompt } from './src/monitor/prompts';
import { MONITOR_LOG_FILE, type Severity } from './src/monitor/types';

// ── Pi SDK Dynamic Imports ──────────────────────────────────────────────────
// Dynamic import to bypass ESM exports resolution in CJS tsx environment

let AuthStorage: any,
  createAgentSession: any,
  createExtensionRuntime: any;
let createReadTool: any, createBashTool: any;
let ModelRegistry: any, SessionManager: any, SettingsManager: any;

async function loadPiAgent() {
  const piAgent = await import(
    '/home/ubuntu/SPXer/node_modules/@mariozechner/pi-coding-agent/dist/index.js'
  );
  AuthStorage = piAgent.AuthStorage;
  createAgentSession = piAgent.createAgentSession;
  createExtensionRuntime = piAgent.createExtensionRuntime;
  createReadTool = piAgent.createReadTool;
  createBashTool = piAgent.createBashTool;
  ModelRegistry = piAgent.ModelRegistry;
  SessionManager = piAgent.SessionManager;
  SettingsManager = piAgent.SettingsManager;
}

// ── Tool Adapter ────────────────────────────────────────────────────────────
// Wraps MONITOR_TOOLS execute functions into the MonitorTools interface
// so collectPreLLMData() can call them directly (no LLM in the loop).

function buildToolAdapter(): MonitorTools {
  const toolMap = new Map(MONITOR_TOOLS.map((t) => [t.name, t]));

  const call = async (name: string, params: any = {}): Promise<string> => {
    const tool = toolMap.get(name);
    if (!tool) return `Tool ${name} not found`;
    try {
      const result = await tool.execute('', params);
      return result.content[0]?.text ?? '';
    } catch (e: any) {
      return `Error calling ${name}: ${e.message}`;
    }
  };

  return {
    getPositions: (account) => call('get_positions', { account }),
    getOrders: (account, statusFilter) =>
      call('get_orders', { account, status_filter: statusFilter }),
    getBalance: (account) => call('get_balance', { account }),
    getMarketSnapshot: () => call('get_market_snapshot'),
    getAgentStatus: (agent) => call('get_agent_status', { agent }),
    checkSystemHealth: () => call('check_system_health'),
  };
}

// ── Session Management ──────────────────────────────────────────────────────

const CWD = process.cwd();

let session: any = null;
let responseAccumulator = '';

async function createSession(
  authStorage: any,
  modelRegistry: any,
  model: any,
  settingsManager: any,
): Promise<void> {
  const resourceLoader = {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const result = await createAgentSession({
    cwd: CWD,
    model,
    thinkingLevel: 'low',
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [createReadTool(CWD), createBashTool(CWD)],
    customTools: MONITOR_TOOLS, // Available for ad-hoc LLM investigation
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  session = result.session;

  // Stream output + accumulate response text
  session.subscribe((event: any) => {
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta'
    ) {
      const delta = event.assistantMessageEvent.delta;
      process.stdout.write(delta);
      responseAccumulator += delta;
    }
    if (event.type === 'tool_execution_start') {
      console.log(`\n[tool] ${event.toolName}`);
    }
  });
}

// ── Response Parser ─────────────────────────────────────────────────────────

interface AssessmentResult {
  severity: Severity;
  assessment: string;
  actionsTaken: string[];
}

function parseAssessment(text: string): AssessmentResult {
  // Try to extract JSON { severity, assessment, actions_taken } from the response
  try {
    const jsonMatch = text.match(
      /\{[\s\S]*"severity"[\s\S]*"assessment"[\s\S]*\}/,
    );
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const severity = ['info', 'warn', 'alert'].includes(parsed.severity)
        ? (parsed.severity as Severity)
        : 'info';
      const actionsTaken = Array.isArray(parsed.actions_taken) ? parsed.actions_taken : [];
      return { severity, assessment: parsed.assessment || text, actionsTaken };
    }
  } catch {
    // JSON parsing failed — fall through
  }

  // Fallback: use the full text as assessment
  return { severity: 'info', assessment: text.trim(), actionsTaken: [] };
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadPiAgent();

  console.log(
    '\n╔══════════════════════════════════════════════════════════════╗',
  );
  console.log(
    '║   Unified Account Monitor                                    ║',
  );
  console.log(
    '║   SPX (6YA51425) + XSP (6YA58635) | Both Accounts           ║',
  );
  console.log(
    '╚══════════════════════════════════════════════════════════════╝\n',
  );

  fs.mkdirSync('logs', { recursive: true });
  logEntry('Monitor starting — unified account monitor (SPX + XSP)', 'info');

  // Pi SDK setup
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // Use Haiku 4.5 — fast, cheap, good at structured output
  const model = modelRegistry.find('anthropic', 'claude-haiku-4-5');
  if (!model) {
    console.error('[monitor] Model not found. Available:');
    const available = await modelRegistry.getAvailable();
    available.forEach((m: any) =>
      console.error(`  ${m.provider}/${m.id}`),
    );
    process.exit(1);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  // Core components
  const dedup = new AlertDedup();
  const cycleMgr = new SessionCycleManager(120); // 120 cycles × 30s = 1 hour
  const tools = buildToolAdapter();

  // Create initial session
  await createSession(authStorage, modelRegistry, model, settingsManager);
  logEntry('Agent session created successfully', 'info');

  // Main monitoring loop
  while (true) {
    const { intervalMs, mode } = getMonitorInterval();

    // Skip if market closed (weekends/holidays)
    if (mode === 'closed' || intervalMs === 0) {
      console.log('[monitor] Market closed — sleeping 30 minutes');
      await sleep(30 * 60 * 1000);
      continue;
    }

    const cycle = cycleMgr.tick();

    // Session compaction — compact context every ~1 hour instead of nuking it
    if (cycleMgr.shouldReset()) {
      logEntry(
        `Session compaction at cycle #${cycle} (every ${120} cycles / ~1 hour)`,
        'info',
      );
      try {
        // Ask LLM to summarize before we reset
        const compactionPrompt = cycleMgr.buildCompactionPrompt();
        responseAccumulator = '';
        await session.prompt(compactionPrompt);
        const compactionText = responseAccumulator;
        
        // Store compaction summary in persistent state
        const { loadMonitorState, saveMonitorState } = await import('./src/monitor/state');
        const state = loadMonitorState();
        state.daySummary = compactionText.slice(0, 2000); // cap at 2k chars
        saveMonitorState(state);
        
        cycleMgr.setLastAssessment(compactionText);
        logEntry(`Compaction complete — summary saved to persistent state`, 'info');

        // Now recreate session with compacted context
        await createSession(
          authStorage,
          modelRegistry,
          model,
          settingsManager,
        );
      } catch (e: any) {
        logEntry(`Session compaction failed: ${e.message} — recreating fresh`, 'alert');
        try {
          await createSession(
            authStorage,
            modelRegistry,
            model,
            settingsManager,
          );
        } catch {
          // Will retry next cycle
        }
      }
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(
      `[monitor] Cycle #${cycle} | Mode: ${mode.toUpperCase()} | Next check in ${Math.round(intervalMs / 1000)}s`,
    );

    try {
      // 1. Pre-collect all data (calls tools directly, no LLM)
      const snapshot = await collectPreLLMData(mode, cycle, tools);

      // 2. Build prompt with snapshot + optional carryover
      const carryover = cycleMgr.shouldReset()
        ? cycleMgr.buildCarryoverSummary()
        : undefined;
      const prompt = buildCyclePrompt(mode, cycle, snapshot, carryover);

      // 3. Send to LLM — reset accumulator, prompt, read result
      responseAccumulator = '';
      await session.prompt(prompt);
      const responseText = responseAccumulator;

      // 4. Parse structured response
      const { severity, assessment, actionsTaken } = parseAssessment(responseText);

      // 5. Log actions taken (always, never dedup)
      if (actionsTaken.length > 0) {
        for (const action of actionsTaken) {
          logEntry(`ACTION: ${action}`, severity);
        }
      }

      // 6. Dedup check before logging assessment
      const dedupResult = dedup.shouldLog(assessment, severity);
      if (dedupResult.log) {
        const logMsg = dedupResult.summary || assessment;
        logEntry(logMsg, severity);
      } else {
        console.log(`[monitor] (suppressed duplicate — same condition persists)`);
      }

      // 7. Store for carryover on session reset
      cycleMgr.setLastAssessment(assessment);
    } catch (e: any) {
      logEntry(`Cycle #${cycle} error: ${e.message}`, 'alert');

      // On auth/session errors, try recreating
      if (
        e.message?.includes('auth') ||
        e.message?.includes('session') ||
        e.message?.includes('401') ||
        e.message?.includes('overloaded')
      ) {
        logEntry('Attempting session recreation after error', 'warn');
        try {
          await createSession(
            authStorage,
            modelRegistry,
            model,
            settingsManager,
          );
        } catch {
          // Will retry next cycle
        }
      }
    }

    console.log('\n');
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  logEntry('Shutting down (SIGTERM)', 'info');
  process.exit(0);
});
process.on('SIGINT', () => {
  logEntry('Shutting down (SIGINT)', 'info');
  process.exit(0);
});

main().catch((e) => {
  console.error('[monitor] Fatal:', e);
  process.exit(1);
});
