# SPXer — 0DTE SPX Options Trading System

SPXer is a **three-independent-services architecture** sharing a unified core: a **data service** (OPTIONAL) for market data and replay; a **standalone event handler** for signal detection and entry execution; and a **position monitor** for exit observation. All services have **direct Tradier API connections** — complete fault isolation.

**Strategy**: HMA(3)×HMA(12) cross on SPX option contracts → OTM strike selection → OTOCO bracket order (TP 1.4× / SL 70%) → exit on HMA reversal, immediately flip to opposite side. Pure deterministic — no LLM in the trading loop.

**Critical**: Live trading continues even if the data service crashes. The event handler and position monitor are 100% independent.

See [CLAUDE.md](CLAUDE.md) for full technical documentation and [SERVICE-ARCHITECTURE.md](SERVICE-ARCHITECTURE.md) for architecture details.

---

## Architecture (v2.0 — Independent Services)

```
┌─────────────────────────────────────────────────────────────────┐
│                         SPXer System                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   spxer      │    │  event-handler    │    │   position   │  │
│  │ (Data        │    │  (Signal Detect   │    │   monitor    │  │
│  │  Service)    │    │   + Entry Exec)   │    │  (Observer)  │  │
│  │              │    │                  │    │              │  │
│  │ Port: 3600   │    │  Timer: :00 sec  │    │  Poll: 10s   │  │
│  │              │    │  Tradier REST    │    │  Tradier REST│  │
│  │  OPTIONAL    │    │  (independent)   │    │  (independent)│  │
│  └──────────────┘    └────────┬─────────┘    └──────┬───────┘  │
│                                │                     │           │
│                                │    ┌────────────────┴───────────┐  │
│                                │    │                            │  │
│                                │    │         ┌─────────────┐    │  │
│                                │    └─────────►│ account.db  │◄───┘  │
│                                │              └─────────────┘         │
│                                │                                      │
│                                │                    ┌─────────────────┤
│                                └────────────────────►│  Tradier API    │
│                                                     │  (execution)    │
│                                                     └─────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key Design Principle**: **Complete Independence** — Each service has its own direct connection to Tradier API.

### Services

| Service | Purpose | Required for Live Trading? |
|---------|---------|----------------------------|
| **event-handler** (PRIMARY) | Signal detection + entry execution — 100% independent, direct Tradier polling | ✅ **YES** |
| **position-monitor** (RECOMMENDED) | Exit observer — pure logger, does NOT execute trades | ✅ **YES** (recommended) |
| **spxer** (OPTIONAL) | Data service + replay viewer — historical data only | ❌ **NO** |

**Fault Isolation**: If event-handler crashes, position-monitor continues observing. If position-monitor crashes, event-handler continues (OCO orders protect positions). If spxer crashes, **live trading continues unaffected**.

---

## Execution Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **SIMULATION** | Live signals with locally-simulated orders (safest for testing) | Testing without broker |
| **PAPER** | Live signals + Tradier paper trading (often unreliable) | Not recommended |
| **LIVE** | Live signals + Tradier production account | Real trading |

Set via `AGENT_EXECUTION_MODE` environment variable or `AGENT_PAPER` (legacy).

---

## PM2 Processes

All processes managed via `ecosystem.config.js`:

| Process | Purpose | Required |
|---------|---------|----------|
| `event-handler` | Signal detection + entry execution (PRIMARY) | ✅ YES |
| `position-monitor` | Exit observer — pure logger (RECOMMENDED) | ✅ YES |
| `spxer` | Data service + replay viewer (OPTIONAL) | ❌ NO |
| `replay-viewer` | Replay viewer web UI (port 3601) | Optional |
| `schwaber` | Schwab ETF trading (SPY/QQQ) | Optional |

---

## Directory Structure

```
SPXer/
├── src/                          # Source code
│   ├── core/                     # Core trading logic (single source of truth)
│   │   ├── types.ts              # Core types: Direction, Signal, Position, ExitCheck, etc.
│   │   ├── signal-detector.ts    # Config-driven signal detection (HMA, RSI, EMA crosses)
│   │   ├── position-manager.ts   # Pure exit logic: TP, SL, reversal, time
│   │   ├── position-sizer.ts     # Position sizing from Config.sizing
│   │   ├── risk-guard.ts         # Risk gates: positions, trades/day, daily loss, cooldown
│   │   ├── regime-gate.ts        # Regime-based signal gating
│   │   ├── strike-selector.ts    # OTM contract selection
│   │   ├── indicator-engine.ts   # HMA, RSI, Bollinger, EMA, ATR, VWAP (incremental)
│   │   ├── friction.ts           # $0.05 half-spread + $0.35 commission per side
│   │   ├── fill-model.ts         # Order-type slippage on top of friction
│   │   └── index.ts              # Barrel re-exports
│   │
│   ├── config/                   # Configuration system
│   │   ├── types.ts              # Config type definition
│   │   └── defaults.ts           # DEFAULT_CONFIG, mergeConfig(), validateConfig()
│   │
│   ├── pipeline/                 # Data pipeline (spxer service only)
│   │   ├── spx/                  # SPX-specific pipeline
│   │   │   ├── contract-tracker.ts   # Sticky band model for contract lifecycle
│   │   │   ├── scheduler.ts          # Pre-market warmup, market close handling
│   │   │   ├── signal-detector-function.ts  # HMA cross detection on contracts
│   │   │   └── option-stream.ts      # Tradier WebSocket for options (backup)
│   │   ├── bar-builder.ts        # Raw tick → OHLCV bar construction
│   │   ├── indicator-engine.ts   # Re-export of src/core/indicator-engine.ts
│   │   ├── aggregator.ts         # Higher timeframe aggregation
│   │   └── price-line.ts         # Minimal price tracker for options
│   │
│   ├── agent/                    # Trading agent (event-handler service)
│   │   ├── position-order-manager.ts   # Position lifecycle: evaluate, open, close, flip
│   │   ├── account-stream.ts          # Tradier WebSocket for real-time fills
│   │   ├── trade-executor.ts          # Tradier order execution (OTOCO brackets)
│   │   ├── broker-pnl.ts              # Tradier P&L fetching
│   │   ├── account-balance.ts         # Account balance caching
│   │   └── price-stream.ts            # Tradier HTTP streaming for SPX
│   │
│   ├── replay/                   # Backtesting system
│   │   ├── machine.ts             # Core replay engine (in-memory bar cache)
│   │   ├── cli.ts                 # Unified CLI: run, backtest, results, days
│   │   ├── store.ts               # SQLite store for runs/results
│   │   ├── prompt-library.ts      # Scanner prompts (18 prompts)
│   │   ├── metrics.ts             # Composite score computation
│   │   └── framework.ts           # Cycle snapshot builder
│   │
│   ├── server/                   # HTTP/WebSocket servers (spxer service)
│   │   ├── http.ts                # REST API (port 3600)
│   │   ├── ws.ts                  # WebSocket server
│   │   ├── admin-routes.ts        # Admin API endpoints
│   │   ├── replay-server.ts       # Replay viewer server (port 3601)
│   │   ├── admin-viewer.html      # Admin management UI
│   │   ├── account-viewer.html    # Account viewer UI
│   │   └── devops-viewer.html     # DevOps monitoring UI
│   │
│   ├── storage/                  # Database and queries
│   │   ├── db.ts                  # SQLite connection
│   │   ├── queries.ts             # High-level query functions
│   │   ├── archiver.ts            # Parquet export + GDrive upload
│   │   └── replay-db.ts           # Replay store
│   │
│   ├── providers/                # Market data providers
│   │   ├── tradier.ts             # Tradier REST API
│   │   ├── thetadata-stream.ts    # ThetaData WebSocket (primary)
│   │   ├── yahoo.ts               # Yahoo Finance (disabled)
│   │   └── tv-screener.ts         # TradingView screener (context)
│   │
│   ├── utils/                    # Utility functions
│   │   ├── et-time.ts             # ET timezone helpers (CRITICAL for time handling)
│   │   ├── health.ts              # HealthTracker for uptime monitoring
│   │   └── resilience.ts          # Retry/backoff helpers
│   │
│   ├── data/                     # Static data
│   │   └── economic-calendar.json # US economic calendar
│   │
│   ├── types.ts                  # Global types: Bar, Contract, Timeframe, etc.
│   └── index.ts                  # Data service entry point (spxer)
│
├── scripts/                      # Utility scripts
│   ├── autoresearch/             # Parameter optimization
│   │   ├── verify-metric.ts      # Single-run parameter verification
│   │   ├── param-search.ts       # Automated multi-parameter search
│   │   └── config-optimizer.ts   # Config mutation helpers
│   └── ops/                      # Operations scripts
│       ├── check-environment.sh
│       ├── monitor-active-trading.sh
│       └── start-warmup.sh
│
├── tests/                        # Vitest tests (mirrors src/ structure)
│   ├── core/                     # Core trading logic tests
│   ├── pipeline/                 # Pipeline tests
│   ├── providers/                # Provider tests
│   ├── server/                   # API tests
│   └── smoke.test.ts             # End-to-end smoke tests
│
├── deploy/                       # Deployment configurations
│   └── vps5-spxer-nginx.conf     # Nginx proxy config for bitloom.cloud
│
├── docs/                         # Documentation
│   ├── SIMULATION-MODE.md
│   └── (other docs)
│
├── data/                         # Runtime data (gitignored)
│   ├── spxer.db                  # Main SQLite database (bars, contracts, configs, results)
│   ├── account.db                # Live trading state (positions, orders)
│   ├── parquet/                  # Historical bar data (archival)
│   └── live/                     # Daily bar databases
│
├── event_handler_mvp.ts          # Event handler entry point (PRIMARY - independent)
├── position_monitor.ts           # Position monitor entry point (RECOMMENDED - independent)
├── schwaber.ts                   # Schwab ETF trading entry point (optional)
├── ecosystem.config.js           # PM2 process configuration
├── package.json                  # Node.js dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
├── .env                          # Environment variables (not in git)
├── README.md                     # This file
├── CLAUDE.md                     # Full technical documentation for AI agents
├── SERVICE-ARCHITECTURE.md       # Independent services architecture details
└── DAILY-OPS-CHECKLIST.md        # Daily operations procedures
```

### Key Files for Agent Navigation

| Purpose | File Location |
|---------|---------------|
| **Event Handler Entry** | `event_handler_mvp.ts` (PRIMARY - independent) |
| **Position Monitor Entry** | `position_monitor.ts` (RECOMMENDED - independent) |
| **Data Service Entry** | `src/index.ts` (OPTIONAL - only for replay) |
| **Core Trading Logic** | `src/core/` (single source of truth) |
| **Config System** | `src/config/defaults.ts` |
| **PM2 Configuration** | `ecosystem.config.js` |
| **Environment Variables** | `.env` |
| **Database Schema** | `src/storage/db.ts` |
| **REST API Routes** | `src/server/http.ts` |
| **Admin UI** | `src/server/admin-viewer.html` |
| **Replay CLI** | `src/replay/cli.ts` |
| **Tests** | `tests/` (mirrors `src/` structure) |

---

## Quick Start

```bash
# Prerequisites: Node.js, PM2, .env with TRADIER_TOKEN + TRADIER_ACCOUNT_ID
npm install

# Start everything
pm2 start ecosystem.config.js
pm2 save

# Start individual processes
pm2 start ecosystem.config.js --only spxer
pm2 start ecosystem.config.js --only event-handler

# Dev mode (data service only)
npm run dev

# Event handler in paper mode
AGENT_CONFIG_ID="your-config-id" AGENT_PAPER=true npx tsx event_handler_mvp.ts

# Event handler live (AGENT_PAPER=false)
AGENT_CONFIG_ID="your-config-id" AGENT_PAPER=false npx tsx event_handler_mvp.ts

# Multiple configs in one process
AGENT_CONFIG_IDS="config1,config2,config3" AGENT_PAPER=true npx tsx event_handler_mvp.ts

# Monitor
pm2 logs event-handler --lines 50
pm2 list
```

---

## Replay & Backtesting

**Note**: Replay system requires spxer data service for historical data access.

All replay commands go through the unified CLI at `src/replay/cli.ts`:

```bash
# Single day
npx tsx src/replay/cli.ts run 2026-03-20

# Multi-day batch backtest
npx tsx src/replay/cli.ts backtest --dates=2026-03-18,2026-03-19,2026-03-20

# View results
npx tsx src/replay/cli.ts results --config=default

# List available dates
npx tsx src/replay/cli.ts days

# npm shortcuts
npm run replay           # single-day replay
npm run backtest         # multi-day
npm run viewer           # replay viewer UI
```

### Config Overrides

```bash
npx tsx src/replay/cli.ts run 2026-03-20 \
  --cooldownSec=180 --stopLossPercent=70 --takeProfitMultiplier=1.4 \
  --strikeSearchRange=100 --activeStart=09:30 --activeEnd=15:45
```

### Autoresearch (Parameter Optimization)

```bash
npx tsx scripts/autoresearch/verify-metric.ts --no-scanners
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19 --cooldownSec=180
```

---

## Key Principles

**Complete Independence.** Each service has direct Tradier API access. Event handler and position monitor don't use spxer data service. Live trading continues if spxer crashes.

**Deterministic execution.** HMA crossover → strike selection → OTOCO bracket order. No LLM latency in the trading loop. Timer-based signal detection at :00 seconds every minute.

**Always positioned (scannerReverse).** On HMA reversal, exit current position and immediately flip to the opposite side. The system rides every move.

**Server-side protection (OTOCO brackets).** Every entry triggers an OCO pair: TP limit + SL stop on the broker. If the agent crashes, Tradier enforces exits.

**Startup reconciliation.** On restart, event-handler queries Tradier for open positions, adopts orphaned ones, and submits missing OCO protection. Survives PM2 restarts cleanly.

**Observer pattern.** Position monitor observes only — does NOT execute trades. All execution handled by event handler.

**Single source of truth.** All trading logic lives in `src/core/`. Live agents wrap core functions with stateful classes. Replay calls core functions directly. Never duplicate logic.

**Trade friction model.** $0.05 half-spread + $0.35 commission per side applied to all P&L calculations, both backtest and live.

---

## Testing

```bash
npm run test              # all tests (vitest)
npm run test:watch        # watch mode
npx vitest run tests/pipeline/bar-builder.test.ts   # single file
```

---

## REST API (port 3600)

**Core Data Endpoints**:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service status, uptime, SPX price, DB size |
| `GET /spx/snapshot` | Latest SPX bar with all indicators |
| `GET /spx/bars?tf=1m&n=100` | SPX bar history |
| `GET /contracts/active` | All ACTIVE + STICKY contracts |
| `GET /contracts/:symbol/bars?tf=1m&n=100` | Contract bar history |

**Admin Endpoints**:

| Endpoint | Description |
|----------|-------------|
| `GET /admin/api/processes` | List all PM2 processes |
| `GET /agent/mode` | Current execution mode (SIMULATION/PAPER/LIVE) |
| `GET /agent/status` | Current agent status |

---

## Environment Variables

Required in `.env`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `TRADIER_TOKEN` | Tradier API token (data + orders) | Required |
| `TRADIER_ACCOUNT_ID` | Default Tradier account | Required |
| `ANTHROPIC_API_KEY` | For judge/monitor LLM calls | Optional |
| `PORT` | Data service port | 3600 |
| `DB_PATH` | SQLite path | `./data/spxer.db` |

**Event Handler Configuration**:

| Variable | Purpose | Default |
|----------|---------|---------|
| `AGENT_CONFIG_ID` | Single config ID | — |
| `AGENT_CONFIG_IDS` | Multiple configs (comma-separated) | — |
| `AGENT_EXECUTION_MODE` | SIMULATION/PAPER/LIVE | PAPER (if AGENT_PAPER set) |
| `AGENT_PAPER` | Legacy: true=paper, false=live | false |

---

## Documentation

- **[CLAUDE.md](CLAUDE.md)** — Full technical documentation, module reference, design decisions
- **[SERVICE-ARCHITECTURE.md](SERVICE-ARCHITECTURE.md)** — Independent services architecture details
- **[docs/SIMULATION-MODE.md](docs/SIMULATION-MODE.md)** — SIMULATION execution mode guide
- **[DAILY-OPS-CHECKLIST.md](DAILY-OPS-CHECKLIST.md)** — Daily operations procedures
