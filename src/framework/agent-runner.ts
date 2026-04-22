/**
 * Agent runner skeleton — the generic entry point for a profile-driven agent.
 *
 * PHASE 1 SCOPE: boot validation and banner only. No trading. No order routing.
 * This file exists so future per-symbol agents (spy_agent.ts, tsla_agent.ts, …)
 * can be ~10-line wrappers around `runAgent(profile, config)` instead of each
 * duplicating the shape that spx_agent.ts has today.
 *
 * spx_agent.ts DOES NOT import this. SPX stays on its own entry point until
 * we have enough of the framework proven and ready to migrate. The parity
 * contract across live/replay is unaffected — this is a new code path, not
 * a replacement.
 *
 * Future phases will fill in:
 *   - Data service connection (polling or WS) — vendor routing lives in
 *     src/pipeline/{id}/, not on the profile
 *   - Signal loop via detectSignals() on option contract bars
 *   - Strike selection via profile + config
 *   - Order execution via a broker adapter bound to profile.execution.accountId
 *   - Risk guard, position reconciliation, cooldowns
 *
 * All of that logic already exists in src/core/ and src/agent/ for SPX. The
 * migration is about parameterizing inputs, not rewriting logic.
 */

import type { InstrumentProfile } from '../instruments';
import { canGoLive } from '../instruments';
import type { Config } from '../config/types';

export interface AgentRunnerOptions {
  profile: InstrumentProfile;
  config: Config;
  /**
   * If true, allow boot even when the profile has no accountId. Used for
   * dry-run / data-only harness modes. Default false — live/paper both
   * require an account binding.
   */
  allowNoAccount?: boolean;
  /**
   * Paper mode. When true, no real orders are placed even if accountId is set.
   * Live SPX today uses AGENT_PAPER=false; framework agents follow the same
   * convention. Default inherited from env.AGENT_PAPER !== 'false'.
   */
  paper?: boolean;
}

export interface AgentRunnerHandle {
  /** Stop the agent loop cleanly. Fires any pending OCO cancels, closes streams. */
  stop: () => Promise<void>;
  /** The resolved runtime context the runner is using. */
  context: AgentContext;
}

export interface AgentContext {
  profile: InstrumentProfile;
  config: Config;
  paper: boolean;
  startedAt: Date;
}

/**
 * Validate the (profile, config) pair before boot. Throws with a specific
 * message on any violation — fail loudly at startup rather than mid-session.
 */
export function validateAgentBoot(
  profile: InstrumentProfile,
  config: Config,
  opts: { allowNoAccount?: boolean } = {}
): void {
  if (!profile.id) {
    throw new Error('[agent-runner] Profile has no id');
  }
  if (!profile.execution.underlyingSymbol) {
    throw new Error(`[agent-runner] Profile '${profile.id}' has no underlyingSymbol`);
  }
  if (!profile.options.prefix) {
    throw new Error(`[agent-runner] Profile '${profile.id}' has no options.prefix`);
  }
  if (profile.options.strikeInterval <= 0) {
    throw new Error(
      `[agent-runner] Profile '${profile.id}' has non-positive strikeInterval ${profile.options.strikeInterval}`
    );
  }
  if (!opts.allowNoAccount && !canGoLive(profile)) {
    throw new Error(
      `[agent-runner] Profile '${profile.id}' has no accountId — cannot go live. ` +
        `Pass { allowNoAccount: true } to run data-only / dry harness.`
    );
  }
  if (!config.id) {
    throw new Error('[agent-runner] Config has no id');
  }
}

/**
 * Render the startup banner for an agent. Kept pure (returns string array)
 * so tests can assert content without capturing stdout.
 */
export function formatBootBanner(ctx: AgentContext): string[] {
  const mode = ctx.paper ? 'PAPER' : 'LIVE  ⚠️  REAL MONEY';
  const acct = ctx.profile.execution.accountId ?? '(backtest-only)';
  const lines = [
    '╔══════════════════════════════════════════════════════════╗',
    `║  SPXer Agent Runner — profile: ${ctx.profile.id.padEnd(24)}║`,
    `║  Mode:      ${mode.padEnd(46)}║`,
    `║  Account:   ${acct.padEnd(46)}║`,
    `║  Underlying:${(' ' + ctx.profile.execution.underlyingSymbol).padEnd(46)}║`,
    `║  Options:   ${(ctx.profile.options.prefix + ' @ $' + ctx.profile.options.strikeInterval + ' strikes').padEnd(46)}║`,
    `║  Config:    ${ctx.config.id.padEnd(46)}║`,
    '╚══════════════════════════════════════════════════════════╝',
  ];
  return lines;
}

/**
 * Boot an agent for (profile, config).
 *
 * PHASE 1: validates inputs, prints banner, returns a handle. Does not start
 * any trading loop. This is intentional — the shell exists so consumers can
 * depend on its shape while future phases fill in the trading core.
 *
 * Future phases will return an AgentHandle whose `stop()` tears down a real
 * loop (data poll, signal detect, orders, reconcile). The signature is
 * stable so callers don't change.
 */
export async function runAgent(opts: AgentRunnerOptions): Promise<AgentRunnerHandle> {
  const paper = opts.paper ?? process.env.AGENT_PAPER !== 'false';
  validateAgentBoot(opts.profile, opts.config, { allowNoAccount: opts.allowNoAccount });

  const context: AgentContext = {
    profile: opts.profile,
    config: opts.config,
    paper,
    startedAt: new Date(),
  };

  for (const line of formatBootBanner(context)) {
    console.log(line);
  }

  // Phase 1: no loop started. Future phases insert signal/trade loop here.
  // The stop() below is a no-op until there's something to stop.

  return {
    context,
    async stop() {
      // Placeholder — future phases will flush orders, cancel OCO legs, close streams.
    },
  };
}
