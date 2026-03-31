# Unified Account Monitor Agent

## Problem

The current `agent-xsp-monitor.ts` only watches one account (XSP cash, 6YA58635). The SPX margin agent (6YA51425) runs unmonitored. Today's incident showed the monitor catching real issues — rejected orders, negative buying power, disk exhaustion — but also exposed major flaws: auth failures on startup, repetitive alert spam (25+ identical alerts), no market-hours awareness, context window bloat causing OOM/restarts (23 restarts today), and no ability to notify externally.

## Solution

One unified monitor agent that oversees both trading accounts, both agent processes, the data pipeline, and system health — replacing `agent-xsp-monitor.ts` with `account-monitor.ts`.

## What It Watches

| Layer | What | How |
|-------|------|-----|
| **Accounts** | SPX margin (6YA51425) + XSP cash (6YA58635) | Tradier positions, orders, balances API |
| **Agents** | `spxer-agent` + `spxer-xsp` PM2 processes | Status files, PM2 process state, log freshness |
| **Data pipeline** | `spxer` service on port 3600 | `/health` + `/spx/snapshot` endpoints |
| **System** | Disk, memory, database | `df`, PM2 memory, SQLite WAL size |

## Tools (8 total)

| Tool | Description |
|------|-------------|
| `get_positions` | Fetch open positions from Tradier. Param: `account` (spx, xsp, or both). Default: both. |
| `get_orders` | Fetch today's orders. Params: `account`, `status_filter` (all/open/filled/rejected). Default: both + all. |
| `get_balance` | Fetch account balance. Param: `account`. Default: both. Shows equity, buying power, P&L. |
| `get_quotes` | Batch quotes for option symbols. Same as current. |
| `get_market_snapshot` | SPX snapshot from data service — price, HMA cross direction, RSI, key indicators. |
| `get_agent_status` | Read agent status file + PM2 info. Param: `agent` (spx, xsp, or both). Checks file freshness. |
| `check_system_health` | Disk usage, PM2 process list, database size, WAL size. No params. |
| `log_observation` | Write timestamped assessment. Params: `message`, `severity` (info/warn/alert). |

## Schedule (market-hours aware)

| Window | Interval | Behavior |
|--------|----------|----------|
| Pre-market (8:00-9:30 ET) | 5 min | Light check: services up, agents ready, balance OK |
| RTH (9:30-16:00 ET) | 30 sec | Full check: positions, orders, signals, P&L, risk |
| Post-close (16:00-16:30 ET) | 2 min | Wind-down: verify positions closed/expired, final P&L |
| Overnight (16:30-8:00 ET) | 30 min | System health only: disk, processes, no Tradier calls |
| Weekends/holidays | Off | Don't run |

## Alert Deduplication

Track last alert hash + timestamp. If the same alert fires again within 5 minutes, suppress it and increment a counter. After 5 minutes of the same condition, log a summary: `"Negative buying power alert (×15 over 7 min) — still unresolved"`. Reset counter when condition changes.

## Session Management

Reset the LLM session (create fresh) every 20 cycles to prevent context window bloat. Carry forward a 1-paragraph state summary into the new session so the LLM doesn't lose awareness of ongoing issues.

## Accounts Config

```typescript
const ACCOUNTS = {
  spx: {
    accountId: '6YA51425',
    label: 'SPX Margin',
    agentProcess: 'spxer-agent',
    statusFile: 'logs/agent-status.json',        // shared status file currently
    activityFile: 'logs/agent-activity.jsonl',
  },
  xsp: {
    accountId: '6YA58635',
    label: 'XSP Cash',
    agentProcess: 'spxer-xsp',
    statusFile: 'logs/agent-status.json',         // same file — agents may need separation
    activityFile: 'logs/agent-activity.jsonl',
  },
};
```

## System Prompt (condensed)

The LLM gets told:
- You monitor 2 trading accounts running HMA(3)×HMA(17) deterministic strategies
- SPX = margin account, up to 10 contracts, 0DTE SPX options
- XSP = cash account, 1 contract, 1DTE XSP (1/10th SPX) options
- Run your tools, assess, log. Be concise for routine cycles, expand for real issues.
- Cross-account awareness: if both agents open positions simultaneously, check combined buying power impact
- Never log the same alert twice — summarize ongoing conditions

## What It Does NOT Do

- **No trading** — read-only monitoring, no order submission
- **No auto-remediation** — the disk cleanup today was clever but risky. Log the recommendation, don't execute it. (We can add this later behind a flag.)
- **No scanner/judge analysis** — that's the agents' job. Monitor checks if agents are doing their job.

## Files

| File | Purpose |
|------|---------|
| `account-monitor.ts` | Main entry point (replaces `agent-xsp-monitor.ts`) |
| `logs/account-monitor.log` | Unified log (replaces `logs/xsp-monitor.log`) |
| `ecosystem.config.js` | Update `xsp-monitor` → `account-monitor` PM2 entry |

## Fixes Baked In vs. Current Monitor

| Issue | Current | New |
|-------|---------|-----|
| Single account | XSP only | Both SPX + XSP |
| Alert spam | 25+ identical alerts in a row | Dedup with counter, 5-min summary |
| No market hours | 30s cycles 24/7 | Schedule-aware: 30s RTH, 30min overnight, off weekends |
| Context bloat / OOM | Session grows until 256MB crash | Reset every 20 cycles with state carryover |
| Stale state detection | Didn't notice for 70 min | Check file mtime every cycle, alert if >2 min stale |
| Timezone | `toLocaleString` round-trip | Uses `src/utils/et-time.ts` helpers |
| Auth failures on start | Crash loop, 23 restarts | Retry with backoff, skip LLM if auth fails (still log raw data) |
| Auto-remediation | Ran `rm` and `pm2 restart` via bash | Disabled by default — log recommendations only |

## Success Criteria

1. Both accounts monitored in a single process under 150MB memory
2. Zero repeated identical alerts in the log
3. Clean transition between RTH/post-close/overnight intervals
4. Catches stale agent state within 2 minutes
5. Survives a full trading day without restarts
