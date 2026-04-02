/**
 * Schwab Trader API Provider
 *
 * OAuth2 three-legged flow:
 *   1. /schwab/auth        → redirect user to Schwab login
 *   2. /schwab/callback    → exchange code for tokens, store in DB
 *   3. Background timer    → refresh access_token every 29 min
 *   4. Every 7 days        → refresh_token expires, re-auth required
 *
 * Tokens are stored in the `schwab_tokens` table in spxer.db.
 *
 * API base URLs:
 *   Trader:      https://api.schwabapi.com/trader/v1
 *   Market Data: https://api.schwabapi.com/marketdata/v1
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const SCHWAB_AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
export const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
export const SCHWAB_TRADER_BASE = 'https://api.schwabapi.com/trader/v1';
export const SCHWAB_MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1';

const CLIENT_ID = process.env.SCHWAB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SCHWAB_CLIENT_SECRET || '';
const CALLBACK_URL = process.env.SCHWAB_CALLBACK_URL || 'https://bitloom.cloud/schwab/callback';

// ---------------------------------------------------------------------------
// Token store (SQLite via better-sqlite3, same DB as the rest of spxer)
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3';
import { config } from '../config';

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS schwab_tokens (
        id           INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    INTEGER NOT NULL,   -- Unix seconds when access_token expires
        refresh_expires_at INTEGER NOT NULL, -- Unix seconds when refresh_token expires (7 days)
        account_hash  TEXT,               -- hashed account number (fetched after first auth)
        updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
  }
  return _db;
}

export interface SchwabTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at: number;
  account_hash: string | null;
}

export function loadTokens(): SchwabTokens | null {
  const row = getDb().prepare('SELECT * FROM schwab_tokens WHERE id = 1').get() as any;
  return row ?? null;
}

export function saveTokens(tokens: Omit<SchwabTokens, 'account_hash'> & { account_hash?: string | null }): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM schwab_tokens WHERE id = 1').get();
  if (existing) {
    db.prepare(`
      UPDATE schwab_tokens SET
        access_token = @access_token,
        refresh_token = @refresh_token,
        expires_at = @expires_at,
        refresh_expires_at = @refresh_expires_at,
        account_hash = COALESCE(@account_hash, account_hash),
        updated_at = strftime('%s','now')
      WHERE id = 1
    `).run({ ...tokens, account_hash: tokens.account_hash ?? null });
  } else {
    db.prepare(`
      INSERT INTO schwab_tokens (id, access_token, refresh_token, expires_at, refresh_expires_at, account_hash)
      VALUES (1, @access_token, @refresh_token, @expires_at, @refresh_expires_at, @account_hash)
    `).run({ ...tokens, account_hash: tokens.account_hash ?? null });
  }
}

// ---------------------------------------------------------------------------
// Base64 credentials helper
// ---------------------------------------------------------------------------

function basicAuth(): string {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Step 1: Build the authorization URL (redirect user here)
// ---------------------------------------------------------------------------

/**
 * Returns the URL to redirect the user to for Schwab login / consent.
 * Mount this behind your /schwab/auth route.
 */
export function buildAuthUrl(): string {
  if (!CLIENT_ID) throw new Error('SCHWAB_CLIENT_ID is not set in .env');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
  });
  return `${SCHWAB_AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Step 2: Exchange the authorization code for tokens
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;   // seconds until access_token expires (typically 1800 = 30 min)
  token_type: string;
}

/**
 * Called from your /schwab/callback route handler.
 * Exchanges the one-time `code` from Schwab for access + refresh tokens.
 * Persists tokens to DB and returns them.
 */
export async function exchangeCodeForTokens(code: string): Promise<SchwabTokens> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET not set in .env');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK_URL,
  });

  const resp = await fetch(SCHWAB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Schwab token exchange failed ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as TokenResponse;
  const now = Math.floor(Date.now() / 1000);

  const tokens: SchwabTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + data.expires_in,
    refresh_expires_at: now + 7 * 24 * 3600, // Schwab refresh tokens expire in 7 days
    account_hash: null,
  };

  saveTokens(tokens);
  console.log(`[schwab] Tokens obtained. Access expires ${new Date(tokens.expires_at * 1000).toISOString()}`);

  // Immediately fetch + store the account hash value (needed for all order APIs)
  await fetchAndStoreAccountHash(tokens.access_token);

  return tokens;
}

// ---------------------------------------------------------------------------
// Step 3: Refresh the access token (run every 29 minutes)
// ---------------------------------------------------------------------------

/**
 * Uses the stored refresh_token to get a new access_token.
 * Call this on a 29-minute interval during market hours.
 * Throws if the refresh token has expired (7-day limit) — user must re-auth.
 */
export async function refreshAccessToken(): Promise<SchwabTokens> {
  const existing = loadTokens();
  if (!existing) throw new Error('No Schwab tokens stored — run /schwab/auth first');

  const now = Math.floor(Date.now() / 1000);
  if (now >= existing.refresh_expires_at) {
    throw new Error('Schwab refresh token expired (7-day limit). Re-authenticate at /schwab/auth');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: existing.refresh_token,
  });

  const resp = await fetch(SCHWAB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Schwab token refresh failed ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as TokenResponse;
  now; // reassign not needed, we already have it

  const updated: SchwabTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? existing.refresh_token, // Schwab may or may not rotate it
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    refresh_expires_at: existing.refresh_expires_at, // 7-day clock doesn't reset on refresh
    account_hash: existing.account_hash,
  };

  saveTokens(updated);
  console.log(`[schwab] Access token refreshed. Expires ${new Date(updated.expires_at * 1000).toISOString()}`);
  return updated;
}

// ---------------------------------------------------------------------------
// Token getter (auto-refresh if within 2 min of expiry)
// ---------------------------------------------------------------------------

/**
 * Returns a valid access token, auto-refreshing if it's close to expiry.
 * Use this in all API call helpers.
 */
export async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authenticated with Schwab. Visit /schwab/auth');

  const now = Math.floor(Date.now() / 1000);
  const twoMinBuffer = 120;

  if (now >= tokens.expires_at - twoMinBuffer) {
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Account hash (required for all Trader API order endpoints)
// ---------------------------------------------------------------------------

/**
 * Fetches the encrypted account hash value from Schwab.
 * Schwab requires this hash (not the raw account number) in API calls.
 */
export async function fetchAndStoreAccountHash(accessToken?: string): Promise<string | null> {
  const token = accessToken ?? await getAccessToken();

  const resp = await fetch(`${SCHWAB_TRADER_BASE}/accounts/accountNumbers`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    console.error(`[schwab] Failed to fetch account numbers: ${resp.status}`);
    return null;
  }

  const data = (await resp.json()) as Array<{ accountNumber: string; hashValue: string }>;
  if (!data.length) {
    console.error('[schwab] No accounts returned');
    return null;
  }

  const hash = data[0].hashValue;
  const db = getDb();
  db.prepare('UPDATE schwab_tokens SET account_hash = ? WHERE id = 1').run(hash);
  console.log(`[schwab] Account hash stored: ${hash.slice(0, 8)}...`);
  return hash;
}

export async function getAccountHash(): Promise<string> {
  const tokens = loadTokens();
  if (tokens?.account_hash) return tokens.account_hash;
  const hash = await fetchAndStoreAccountHash();
  if (!hash) throw new Error('Could not retrieve Schwab account hash');
  return hash;
}

// ---------------------------------------------------------------------------
// Background token refresher
// ---------------------------------------------------------------------------

let _refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background interval that refreshes the access token every 29 minutes.
 * Call this once from your main server startup (after tokens exist).
 * Safe to call multiple times — only one timer runs.
 */
export function startTokenRefresher(): void {
  if (_refreshTimer) return;

  const INTERVAL_MS = 29 * 60 * 1000; // 29 minutes

  _refreshTimer = setInterval(async () => {
    const tokens = loadTokens();
    if (!tokens) return; // not authenticated yet

    try {
      await refreshAccessToken();
    } catch (err: any) {
      console.error(`[schwab] Token refresh failed: ${err.message}`);
      if (err.message.includes('7-day')) {
        console.warn('[schwab] ⚠️  Refresh token expired! Visit /schwab/auth to re-authenticate.');
        stopTokenRefresher();
      }
    }
  }, INTERVAL_MS);

  console.log('[schwab] Token auto-refresher started (every 29 min)');
}

export function stopTokenRefresher(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Schwab API helpers — Accounts & Trading
// ---------------------------------------------------------------------------

/** Get all linked accounts with balances */
export async function getAccounts(): Promise<any[]> {
  const token = await getAccessToken();
  const resp = await fetch(`${SCHWAB_TRADER_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getAccounts failed: ${resp.status}`);
  return resp.json() as Promise<any[]>;
}

/** Get a single account's details + positions */
export async function getAccount(fields?: 'positions' | 'orders'): Promise<any> {
  const token = await getAccessToken();
  const hash = await getAccountHash();
  const url = new URL(`${SCHWAB_TRADER_BASE}/accounts/${hash}`);
  if (fields) url.searchParams.set('fields', fields);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getAccount failed: ${resp.status}`);
  return resp.json();
}

/** Get open orders for the account */
export async function getOrders(fromEnteredTime?: string, toEnteredTime?: string): Promise<any[]> {
  const token = await getAccessToken();
  const hash = await getAccountHash();
  const url = new URL(`${SCHWAB_TRADER_BASE}/accounts/${hash}/orders`);

  // Schwab requires a date range — default to today
  const today = new Date().toISOString().split('T')[0];
  url.searchParams.set('fromEnteredTime', fromEnteredTime ?? `${today}T00:00:00.000Z`);
  url.searchParams.set('toEnteredTime', toEnteredTime ?? `${today}T23:59:59.999Z`);
  url.searchParams.set('status', 'WORKING');

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getOrders failed: ${resp.status}`);
  return resp.json() as Promise<any[]>;
}

/** Place an order */
export async function placeOrder(orderPayload: SchwabOrder): Promise<{ orderId?: string }> {
  const token = await getAccessToken();
  const hash = await getAccountHash();

  const resp = await fetch(`${SCHWAB_TRADER_BASE}/accounts/${hash}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: '*/*',
    },
    body: JSON.stringify(orderPayload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`placeOrder failed ${resp.status}: ${text}`);
  }

  // Schwab returns 201 with no body on success; order ID is in Location header
  const location = resp.headers.get('location') ?? '';
  const orderId = location.split('/').pop();
  console.log(`[schwab] Order placed. ID: ${orderId}`);
  return { orderId };
}

/** Cancel an order */
export async function cancelOrder(orderId: string): Promise<void> {
  const token = await getAccessToken();
  const hash = await getAccountHash();

  const resp = await fetch(`${SCHWAB_TRADER_BASE}/accounts/${hash}/orders/${orderId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`cancelOrder failed ${resp.status}: ${text}`);
  }
  console.log(`[schwab] Order ${orderId} cancelled`);
}

// ---------------------------------------------------------------------------
// Schwab API helpers — Market Data
// ---------------------------------------------------------------------------

/** Get quotes for one or more symbols (equities, ETFs, options) */
export async function getQuotes(symbols: string[]): Promise<Record<string, any>> {
  const token = await getAccessToken();
  const url = new URL(`${SCHWAB_MARKET_BASE}/quotes`);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('indicative', 'false');

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getQuotes failed: ${resp.status}`);
  return resp.json() as Promise<Record<string, any>>;
}

/** Get price history (OHLCV) for an equity/ETF */
export async function getPriceHistory(
  symbol: string,
  opts: {
    periodType?: 'day' | 'month' | 'year' | 'ytd';
    period?: number;
    frequencyType?: 'minute' | 'daily' | 'weekly' | 'monthly';
    frequency?: number;
    startDate?: number; // milliseconds epoch
    endDate?: number;
  } = {}
): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${SCHWAB_MARKET_BASE}/pricehistory`);
  url.searchParams.set('symbol', symbol);
  if (opts.periodType) url.searchParams.set('periodType', opts.periodType);
  if (opts.period !== undefined) url.searchParams.set('period', String(opts.period));
  if (opts.frequencyType) url.searchParams.set('frequencyType', opts.frequencyType);
  if (opts.frequency !== undefined) url.searchParams.set('frequency', String(opts.frequency));
  if (opts.startDate !== undefined) url.searchParams.set('startDate', String(opts.startDate));
  if (opts.endDate !== undefined) url.searchParams.set('endDate', String(opts.endDate));

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getPriceHistory failed: ${resp.status}`);
  return resp.json();
}

/** Get option chain */
export async function getOptionChain(symbol: string, opts: {
  contractType?: 'CALL' | 'PUT' | 'ALL';
  strikeCount?: number;
  fromDate?: string; // YYYY-MM-DD
  toDate?: string;
} = {}): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${SCHWAB_MARKET_BASE}/chains`);
  url.searchParams.set('symbol', symbol);
  if (opts.contractType) url.searchParams.set('contractType', opts.contractType);
  if (opts.strikeCount) url.searchParams.set('strikeCount', String(opts.strikeCount));
  if (opts.fromDate) url.searchParams.set('fromDate', opts.fromDate);
  if (opts.toDate) url.searchParams.set('toDate', opts.toDate);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`getOptionChain failed: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Order type helpers
// ---------------------------------------------------------------------------

export interface SchwabOrder {
  orderType: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  session: 'NORMAL' | 'AM' | 'PM' | 'SEAMLESS';
  duration: 'DAY' | 'GOOD_TILL_CANCEL' | 'FILL_OR_KILL';
  orderStrategyType: 'SINGLE' | 'OCO' | 'TRIGGER';
  price?: string;
  stopPrice?: string;
  orderLegCollection: SchwabOrderLeg[];
  childOrderStrategies?: SchwabOrder[];
}

export interface SchwabOrderLeg {
  orderLegType: 'EQUITY' | 'OPTION' | 'INDEX';
  legId: number;
  instrument: { symbol: string; assetType: 'EQUITY' | 'OPTION' | 'INDEX' };
  instruction: 'BUY' | 'SELL' | 'BUY_TO_OPEN' | 'BUY_TO_CLOSE' | 'SELL_TO_OPEN' | 'SELL_TO_CLOSE';
  quantity: number;
  positionEffect?: 'OPENING' | 'CLOSING';
}

/** Build a simple equity market order */
export function equityMarketOrder(
  symbol: string,
  instruction: 'BUY' | 'SELL',
  quantity: number
): SchwabOrder {
  return {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    orderLegCollection: [{
      orderLegType: 'EQUITY',
      legId: 1,
      instrument: { symbol, assetType: 'EQUITY' },
      instruction,
      quantity,
    }],
  };
}

/** Build a simple equity limit order */
export function equityLimitOrder(
  symbol: string,
  instruction: 'BUY' | 'SELL',
  quantity: number,
  limitPrice: number
): SchwabOrder {
  return {
    orderType: 'LIMIT',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    price: limitPrice.toFixed(2),
    orderLegCollection: [{
      orderLegType: 'EQUITY',
      legId: 1,
      instrument: { symbol, assetType: 'EQUITY' },
      instruction,
      quantity,
    }],
  };
}

// ---------------------------------------------------------------------------
// Auth status helper (for /health endpoint)
// ---------------------------------------------------------------------------

export interface SchwabAuthStatus {
  authenticated: boolean;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  refreshTokenDaysLeft: number | null;
  accountHash: string | null;
  needsReauth: boolean;
}

export function getSchwabAuthStatus(): SchwabAuthStatus {
  const tokens = loadTokens();
  if (!tokens) {
    return {
      authenticated: false,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      refreshTokenDaysLeft: null,
      accountHash: null,
      needsReauth: true,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const daysLeft = Math.floor((tokens.refresh_expires_at - now) / 86400);

  return {
    authenticated: now < tokens.expires_at,
    accessTokenExpiresAt: new Date(tokens.expires_at * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(tokens.refresh_expires_at * 1000).toISOString(),
    refreshTokenDaysLeft: daysLeft,
    accountHash: tokens.account_hash ? `${tokens.account_hash.slice(0, 8)}...` : null,
    needsReauth: daysLeft <= 0,
  };
}
