/**
 * Unified Account Monitor — SPX + XSP
 *
 * LLM-powered oversight agent using the Anthropic SDK.
 * Monitors BOTH trading accounts, agent processes, data pipeline, and system health.
 * Does NOT trade — observe and alert only.
 *
 * Architecture:
 *   1. Pre-collect all data via src/monitor/engine.collectPreLLMData()
 *   2. Send snapshot to LLM as a single prompt (no tool round-trips for normal path)
 *   3. LLM returns JSON { severity, assessment }
 *   4. Dedup + log
 *
 * Features:
 *   - Both accounts (SPX margin + XSP cash)
 *   - Market-hours-aware scheduling (30s RTH, 5min pre-market, 30min overnight, off weekends)
 *   - Alert deduplication (no spam)
 *   - Session reset every 120 cycles (prevents context bloat / OOM)
 *   - Pre-collected data pattern (cheaper than LLM tool-calling each cycle)
 *   - Tool-use loop for ad-hoc LLM investigation (remediation tools)
 *
 * Usage:
 *   npx tsx account-monitor.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import {
  getMonitorInterval,
  AlertDedup,
  SessionCycleManager,
  collectPreLLMData,
  logEntry,
  type MonitorTools,
} from './src/monitor/engine';
import { MONITOR_TOOLS } from './src/monitor/tools';
import { SYSTEM_PROMPT, buildCyclePrompt } from './src/monitor/prompts';
import { type Severity } from './src/monitor/types';

// ── Anthropic Client ────────────────────────────────────────────────────────

const MODEL = process.env.MONITOR_MODEL || 'claude-haiku-4-5-20251001';
const client = new Anthropic();

// Convert MONITOR_TOOLS to Anthropic tool format (Typebox produces JSON Schema)
const anthropicTools: Anthropic.Tool[] = MONITOR_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters as Anthropic.Tool.InputSchema,
}));

const toolMap = new Map(MONITOR_TOOLS.map((t) => [t.name, t]));

// ── Tool Adapter ────────────────────────────────────────────────────────────
// Wraps MONITOR_TOOLS execute functions into the MonitorTools interface
// so collectPreLLMData() can call them directly (no LLM in the loop).

function buildToolAdapter(): MonitorTools {
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

// ── Session (message history) ───────────────────────────────────────────────

let messages: Anthropic.MessageParam[] = [];

function resetSession(): void {
  messages = [];
}

/** Send a prompt to the LLM, handle tool-use loops, return final text. */
async function prompt(userPrompt: string): Promise<string> {
  messages.push({ role: 'user', content: userPrompt });

  const MAX_TOOL_ROUNDS = 5;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
      tools: anthropicTools,
    });

    // Add assistant response to history
    messages.push({ role: 'assistant', content: response.content });

    // Extract text and stream to stdout
    for (const block of response.content) {
      if (block.type === 'text') {
        process.stdout.write(block.text);
      }
    }

    // If no tool use, we're done
    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return text;
    }

    // Handle tool calls
    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`\n[tool] ${block.name}`);
          const tool = toolMap.get(block.name);
          if (tool) {
            try {
              const result = await tool.execute('', block.input);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: result.content[0]?.text ?? '',
              });
            } catch (e: any) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${e.message}`,
                is_error: true,
              });
            }
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Unknown tool: ${block.name}`,
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  return '[monitor] Max tool rounds reached';
}

// ── Response Parser ─────────────────────────────────────────────────────────

interface AssessmentResult {
  severity: Severity;
  assessment: string;
  actionsTaken: string[];
}

function parseAssessment(text: string): AssessmentResult {
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

  return { severity: 'info', assessment: text.trim(), actionsTaken: [] };
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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
  logEntry(`Using model: ${MODEL}`, 'info');

  // Core components
  const dedup = new AlertDedup();
  const cycleMgr = new SessionCycleManager(120); // 120 cycles × 30s = 1 hour
  const tools = buildToolAdapter();

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

    // Session compaction — reset context every ~1 hour
    if (cycleMgr.shouldReset()) {
      logEntry(
        `Session compaction at cycle #${cycle} (every 120 cycles / ~1 hour)`,
        'info',
      );
      try {
        // Ask LLM to summarize before we reset
        const compactionPrompt = cycleMgr.buildCompactionPrompt();
        const compactionText = await prompt(compactionPrompt);

        // Store compaction summary in persistent state
        const { loadMonitorState, saveMonitorState } = await import('./src/monitor/state');
        const state = loadMonitorState();
        state.daySummary = compactionText.slice(0, 2000);
        saveMonitorState(state);

        cycleMgr.setLastAssessment(compactionText);
        logEntry('Compaction complete — summary saved to persistent state', 'info');

        // Reset message history
        resetSession();
      } catch (e: any) {
        logEntry(`Session compaction failed: ${e.message} — resetting fresh`, 'alert');
        resetSession();
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
      const cyclePrompt = buildCyclePrompt(mode, cycle, snapshot, carryover);

      // 3. Send to LLM
      const responseText = await prompt(cyclePrompt);

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
        console.log('[monitor] (suppressed duplicate — same condition persists)');
      }

      // 7. Store for carryover on session reset
      cycleMgr.setLastAssessment(assessment);
    } catch (e: any) {
      logEntry(`Cycle #${cycle} error: ${e.message}`, 'alert');

      // On auth/overload errors, reset session
      if (
        e.message?.includes('auth') ||
        e.message?.includes('401') ||
        e.message?.includes('overloaded')
      ) {
        logEntry('Resetting session after error', 'warn');
        resetSession();
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
