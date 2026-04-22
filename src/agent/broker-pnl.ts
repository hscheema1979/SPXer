/**
 * Broker P&L — fetches daily realized P&L from Tradier.
 *
 * The broker is the source of truth for P&L, not the agent's internal tracking.
 * This replaces the old computeBrokerDailyPnl() that reconstructed P&L from
 * agent-guessed entry prices (got it $21K wrong on Apr 20).
 *
 * Strategy (ordered by same-day reliability for 0DTE options):
 *   1. Primary: /accounts/{id}/orders — today's filled orders with broker avg_fill_price.
 *      Groups buy_to_open and sell_to_close per option_symbol, computes round-trip P&L.
 *      Available in real-time — works for 0DTE same-day. Includes bracket TP/SL fills.
 *   2. Fallback: /accounts/{id}/gainloss — broker-computed gain_loss per closed position.
 *      Has T+1 settlement lag for 0DTE options — often returns nothing same-day.
 *      But when it does have today's data (e.g. after settlement), it's the most accurate.
 *
 * The old "history" endpoint approach was removed — it also has settlement lag for 0DTE
 * and was returning empty same-day, causing $0 P&L all session on Apr 21.
 *
 * Cached for 30s to avoid hammering the API on every cycle.
 */
import axios from 'axios';
import { config as appConfig, TRADIER_BASE } from '../config';
import { todayET } from '../utils/et-time';

export interface BrokerPnl {
  pnl: number;
  trades: number;
  wins: number;
  fetchedAt: number;
  source: 'orders' | 'gainloss' | 'empty';
}

const cache = new Map<string, BrokerPnl>();
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

function headers() {
  return {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };
}

/**
 * Compute realized P&L from the orders endpoint (filled orders with broker fill prices).
 *
 * This is the only Tradier endpoint that reliably returns same-day 0DTE fill data.
 * We match buy_to_open and sell_to_close legs per option_symbol using avg_fill_price
 * (the broker's actual execution price, not agent-estimated).
 *
 * Handles both:
 * - Single orders (market/limit buy, market sell)
 * - OTOCO bracket orders (entry leg + TP limit + SL stop in legs[])
 * - Broker-initiated fills (bracket TP/SL hit without agent involvement)
 */
async function fetchFromOrders(acctId: string, today: string): Promise<BrokerPnl | null> {
  const { data } = await axios.get(
    `${TRADIER_BASE}/accounts/${acctId}/orders`,
    { headers: headers(), timeout: 10000 },
  );

  const rawOrders = data?.orders?.order;
  if (!rawOrders || rawOrders === 'null') return null;

  const allOrders = Array.isArray(rawOrders) ? rawOrders : [rawOrders];

  // Filter to today's orders only
  const todayOrders = allOrders.filter((o: any) => {
    const created = o.create_date || o.transaction_date || '';
    return created.startsWith(today);
  });

  if (todayOrders.length === 0) return null;

  // Collect all filled legs (both top-level and nested in multi-leg orders)
  interface FilledLeg {
    optionSymbol: string;
    side: string;         // 'buy_to_open' | 'sell_to_close' | etc.
    qty: number;
    avgFillPrice: number;
  }
  const filledLegs: FilledLeg[] = [];

  for (const order of todayOrders) {
    // Check for nested legs (OTOCO, multileg)
    const legs = order.leg ? (Array.isArray(order.leg) ? order.leg : [order.leg]) : null;

    if (legs && legs.length > 0) {
      for (const leg of legs) {
        if (leg.status !== 'filled') continue;
        const sym = leg.option_symbol || leg.symbol;
        if (!sym) continue;
        filledLegs.push({
          optionSymbol: sym,
          side: leg.side || '',
          qty: Number(leg.quantity) || 0,
          avgFillPrice: Number(leg.avg_fill_price) || 0,
        });
      }
    } else {
      // Single order
      if (order.status !== 'filled') continue;
      const sym = order.option_symbol || order.symbol;
      if (!sym) continue;
      filledLegs.push({
        optionSymbol: sym,
        side: order.side || '',
        qty: Number(order.quantity) || 0,
        avgFillPrice: Number(order.avg_fill_price) || 0,
      });
    }
  }

  if (filledLegs.length === 0) return null;

  // Group by option symbol: accumulate buy cost and sell proceeds
  const bySymbol = new Map<string, {
    buyCost: number;   // total $ spent buying (price * qty * 100)
    buyQty: number;    // total contracts bought
    sellProceeds: number; // total $ received selling
    sellQty: number;   // total contracts sold
  }>();

  for (const leg of filledLegs) {
    if (!bySymbol.has(leg.optionSymbol)) {
      bySymbol.set(leg.optionSymbol, { buyCost: 0, buyQty: 0, sellProceeds: 0, sellQty: 0 });
    }
    const entry = bySymbol.get(leg.optionSymbol)!;

    if (leg.side === 'buy_to_open') {
      entry.buyCost += leg.avgFillPrice * leg.qty * 100;
      entry.buyQty += leg.qty;
    } else if (leg.side === 'sell_to_close') {
      entry.sellProceeds += leg.avgFillPrice * leg.qty * 100;
      entry.sellQty += leg.qty;
    }
    // Ignore buy_to_close, sell_to_open (not our pattern)
  }

  let totalPnl = 0;
  let completedTrades = 0;
  let wins = 0;

  for (const [_sym, entry] of bySymbol) {
    // A "completed trade" = matched round trip (buy + sell)
    const closedQty = Math.min(entry.buyQty, entry.sellQty);
    if (closedQty <= 0) continue;

    // P&L = sell proceeds - buy cost, pro-rated to matched quantity
    const avgBuyCost = entry.buyCost / entry.buyQty;
    const avgSellProceeds = entry.sellProceeds / entry.sellQty;
    const pnl = (avgSellProceeds - avgBuyCost) * closedQty;

    totalPnl += pnl;
    completedTrades++;
    if (pnl > 0) wins++;
  }

  // Only return if we found actual round trips — having only open buys with no sells
  // means no realized P&L yet
  if (completedTrades === 0) return null;

  return { pnl: totalPnl, trades: completedTrades, wins, fetchedAt: Date.now(), source: 'orders' };
}

/**
 * Fetch P&L from the gainloss endpoint (broker-computed, but has T+1 lag for 0DTE).
 * Used as fallback — when it has today's data, it's the most accurate source.
 */
async function fetchFromGainloss(acctId: string, today: string): Promise<BrokerPnl | null> {
  const { data } = await axios.get(
    `${TRADIER_BASE}/accounts/${acctId}/gainloss?count=100`,
    { headers: headers(), timeout: 10000 },
  );

  const raw = data?.gainloss?.closed_position;
  if (!raw || raw === 'null') return null;

  const positions = Array.isArray(raw) ? raw : [raw];

  let totalPnl = 0;
  let trades = 0;
  let wins = 0;

  for (const p of positions) {
    const closeDate = (p.close_date || '').slice(0, 10);
    if (closeDate !== today) continue;

    const pnl = p.gain_loss ?? ((p.proceeds ?? 0) - (p.cost ?? 0));
    totalPnl += pnl;
    trades++;
    if (pnl > 0) wins++;
  }

  if (trades === 0) return null;
  return { pnl: totalPnl, trades, wins, fetchedAt: Date.now(), source: 'gainloss' };
}

/**
 * Fetch today's realized P&L from the broker.
 * Returns cached value if less than 30 seconds old.
 *
 * Tries orders first (same-day, real-time broker fill prices), falls back to gainloss
 * (broker-computed but may lag for 0DTE options).
 */
export async function fetchDailyPnl(accountId?: string): Promise<BrokerPnl> {
  const acctId = accountId || appConfig.tradierAccountId;

  // Check cache
  const cached = cache.get(acctId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const today = todayET();

  try {
    // Primary for same-day 0DTE: orders endpoint with broker avg_fill_price
    const ordersResult = await fetchFromOrders(acctId, today);
    if (ordersResult) {
      cache.set(acctId, ordersResult);
      return ordersResult;
    }

    // Fallback: gainloss endpoint (broker-computed, but T+1 settlement lag for 0DTE)
    const glResult = await fetchFromGainloss(acctId, today);
    if (glResult) {
      cache.set(acctId, glResult);
      return glResult;
    }

    // No trades today
    const empty: BrokerPnl = { pnl: 0, trades: 0, wins: 0, fetchedAt: Date.now(), source: 'empty' };
    cache.set(acctId, empty);
    return empty;
  } catch (e: any) {
    console.warn(`[broker-pnl] Failed to fetch P&L for ${acctId}: ${e.message}`);
    // Return stale cache if available, otherwise zero
    return cache.get(acctId) ?? { pnl: 0, trades: 0, wins: 0, fetchedAt: 0, source: 'empty' };
  }
}
