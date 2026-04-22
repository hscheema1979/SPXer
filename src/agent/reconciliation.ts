/**
 * Position Reconciliation — compares agent state with broker reality.
 *
 * Extracted from spx_agent.ts for reuse and testability.
 * Runs every cycle during trading hours to:
 *   1. Adopt orphaned positions from broker (agent restarted)
 *   2. Drop phantom positions from agent (closed externally)
 *   3. Log mismatches
 *
 * All operations are real: HTTP calls to Tradier API, filesystem state.
 */
import axios from 'axios';
import { randomUUID } from 'crypto';
import { config as appConfig, TRADIER_BASE } from '../config';
import type { OpenPosition } from './types';
import type { CorePosition } from '../core/strategy-engine';
import type { Config } from '../config/types';

export interface ReconcileResult {
  matched: string[];
  adopted: OpenPosition[];
  dropped: string[];
  errors: string[];
}

/**
 * Parse an option symbol into components.
 * Format: SPXW260407C06610000 → { prefix, date, side, strike }
 */
export function parseOptionSymbol(symbol: string): {
  prefix: string;
  dateStr: string;
  callPut: 'C' | 'P';
  strike: number;
  expiry: string;
  side: 'call' | 'put';
} | null {
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const [, prefix, dateStr, callPut, strikeStr] = match;
  return {
    prefix,
    dateStr,
    callPut: callPut as 'C' | 'P',
    strike: parseInt(strikeStr) / 1000,
    expiry: `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`,
    side: callPut === 'C' ? 'call' : 'put',
  };
}

/**
 * Reconcile agent positions with broker positions.
 * 
 * @param agentPositions - Current agent positions
 * @param accountId - Tradier account ID
 * @param config - Trading config (for SL/TP calculation on adopted positions)
 * @returns Reconciliation result with matched, adopted, dropped
 */
export async function reconcileWithBroker(
  agentPositions: OpenPosition[],
  accountId: string,
  config: Config,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    matched: [],
    adopted: [],
    dropped: [],
    errors: [],
  };

  const hdrs = {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };

  let brokerPositions: any[] = [];
  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/positions`,
      { headers: hdrs, timeout: 10_000 },
    );
    const raw = data?.positions?.position;
    brokerPositions = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  } catch (e: any) {
    result.errors.push(`Failed to fetch broker positions: ${e.message}`);
    return result;
  }

  const brokerSymbols = new Set(brokerPositions.map((p: any) => p.symbol));
  const agentSymbols = new Set(agentPositions.map(p => p.symbol));

  // Matched positions
  for (const pos of agentPositions) {
    if (brokerSymbols.has(pos.symbol)) {
      result.matched.push(pos.symbol);
    }
  }

  // Orphaned at broker — adopt
  for (const bp of brokerPositions) {
    if (!agentSymbols.has(bp.symbol)) {
      const quantity = Math.abs(bp.quantity);
      const costBasis = Math.abs(bp.cost_basis);
      const entryPrice = quantity > 0 ? costBasis / (quantity * 100) : 0;

      const parsed = parseOptionSymbol(bp.symbol);
      if (!parsed) {
        result.errors.push(`Unrecognized symbol: ${bp.symbol}`);
        continue;
      }

      const stopLoss = entryPrice * (1 - config.position.stopLossPercent / 100);
      const takeProfit = entryPrice * config.position.takeProfitMultiplier;

      const openPos: OpenPosition = {
        id: randomUUID(),
        symbol: bp.symbol,
        side: parsed.side as any,
        strike: parsed.strike,
        expiry: parsed.expiry,
        entryPrice,
        quantity,
        stopLoss,
        takeProfit,
        openedAt: bp.date_acquired ? new Date(bp.date_acquired).getTime() : Date.now(),
      };
      result.adopted.push(openPos);
    }
  }

  // Phantom in agent — drop
  for (const pos of agentPositions) {
    if (!brokerSymbols.has(pos.symbol)) {
      result.dropped.push(pos.symbol);
    }
  }

  return result;
}

/**
 * Create a CorePosition from an OpenPosition (for strategy state).
 */
export function openToCorePosition(pos: OpenPosition): CorePosition {
  return {
    id: pos.symbol,
    symbol: pos.symbol,
    side: pos.side as any,
    strike: pos.strike,
    qty: pos.quantity,
    entryPrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    // Adopted orphans may lack a TP leg. Use Infinity so the TP check never fires;
    // the agent will re-submit OCO protection on the next reconcile cycle.
    takeProfit: pos.takeProfit ?? Number.POSITIVE_INFINITY,
    entryTs: Math.floor(pos.openedAt / 1000),
    highWaterPrice: pos.entryPrice,
  };
}
