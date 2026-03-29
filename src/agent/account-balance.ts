/**
 * Account Balance — fetches buying power from Tradier API.
 * Caches for 5 minutes to avoid excessive API calls.
 */
import axios from 'axios';
import { config, TRADIER_BASE } from '../config';

interface AccountBalance {
  totalEquity: number;
  optionBuyingPower: number;
  cash: number;
  accountType: string;       // 'margin', 'cash'
  fetchedAt: number;
}

const cache = new Map<string, AccountBalance>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function headers() {
  return {
    Authorization: `Bearer ${config.tradierToken}`,
    Accept: 'application/json',
  };
}

/**
 * Fetch account balance from Tradier.
 * Returns cached value if less than 5 minutes old.
 */
export async function getAccountBalance(accountId?: string): Promise<AccountBalance | null> {
  const acctId = accountId || config.tradierAccountId;

  // Check cache
  const cached = cache.get(acctId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${acctId}/balances`,
      { headers: headers(), timeout: 10000 },
    );

    const balances = data?.balances;
    if (!balances) return null;

    // Tradier returns different fields for margin vs cash accounts
    const accountType = balances.account_type || 'unknown';
    const isCash = accountType === 'cash';

    const result: AccountBalance = {
      totalEquity: balances.total_equity ?? balances.total_cash ?? 0,
      optionBuyingPower: isCash
        ? (balances.total_cash ?? balances.cash?.cash_available ?? 0)
        : (balances.option_buying_power ?? balances.margin?.option_buying_power ?? 0),
      cash: balances.total_cash ?? balances.cash?.cash_available ?? 0,
      accountType,
      fetchedAt: Date.now(),
    };

    cache.set(acctId, result);
    console.log(`[account] ${acctId} (${accountType}): equity=$${result.totalEquity.toFixed(0)}, buying_power=$${result.optionBuyingPower.toFixed(0)}`);

    return result;
  } catch (e: any) {
    console.error(`[account] Failed to fetch balance for ${acctId}: ${e.message}`);
    // Return cached even if stale, or null
    return cache.get(acctId) ?? null;
  }
}

/**
 * Compute the dollar amount to risk per trade based on account balance.
 * @param riskPercent - percentage of buying power to use (e.g., 15 for 15%)
 * @param accountId - optional account override
 */
export async function computeTradeSize(
  riskPercent: number,
  accountId?: string,
): Promise<number> {
  const balance = await getAccountBalance(accountId);
  if (!balance) {
    console.warn('[account] Could not fetch balance — using fallback $500');
    return 500;
  }

  const dollars = Math.floor(balance.optionBuyingPower * riskPercent / 100);
  console.log(`[account] Trade size: ${riskPercent}% of $${balance.optionBuyingPower.toFixed(0)} = $${dollars}`);
  return Math.max(100, dollars); // minimum $100 per trade
}
