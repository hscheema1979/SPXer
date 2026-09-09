# Code Review: SPXer Branch (`feat/multi-dte-credit-sweep`) — 2026-08-09

> **Supersedes `CODE-REVIEW-2026-05-22.md`.** That earlier review was written for the `feat/shorts-fresh-fill-study` branch and lists "15 TS errors / 27 failing tests" — all of which referenced `src/server/*` files (the old `:3601` replay viewer) that were deleted in commit `a32fe0e1a` ("remove dead :3601 replay viewer + replay CLI/legacy scripts", −22,867 lines). Those findings are **no longer applicable**. This document reflects the actual current state.

## Executive Summary

The branch is in **healthy shape**. The earlier blocking issues (compilation errors, test failures, stubbed OR-levels, monolithic `replay-routes.ts`) have all been resolved — largely by deleting the code that contained them. What remains compiles cleanly and passes its full test suite. The codebase has also been **re-scoped**: SPXer is now a backtest/backfill/live-capture platform, and live order execution has moved to a separate repo (`~/optionx`).

**Status**: 🟢 **Compiles & tests green.** A small number of latent config/consistency issues remain (below); none block development.

| Check | Result |
|-------|--------|
| `npm run build` (`tsc`) | ✅ **0 errors** (was: 15) |
| `npm run test` (`vitest run`) | ✅ **684 passing / 0 failing** across 54 files (was: 27 failing) |
| OR-levels / pivot-levels stubs | ✅ Call sites deleted along with `replay-routes.ts`; stubs are now harmless dead code |
| Monolithic `replay-routes.ts` (3400+ lines) | ✅ Deleted; superseded by the port-3700 backtest studio |

## What Changed Since the 2026-05-22 Review

1. **The entire `src/server/` directory was deleted** (commit `a32fe0e1a`) — `replay-server.ts`, `replay-routes.ts`, `admin-routes.ts`, `sweep-manager-routes.ts`, all `*.html` viewers, and the replay CLI (`src/replay/cli.ts`, `framework.ts`, `basket-runner.ts`, `batch-worker.ts`, `index.ts`, `cli-config.ts`). This single change removed all 15 TS errors and all 27 test failures the old review cited.
2. **Live trading moved out of this repo** into `~/optionx`. The event handler, position monitor, data service, and Schwaber are gone. SPXer now hands finished configs to OptionX via the backtest studio's `take-live` endpoint.
3. **New subsystems**: `src/live/` (Black-Scholes delta + capture targets), `src/shared/stockx-triggers.ts` (stock HMA engine copied verbatim from OptionX), `src/framework/` (agent-runner), `src/backfill/`, `src/ops/`, `scripts/live/live-capture.ts` (Tradier RTH polling → parquet bars + snapshots).
4. **The single compilation error** that *did* exist on this branch (`machine.ts:147` — `tfSeconds` not on `BarCache`) was fixed in this pass by adding the optional `tfSeconds` field to the `BarCache` interfaces in `src/replay/bar-cache-file.ts` and `src/storage/parquet-reader-sync.ts`.

## Remaining Issues (Non-Blocking)

### 1. `ecosystem.config.js` references a deleted entry point ⚠️

The `replay-viewer` PM2 app still points at `src/server/replay-server.ts`, which no longer exists. Starting it under PM2 will fail. The actual HTTP server is the backtest studio at `scripts/autoresearch/backtest-server.ts` (port 3700), which is **not** listed in `ecosystem.config.js`.

**Fix options** (pick one):
- Remove the `replay-viewer` block from `ecosystem.config.js` (the studio is run ad-hoc), or
- Repoint it at `scripts/autoresearch/backtest-server.ts` with `REPLAY_PORT=3700`, or
- Resurrect a thin `src/server/replay-server.ts` wrapper if PM2 manageability of the studio is desired.

### 2. Inconsistent default DB path

- `src/config.ts`: `DB_PATH || './data/spxer.db'`
- `src/storage/replay-db.ts`: `DB_PATH || REPLAY_DB_PATH || 'data/replay.db'`
- `ecosystem.config.js` sets `DB_PATH=.../data/spxer.db`

When `DB_PATH` is set (as PM2 does) they agree. When it isn't, replay code writes to `data/replay.db` while other code expects `data/spxer.db`. Recommend unifying the default to one path.

### 3. `backtest-server.ts` is recovered/minified source

`scripts/autoresearch/backtest-server.ts` is bundled esbuild output recovered from the tsx transpile cache after the original source was lost (see its header comment). It works and is actively used, but it is unreadable and hard to maintain. Re-deriving clean TypeScript source from it (or treating the bundle as a build artifact with source elsewhere) would materially improve maintainability.

### 4. Dead / stubbed modules

- `src/storage/or-levels.ts` and `src/storage/pivot-levels.ts` are still no-op stubs. Their only callers lived in the deleted `replay-routes.ts`, so they are now unreachable. Either delete them or implement them if OR/pivot levels are still wanted.
- `src/pipeline/spx/` is an empty directory. Safe to delete.

### 5. Stale operations/ops tooling

Several `scripts/ops/monitor-*.sh` and `setup-*-automation.sh` scripts, plus `DAILY-OPS-CHECKLIST.md` and `SERVICE-ARCHITECTURE.md`, describe the old in-repo live services (event handler, position monitor, data service `:3600`). They will mislead anyone following them verbatim. Either update or archive them.

### 6. Type-safety polish (low priority)

- `loadBarCacheFromParquetSync` is typed loosely (`any`) where it is `require()`d in `machine.ts`. A real interface would help.
- Many `req.query` params in the (bundled) backtest server are cast `as string` without array/undefined handling — low risk since it's an internal tool, but worth tightening if rewritten.

## What's Working Well

- **`src/core/`** is clean, well-factored, and fully tested — the single source of truth for trading logic is in good shape.
- **Test suite is comprehensive and green** (684 tests across core, pipeline, storage, providers, instruments, backfill, diag, framework, utils, integration).
- **`bar-cache-file.ts`** binary cache is a well-designed hot path; the `tfSeconds` gating correctly prevents aggregated-bar look-ahead.
- **`src/shared/stockx-triggers.ts`** verbatim-copy approach keeps backtest and live behavior identical by construction.
- **Live capture** is crash-safe (per-day SQLite resume, parquet rewrite every 5 min) and records the bid/ask + greeks + live BS delta that can no longer be bought — a genuine data asset.

## Recommendations (Priority Order)

1. **Fix `ecosystem.config.js`** — point `replay-viewer` at the real server (or remove the block). ~10 min.
2. **Unify the default DB path** between `config.ts` and `replay-db.ts`. ~10 min.
3. **Delete dead stubs** (`or-levels.ts`, `pivot-levels.ts`) and the empty `src/pipeline/spx/`. ~5 min.
4. **Restore clean source** for `backtest-server.ts` (or document the bundle as a build artifact). Larger effort.
5. **Refresh/archive stale ops docs** (`DAILY-OPS-CHECKLIST.md`, `SERVICE-ARCHITECTURE.md`, monitor scripts). ~1 hr.

---

**Generated**: 2026-08-09
**Branch**: `feat/multi-dte-credit-sweep`
**Reviewer**: Claude Code
