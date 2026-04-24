/**
 * Execution Router - Routes orders to FakeBroker (simulation) or Tradier (production)
 *
 * Three execution modes:
 * - SIMULATION: FakeBroker locally - no broker interaction
 * - PAPER: Tradier paper account (not recommended, often broken)
 * - LIVE: Real orders to Tradier production account
 */

import type { Config } from '../config/types';
import { FakeBroker } from './fake-broker';

export type ExecutionMode = 'SIMULATION' | 'PAPER' | 'LIVE' | 'WARMUP';

// Global execution mode - set via AGENT_EXECUTION_MODE env var
export const EXECUTION_MODE: ExecutionMode = (process.env.AGENT_EXECUTION_MODE || 'LIVE').toUpperCase() as ExecutionMode;

/**
 * Execution result - unified interface across all modes
 */
export interface ExecutionResult {
  orderId: string | null;
  bracketOrderId: string | null;
  tpLegId: string | null;
  slLegId: string | null;
  fillPrice: number | null;
  status: 'SUBMITTED' | 'FILLED' | 'REJECTED';
  simulated?: boolean;  // true if simulated, false/undefined if real
}

/**
 * Execution params for opening a position
 */
export interface OpenPositionParams {
  symbol: string;
  side: 'buy_to_open' | 'sell_to_close';
  quantity: number;
  price: number;
  takeProfit: number;
  stopLoss: number;
}

let fakeBroker: FakeBroker | null = null;

/**
 * Initialize execution system
 */
export function initExecution(): void {
  if (EXECUTION_MODE === 'WARMUP') {
    console.log('[execution] WARMUP MODE - Pre-market signal tracking (NO EXECUTION)');
    console.log('[execution] All signals will be logged but no orders placed');
    console.log('[execution] Switch to LIVE/SIMULATION at 09:30 ET for trading');
  } else if (EXECUTION_MODE === 'SIMULATION') {
    console.log('[execution] INITIALIZING SIMULATION MODE - Orders will be simulated locally');
    fakeBroker = new FakeBroker(100); // 100ms fill delay
    console.log('[execution] FakeBroker ready - orders will NOT be sent to Tradier');
  } else if (EXECUTION_MODE === 'PAPER') {
    console.log('[execution] PAPER MODE - Orders sent to Tradier paper account');
    console.log('[execution] WARNING: Tradier paper account is often broken/unreliable');
  } else {
    console.log('[execution] LIVE MODE - Real orders to Tradier production account');
    console.log('[execution] DANGER: Real money at risk!');
  }
}

/**
 * Get current execution mode
 */
export function getExecutionMode(): ExecutionMode {
  return EXECUTION_MODE;
}

/**
 * Check if running in simulation mode
 */
export function isSimulationMode(): boolean {
  return EXECUTION_MODE === 'SIMULATION';
}

/**
 * Submit OTOCO bracket order
 * Routes to FakeBroker (simulation) or Tradier (paper/live)
 * WARMUP mode: Logs signals but doesn't execute
 */
export async function submitOtocOrder(params: OpenPositionParams, config: Config): Promise<ExecutionResult> {
  const mode = getExecutionMode();

  // WARMUP MODE: Track signals but don't execute
  if (mode === 'WARMUP') {
    console.log(`[execution] WARMUP: Would open ${params.side} ${params.quantity}x ${params.symbol} @ $${params.price.toFixed(2)}`);
    console.log(`[execution]         TP: $${params.takeProfit.toFixed(2)} | SL: $${params.stopLoss.toFixed(2)}`);
    console.log(`[execution]         (Signal tracked - NO EXECUTION in warmup mode)`);

    return {
      orderId: null,
      bracketOrderId: null,
      tpLegId: null,
      slLegId: null,
      fillPrice: params.price,
      status: 'SUBMITTED',
      simulated: true,
    };
  }

  if (mode === 'SIMULATION') {
    // Simulate order locally
    if (!fakeBroker) {
      throw new Error('FakeBroker not initialized');
    }

    console.log(`[execution] SIMULATION: OTOCO ${params.side} ${params.quantity}x ${params.symbol} @ $${params.price.toFixed(2)}`);
    console.log(`[execution]           TP: $${params.takeProfit.toFixed(2)} | SL: $${params.stopLoss.toFixed(2)}`);

    const result = fakeBroker.submitOtocOrder({
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      price: params.price,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
    });

    return {
      orderId: String(result.entryId),
      bracketOrderId: String(result.bracketId),
      tpLegId: String(result.tpLegId),
      slLegId: String(result.slLegId),
      fillPrice: params.price, // Simulated immediate fill at market price
      status: 'SUBMITTED',
      simulated: true,
    };

  } else {
    // PAPER or LIVE - send to Tradier
    console.log(`[execution] ${mode}: Submitting OTOCO to Tradier...`);
    // Call existing trade-executor logic
    // This will eventually call tradierClient methods
    // For now, return placeholder
    return {
      orderId: null,
      bracketOrderId: null,
      tpLegId: null,
      slLegId: null,
      fillPrice: null,
      status: 'SUBMITTED',
      simulated: false,
    };
  }
}

/**
 * Get fake broker instance (for price updates and testing)
 */
export function getFakeBroker(): FakeBroker | null {
  return fakeBroker;
}

/**
 * Get simulation statistics
 */
export function getSimulationStats() {
  if (!fakeBroker) {
    return {
      active: false,
      mode: EXECUTION_MODE,
      ordersSubmitted: 0,
      ordersFilled: 0,
      positions: [],
    };
  }

  return fakeBroker.getStats();
}
