/**
 * Position/Order Manager — state machine for the event-driven handler.
 *
 * Owns position lifecycle, persists to data/account.db,
 * receives Tradier account stream events for real-time fill detection.
 */

import type { AccountStream, AccountOrderEvent } from './account-stream';
import { getAccountDb } from '../storage/db';
import { checkEntryGates, computeCloseCutoffTs, type EntryGateInput } from '../core/entry-gate';
import { todayET } from '../utils/et-time';
import type { Config } from '../config/types';
import { randomUUID } from 'crypto';

export interface EnrichedSignal {
  symbol: string;
  strike: number;
  expiry: string;
  side: 'call' | 'put';
  direction: 'bullish' | 'bearish';
  price: number;
  hmaFastPeriod: number;
  hmaSlowPeriod: number;
  channel: string;
  receivedTs: number;
}

export type PositionStatus = 'OPENING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'ORPHANED';

export interface ManagedPosition {
  id: string;
  configId: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  expiry: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  highWater: number;
  status: PositionStatus;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  closePrice: number | null;
  basketMember: string;
  tradierOrderId: number | null;
  bracketOrderId: number | null;
  tpLegId: number | null;
  slLegId: number | null;
}

export type Decision =
  | { action: 'open'; reason: string }
  | { action: 'flip'; position: ManagedPosition; reason: string }
  | { action: 'skip'; reason: string };

export class PositionOrderManager {
  private accountStream: AccountStream;

  constructor(accountStream: AccountStream) {
    this.accountStream = accountStream;
  }

  start(): void {
    this.accountStream.onEvent((event) => this.onOrderEvent(event));
  }

  stop(): void {
    this.accountStream.stop();
  }

  evaluate(signal: EnrichedSignal, configId: string, config: Config): Decision {
    const today = todayET();
    if (signal.expiry !== today) {
      return { action: 'skip', reason: `wrong day: signal.expiry=${signal.expiry}, today=${today}` };
    }

    const positions = this.getOpenPositions(configId);
    const active = positions.filter(p => p.status === 'OPEN' || p.status === 'OPENING' || p.status === 'CLOSING');

    const transitioning = active.filter(p => p.status === 'OPENING' || p.status === 'CLOSING');
    if (transitioning.length > 0) {
      return { action: 'skip', reason: `transition in progress: ${transitioning.length} position(s) in ${transitioning.map(p => p.status).join('/')}` };
    }

    const openPositions = active.filter(p => p.status === 'OPEN');

    const sameDirection = openPositions.find(p => p.side === signal.side);
    if (sameDirection) {
      return { action: 'skip', reason: `same direction: already have ${sameDirection.side} position on ${sameDirection.symbol}` };
    }

    const oppositeDirection = openPositions.find(p => p.side !== signal.side);
    if (oppositeDirection) {
      return { action: 'flip', position: oppositeDirection, reason: `direction reversal: ${oppositeDirection.side} -> ${signal.side}` };
    }

    const maxPositions = config.position.maxPositionsOpen ?? 1;
    if (openPositions.length >= maxPositions) {
      return { action: 'skip', reason: `max positions: ${openPositions.length}/${maxPositions}` };
    }

    const state = this.getConfigState(configId);
    const gateInput: EntryGateInput = {
      ts: signal.receivedTs,
      kind: 'fresh_cross',
      openPositionsAfterExits: openPositions.length,
      tradesCompleted: state.tradesCompleted,
      dailyPnl: state.dailyPnl,
      closeCutoffTs: computeCloseCutoffTs(config),
      lastEntryTs: state.lastEntryTs,
      sessionSignalCount: state.sessionSignalCount,
    };

    const gate = checkEntryGates(gateInput, config);
    if (!gate.allowed) {
      return { action: 'skip', reason: `entry gate: ${(gate as { allowed: false; reason: string }).reason}` };
    }

    return { action: 'open', reason: 'no positions, gates passed' };
  }

  openPosition(signal: EnrichedSignal, configId: string, config: Config, quantity: number, basketMember = 'default'): string {
    const db = getAccountDb();
    const positionId = randomUUID();
    const orderId = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const slPercent = config.position.stopLossPercent / 100;
    const tpMult = config.position.takeProfitMultiplier;
    const stopLoss = +(signal.price * (1 - slPercent)).toFixed(4);
    const takeProfit = +(signal.price * (1 + slPercent * tpMult)).toFixed(4);

    db.prepare(`
      INSERT INTO positions (id, config_id, symbol, side, strike, expiry, entry_price, quantity, stop_loss, take_profit, high_water, status, opened_at, closed_at, close_reason, basket_member, reentry_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPENING', ?, NULL, NULL, ?, 0)
    `).run(
      positionId, configId, signal.symbol, signal.side, signal.strike, signal.expiry,
      signal.price, quantity, stopLoss, takeProfit,
      now, basketMember,
    );

    db.prepare(`
      INSERT INTO orders (id, position_id, side, order_type, status, quantity, submitted_at)
      VALUES (?, ?, 'buy_to_open', 'market', 'PENDING', ?, ?)
    `).run(orderId, positionId, quantity, now);

    const state = this.getConfigState(configId);
    this.setConfigState(configId, {
      lastEntryTs: signal.receivedTs,
      sessionSignalCount: (state.sessionSignalCount || 0) + 1,
    });

    return positionId;
  }

  onOrderEvent(event: AccountOrderEvent): void {
    if (event.status !== 'filled' && event.status !== 'rejected') return;

    const db = getAccountDb();

    const order = db.prepare(
      `SELECT * FROM orders WHERE tradier_id = ? OR bracket_id = ? OR tp_leg_id = ? OR sl_leg_id = ?`
    ).get(event.id, event.id, event.id, event.id) as any;

    if (!order) return;

    if (event.status === 'filled') {
      db.prepare(
        `UPDATE orders SET status = 'FILLED', fill_price = ?, filled_at = ? WHERE id = ?`
      ).run(event.avg_fill_price, Math.floor(Date.now() / 1000), order.id);

      const position = db.prepare(`SELECT * FROM positions WHERE id = ?`).get(order.position_id) as any;
      if (!position) return;

      if (order.side === 'buy_to_open') {
        db.prepare(
          `UPDATE positions SET status = 'OPEN', entry_price = ?, high_water = ? WHERE id = ?`
        ).run(event.avg_fill_price, event.avg_fill_price, position.id);
      } else if (order.side === 'sell_to_close') {
        const isTp = position.take_profit > 0 && event.avg_fill_price >= position.take_profit;
        const reason = isTp ? 'tp' : (position.stop_loss > 0 && event.avg_fill_price <= position.stop_loss ? 'sl' : 'exit');
        db.prepare(
          `UPDATE positions SET status = 'CLOSED', closed_at = ?, close_reason = ?, close_price = ? WHERE id = ?`
        ).run(Math.floor(Date.now() / 1000), reason, event.avg_fill_price, position.id);
      }
    } else if (event.status === 'rejected') {
      db.prepare(
        `UPDATE orders SET status = 'REJECTED', error = ? WHERE id = ?`
      ).run('broker_rejected', order.id);

      const position = db.prepare(`SELECT * FROM positions WHERE id = ? AND status = 'OPENING'`).get(order.position_id) as any;
      if (position) {
        db.prepare(`UPDATE positions SET status = 'CLOSED', closed_at = ?, close_reason = 'rejected' WHERE id = ?`)
          .run(Math.floor(Date.now() / 1000), position.id);
      }
    }
  }

  reconcileFromBroker(configId: string, config: Config, brokerPositions: { symbol: string; side: 'call' | 'put'; strike: number; expiry: string; quantity: number; entryPrice: number }[]): string[] {
    const db = getAccountDb();
    const today = todayET();
    const adopted: string[] = [];

    const dbPositions = db.prepare(
      `SELECT * FROM positions WHERE config_id = ? AND status IN ('OPENING', 'OPEN', 'CLOSING')`
    ).all(configId) as any[];

    const dbSymbols = new Set(dbPositions.map(p => p.symbol));
    const brokerSymbols = new Set(brokerPositions.map(p => p.symbol));

    for (const bp of brokerPositions) {
      if (bp.expiry !== today) continue;
      if (dbSymbols.has(bp.symbol)) continue;

      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const slPercent = config.position.stopLossPercent / 100;
      const tpMult = config.position.takeProfitMultiplier;
      const stopLoss = +(bp.entryPrice * (1 - slPercent)).toFixed(4);
      const takeProfit = +(bp.entryPrice * (1 + slPercent * tpMult)).toFixed(4);

      db.prepare(`
        INSERT INTO positions (id, config_id, symbol, side, strike, expiry, entry_price, quantity, stop_loss, take_profit, high_water, status, opened_at, closed_at, close_reason, basket_member, reentry_depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPENING', ?, NULL, NULL, 'reconciled', 0)
      `).run(
        id, configId, bp.symbol, bp.side, bp.strike, bp.expiry,
        bp.entryPrice, bp.quantity, stopLoss, takeProfit, bp.entryPrice,
        now,
      );

      adopted.push(id);
    }

    for (const dp of dbPositions) {
      if (!brokerSymbols.has(dp.symbol)) {
        db.prepare(`UPDATE positions SET status = 'ORPHANED', closed_at = ?, close_reason = 'broker_missing' WHERE id = ?`)
          .run(Math.floor(Date.now() / 1000), dp.id);
      }
    }

    return adopted;
  }

  getOpenPositions(configId: string): ManagedPosition[] {
    const db = getAccountDb();
    const rows = db.prepare(
      `SELECT * FROM positions WHERE config_id = ? AND status IN ('OPENING', 'OPEN', 'CLOSING') ORDER BY opened_at`
    ).all(configId) as any[];
    return rows.map(rowToPosition);
  }

  getConfigState(configId: string): { dailyPnl: number; tradesCompleted: number; lastEntryTs: number; sessionSignalCount: number } {
    const db = getAccountDb();
    const row = db.prepare(`SELECT * FROM config_state WHERE config_id = ?`).get(configId) as any;
    if (!row) {
      return { dailyPnl: 0, tradesCompleted: 0, lastEntryTs: 0, sessionSignalCount: 0 };
    }
    return {
      dailyPnl: row.daily_pnl,
      tradesCompleted: row.trades_completed,
      lastEntryTs: row.last_entry_ts,
      sessionSignalCount: row.session_signal_count,
    };
  }

  setConfigState(configId: string, state: Partial<{ dailyPnl: number; tradesCompleted: number; lastEntryTs: number; sessionSignalCount: number }>): void {
    const db = getAccountDb();
    const existing = db.prepare(`SELECT config_id FROM config_state WHERE config_id = ?`).get(configId);
    if (existing) {
      const sets: string[] = [];
      const values: any[] = [];
      if (state.dailyPnl !== undefined) { sets.push('daily_pnl = ?'); values.push(state.dailyPnl); }
      if (state.tradesCompleted !== undefined) { sets.push('trades_completed = ?'); values.push(state.tradesCompleted); }
      if (state.lastEntryTs !== undefined) { sets.push('last_entry_ts = ?'); values.push(state.lastEntryTs); }
      if (state.sessionSignalCount !== undefined) { sets.push('session_signal_count = ?'); values.push(state.sessionSignalCount); }
      if (sets.length === 0) return;
      sets.push('updated_at = ?');
      values.push(Math.floor(Date.now() / 1000));
      values.push(configId);
      db.prepare(`UPDATE config_state SET ${sets.join(', ')} WHERE config_id = ?`).run(...values);
    } else {
      db.prepare(
        `INSERT INTO config_state (config_id, daily_pnl, trades_completed, last_entry_ts, session_signal_count) VALUES (?, ?, ?, ?, ?)`
      ).run(
        configId,
        state.dailyPnl ?? 0,
        state.tradesCompleted ?? 0,
        state.lastEntryTs ?? 0,
        state.sessionSignalCount ?? 0,
      );
    }
  }

  insertTestPosition(params: {
    configId: string;
    symbol: string;
    side: 'call' | 'put';
    strike: number;
    status: PositionStatus;
    openedAt?: number;
    closedAt?: number;
  }): void {
    const db = getAccountDb();
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO positions (id, config_id, symbol, side, strike, expiry, entry_price, quantity, stop_loss, take_profit, high_water, status, opened_at, closed_at, close_reason, basket_member, reentry_depth)
      VALUES (?, ?, ?, ?, ?, '2026-04-01', 5.00, 1, 3.75, 6.25, 5.00, ?, ?, ?, NULL, 'default', 0)
    `).run(
      id, params.configId, params.symbol, params.side, params.strike,
      params.status, params.openedAt ?? now, params.closedAt ?? null,
    );
  }


}

function rowToPosition(row: any): ManagedPosition {
  return {
    id: row.id,
    configId: row.config_id,
    symbol: row.symbol,
    side: row.side,
    strike: row.strike,
    expiry: row.expiry,
    entryPrice: row.entry_price,
    quantity: row.quantity,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    highWater: row.high_water,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    closePrice: row.close_price,
    basketMember: row.basket_member,
    tradierOrderId: null,
    bracketOrderId: null,
    tpLegId: null,
    slLegId: null,
  };
}
