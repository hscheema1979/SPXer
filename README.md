# SPXer — 0DTE SPX Options Trading System

SPXer is three systems sharing a unified core: a **data service** that polls SPX/ES futures and tracks ~250–480 SPXW 0DTE options contracts with 1-minute OHLCV bars and a full indicator battery; **trading agents** that execute a deterministic HMA(3)×HMA(17) crossover strategy on SPX and XSP options via Tradier; and a **replay system** for config-driven backtesting through the same signal → strike selection → exit pipeline used in production.

**Strategy**: HMA(3)×HMA(17) cross on SPX underlying → OTM strike selection → OTOCO bracket order (TP 1.4× / SL 70%) → exit on HMA reversal, immediately flip to opposite side (scannerReverse). Pure deterministic — no LLM in the trading loop.

See [CLAUDE.md](CLAUDE.md) for full technical documentation.

---

## Architecture

```
Data Pipeline (spxer, port 3600)
─────────────────────────────────
  Tradier ──┐                        SQLite DB (WAL)         REST + WebSocket
  Yahoo  ───┼──► Bar Builder ──►     1m OHLCV bars    ──►   /spx/snapshot
  TV Scrn ──┘    Indicators          HMA/RSI/BB/EMA/        /spx/bars
                 Contract Tracker     VWAP/ATR/MACD/...     /contracts/active

Trading Agents (spxer-agent, spxer-xsp)
────────────────────────────────────────
  Market Snapshot ──► HMA(3)×HMA(17) cross ──► Strike Selector ($15 OTM)
       (from data      detection on 1m bars      computeQty (15% buying power)
        service)              │                         │
                        scannerReverse:           OTOCO bracket order
                        exit + flip on              (entry + TP limit + SL stop)
                        HMA reversal                    │
                                                  Tradier API (live)

Monitor (xsp-monitor)                  Replay (src/replay/)
──────────────────────                 ─────────────────────
  Pi SDK LLM agent                     In-memory bar cache
  reads positions/orders               Same src/core/ logic
  flags issues, does NOT trade         Config-driven backtesting
```

**Shared core** (`src/core/`): Signal detection, exit conditions, risk checks, strike selection, position sizing, and trade friction — all imported by both the live agents and replay system. Test in replay → deploy live.

---

## PM2 Processes

All processes managed via `ecosystem.config.js`:

| Process | Description |
|---------|-------------|
| `spxer` | Data pipeline — SPX/ES bars, options contracts, indicators (port 3600) |
| `spxer-agent` | SPX 0DTE agent — margin account, up to 10 contracts, 15% of buying power |
| `spxer-xsp` | XSP 1DTE agent — cash account, 1 contract, SPX→XSP strike conversion |
| `xsp-monitor` | LLM-powered oversight — monitors positions/orders, flags issues (doesn't trade) |
| `replay-viewer` | Replay viewer web UI (port 3601) |

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
pm2 start ecosystem.config.js --only spxer-agent
pm2 start ecosystem.config.js --only spxer-xsp

# Dev mode (data service only)
npm run dev

# Agent in paper mode
npm run agent          # SPX paper
npm run agent:xsp      # XSP paper

# Agent live (AGENT_PAPER=false)
npm run agent:live
npm run agent:xsp:live

# Monitor
pm2 logs spxer-agent --lines 50
pm2 list
```

---

## Replay & Backtesting

All replay commands go through the unified CLI at `src/replay/cli.ts`:

```bash
# Single day with AI scanners/judges
npx tsx src/replay/cli.ts run 2026-03-20

# Single day, deterministic only (no AI)
npx tsx src/replay/cli.ts run 2026-03-20 --no-scanners --no-judge

# Multi-day batch backtest (deterministic)
npx tsx src/replay/cli.ts backtest --no-scanners --no-judge
npx tsx src/replay/cli.ts backtest --dates=2026-03-18,2026-03-19,2026-03-20

# View results
npx tsx src/replay/cli.ts results --config=default

# List available dates
npx tsx src/replay/cli.ts days

# 22-day parallel replay
npm run replay:22day

# npm shortcuts
npm run replay           # single-day replay
npm run backtest         # multi-day, no AI
npm run viewer           # replay viewer UI
```

### Config Overrides

```bash
npx tsx src/replay/cli.ts run 2026-03-20 --no-scanners --no-judge \
  --cooldownSec=180 --stopLossPercent=70 --takeProfitMultiplier=1.4 \
  --strikeSearchRange=100 --activeStart=09:30 --activeEnd=15:45 \
  --enableHmaCrosses=true --enableEmaCrosses=false --label=test1
```

### Autoresearch (Parameter Optimization)

```bash
npx tsx scripts/autoresearch/verify-metric.ts --no-scanners
npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19 --cooldownSec=180 --label=test1
```

---

## Key Principles

**Deterministic execution.** HMA crossover → strike selection → OTOCO bracket order. No LLM latency in the trading loop. Sub-second from signal to order.

**Always positioned (scannerReverse).** On HMA reversal, exit current position and immediately flip to the opposite side. The system rides every move — it doesn't wait for "good setups."

**Server-side protection (OTOCO brackets).** Every entry triggers an OCO pair: TP limit + SL stop on the broker. If the agent crashes, Tradier enforces exits.

**Startup reconciliation.** On restart, agents query the broker for open positions, adopt orphaned ones, and submit missing OCO protection. Survives PM2 restarts cleanly.

**LLMs observe, code executes.** The XSP monitor agent uses LLM reasoning to flag issues but cannot place orders. Scanner/judge infrastructure exists in the codebase for replay experiments but is disabled in live trading.

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

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service status, uptime, SPX price, DB size |
| `GET /spx/snapshot` | Latest SPX bar with all indicators |
| `GET /spx/bars?tf=1m&n=100` | SPX bar history |
| `GET /contracts/active` | All ACTIVE + STICKY contracts |
| `GET /contracts/:symbol/bars?tf=1m&n=100` | Contract bar history |
| `GET /chain?expiry=YYYY-MM-DD` | Full options chain for an expiry |
| `GET /chain/expirations` | Available tracked expiry dates |

---

## Environment Variables

Required in `.env`:

| Variable | Purpose |
|----------|---------|
| `TRADIER_TOKEN` | Tradier API token (data + orders) |
| `TRADIER_ACCOUNT_ID` | Default Tradier account |
| `ANTHROPIC_API_KEY` | For judge/monitor LLM calls |
| `PORT` | Data service port (default 3600) |
| `DB_PATH` | SQLite path (default `./data/spxer.db`) |
| `AGENT_PAPER` | `true` for paper mode, `false` for live |

---

*Full architecture details, module reference, config system, and design decisions in [CLAUDE.md](CLAUDE.md).*
