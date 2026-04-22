/**
 * Basket replay runner — fans out a basket config into N isolated single-strike
 * replays (one per member), then aggregates the results into a basket-level row.
 *
 * Storage layout:
 *   Basket config row:    replay_configs.id = "<basket-id>"                (basket.enabled = true)
 *   Member config rows:   replay_configs.id = "<basket-id>:<member-id>"    (basket.enabled = false, strikeMode='atm-offset', atmOffset set)
 *   Per-member results:   replay_results.configId = "<basket-id>:<member-id>"
 *   Aggregate result:     replay_results.configId = "<basket-id>"
 *
 * This means:
 *   SELECT * FROM replay_results WHERE configId = '<basket-id>'        → basket aggregate
 *   SELECT * FROM replay_results WHERE configId LIKE '<basket-id>:%'   → per-member drill-down
 */

import type { Config, BasketMember } from '../config/types';
import type { ReplayResult, Trade } from './types';
import { ReplayStore } from './store';
import { runReplay, type ReplayOptions } from './machine';
import { mergeConfig } from '../config/defaults';

export interface BasketReplayResult {
  basketConfigId: string;
  date: string;
  memberResults: { member: BasketMember; result: ReplayResult }[];
  aggregate: ReplayResult;
}

/**
 * Derive a single-strike member config from a basket config.
 * - Sets `strikeSelector.strikeMode = 'atm-offset'` and `atmOffset = member.strikeOffset`
 * - Disables `basket` on the derived config (prevents recursion)
 * - Applies `member.overrides` via deep merge (overrides win)
 * - Uses composite ID `<basket-id>:<member-id>`
 */
export function deriveMemberConfig(
  basketConfig: Config,
  member: BasketMember,
): Config {
  const memberId = `${basketConfig.id}:${member.id}`;

  // Start from a shallow clone with basket disabled on the derived config.
  const base: Config = {
    ...basketConfig,
    id: memberId,
    name: `${basketConfig.name} — ${member.id}`,
    baselineId: basketConfig.id,
    basket: { enabled: false, members: [] },
    strikeSelector: {
      ...basketConfig.strikeSelector,
      strikeMode: 'atm-offset',
      atmOffset: member.strikeOffset,
    },
  };

  // Apply per-member overrides via deep merge (overrides take precedence).
  const merged = member.overrides
    ? mergeConfig(base, member.overrides as any)
    : base;

  // Ensure overrides didn't re-enable basket mode or change the member's offset.
  merged.id = memberId;
  merged.basket = { enabled: false, members: [] };
  merged.strikeSelector = {
    ...merged.strikeSelector,
    strikeMode: 'atm-offset',
    atmOffset: member.strikeOffset,
  };
  merged.baselineId = basketConfig.id;

  return merged;
}

/**
 * Compute the basket-level aggregate result from per-member results.
 *
 * Aggregation rules:
 *   trades:              Σ members.trades
 *   wins:                Σ members.wins
 *   winRate:             wins / trades  (weighted naturally by trade count)
 *   totalPnl:            Σ members.totalPnl
 *   avgPnlPerTrade:      totalPnl / trades
 *   maxWin / maxLoss:    max/min across ALL member trades (not max of member maxes)
 *   maxConsecutiveWins:  computed from time-ordered union of member trades
 *   maxConsecutiveLosses: same
 *   sharpeRatio:         recomputed from per-trade P&L series (daily basis)
 *   trades_json:         sorted union of all member trades with member tag
 */
export function aggregateBasketResults(
  basketConfig: Config,
  date: string,
  members: { member: BasketMember; result: ReplayResult }[],
  aggRunId: string,
): ReplayResult {
  // Union all trades with a tag of which member produced them.
  type TaggedTrade = Trade & { _member: string };
  const allTrades: TaggedTrade[] = [];
  for (const { member, result } of members) {
    const trades = result.trades_json ? (JSON.parse(result.trades_json) as Trade[]) : [];
    for (const t of trades) allTrades.push({ ...t, _member: member.id });
  }

  // Sort by entry timestamp for consecutive-streak computation.
  allTrades.sort((a, b) => a.entryTs - b.entryTs);

  const trades = allTrades.length;
  const wins = allTrades.filter(t => t.pnl$ > 0).length;
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl$, 0);
  const maxWin = allTrades.reduce((m, t) => Math.max(m, t.pnl$), 0);
  const maxLoss = allTrades.reduce((m, t) => Math.min(m, t.pnl$), 0);

  // R-multiple aggregation columns
  let sumWinPct = 0, cntWins = 0, sumLossPct = 0, cntLosses = 0;
  for (const t of allTrades) {
    if (t.pnlPct > 0) { sumWinPct += t.pnlPct; cntWins++; }
    else if (t.pnlPct < 0) { sumLossPct += t.pnlPct; cntLosses++; }
  }

  // Consecutive streaks over the merged time-ordered series
  let curWin = 0, curLoss = 0, maxConsWin = 0, maxConsLoss = 0;
  for (const t of allTrades) {
    if (t.pnl$ > 0) {
      curWin++; curLoss = 0;
      if (curWin > maxConsWin) maxConsWin = curWin;
    } else if (t.pnl$ < 0) {
      curLoss++; curWin = 0;
      if (curLoss > maxConsLoss) maxConsLoss = curLoss;
    } else {
      curWin = 0; curLoss = 0;
    }
  }

  // Sharpe on per-trade returns (simple, consistent with single-strike accounting).
  const returns = allTrades.map(t => t.pnl$);
  let sharpe: number | undefined;
  if (returns.length >= 2) {
    const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
    const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? mean / std : 0;
  }

  return {
    runId: aggRunId,
    configId: basketConfig.id,
    date,
    trades,
    wins,
    winRate: trades > 0 ? wins / trades : 0,
    totalPnl,
    avgPnlPerTrade: trades > 0 ? totalPnl / trades : 0,
    maxWin,
    maxLoss,
    maxConsecutiveWins: maxConsWin,
    maxConsecutiveLosses: maxConsLoss,
    sharpeRatio: sharpe,
    sumWinPct,
    cntWins,
    sumLossPct,
    cntLosses,
    trades_json: JSON.stringify(allTrades),
  };
}

/**
 * Run a basket config end-to-end: derive + save each member config, run each
 * member's isolated replay, then aggregate and persist the basket-level result.
 */
export async function runBasketReplay(
  basketConfig: Config,
  targetDate: string,
  opts: ReplayOptions = {},
): Promise<BasketReplayResult> {
  if (!basketConfig.basket?.enabled || !basketConfig.basket.members?.length) {
    throw new Error(`runBasketReplay: config '${basketConfig.id}' is not a basket (basket.enabled must be true and members non-empty)`);
  }

  const verbose = opts.verbose ?? true;
  const store = new ReplayStore(opts.storeDbPath);

  // Ensure basket config itself exists in the store (for aggregate FK).
  // Skip save if already exists to avoid auto-versioning from DEFAULT_CONFIG merge drift.
  if (!store.getConfigRaw(basketConfig.id)) {
    store.saveConfig(basketConfig);
  }

  const memberResults: { member: BasketMember; result: ReplayResult }[] = [];

  for (const member of basketConfig.basket.members) {
    const memberConfig = deriveMemberConfig(basketConfig, member);
    // Save derived config if not already present.
    if (!store.getConfigRaw(memberConfig.id)) {
      store.saveConfig(memberConfig);
    }

    if (verbose) {
      console.log(`\n[basket] ── member: ${member.id} (strikeOffset=${member.strikeOffset >= 0 ? '+' : ''}${member.strikeOffset}) ─────────`);
    }

    const result = await runReplay(memberConfig, targetDate, opts);
    memberResults.push({ member, result });

    if (verbose) {
      console.log(`[basket] ${member.id}: trades=${result.trades} wins=${result.wins} winRate=${(result.winRate * 100).toFixed(1)}% pnl=$${result.totalPnl.toFixed(2)}`);
    }
  }

  // Create a run row for the aggregate so we have an aggRunId with FK integrity.
  const aggRunId = store.createRun(basketConfig.id, targetDate);
  const aggregate = aggregateBasketResults(basketConfig, targetDate, memberResults, aggRunId);
  store.saveResult(aggregate);

  if (verbose) {
    console.log(`\n[basket] ── AGGREGATE: ${basketConfig.id} ─────────`);
    console.log(`[basket] trades=${aggregate.trades} wins=${aggregate.wins} winRate=${(aggregate.winRate * 100).toFixed(1)}% pnl=$${aggregate.totalPnl.toFixed(2)}`);
    console.log(`[basket] maxWin=$${aggregate.maxWin.toFixed(2)} maxLoss=$${aggregate.maxLoss.toFixed(2)} sharpe=${(aggregate.sharpeRatio ?? 0).toFixed(3)}`);
  }

  store.close();

  return {
    basketConfigId: basketConfig.id,
    date: targetDate,
    memberResults,
    aggregate,
  };
}
