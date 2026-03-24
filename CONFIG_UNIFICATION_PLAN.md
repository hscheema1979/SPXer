# Config Unification Plan

## Goal

One database, one config system. Everything is a variable — agents, regimes, prompts, thresholds, risk, models. Live agent and replay load from the same source of truth. Configs are CRUD: create, load, modify, save, swap at runtime.

---

## Phase 1: Database Schema

### Single database: `data/spxer.db`

Merge replay tables into spxer.db. Kill replay.db.

### New tables

```sql
-- Model registry: every LLM the system knows about
CREATE TABLE models (
  id          TEXT PRIMARY KEY,        -- 'kimi', 'glm', 'sonnet', etc.
  name        TEXT NOT NULL,           -- 'Kimi K2.5', 'Claude Sonnet'
  provider    TEXT NOT NULL,           -- 'moonshot', 'zhipu', 'minimax', 'anthropic'
  role        TEXT NOT NULL,           -- 'scanner', 'judge', 'both'
  base_url    TEXT NOT NULL,           -- 'https://api.kimi.com/coding/' or 'anthropic' for native
  model_name  TEXT NOT NULL,           -- 'kimi-k2', 'claude-sonnet-4-6'
  api_key_env TEXT NOT NULL,           -- 'KIMI_API_KEY' (env var name, not the key itself)
  timeout_ms  INTEGER DEFAULT 120000,  -- per-model timeout, tunable
  max_tokens  INTEGER DEFAULT 1024,    -- max response tokens
  enabled     INTEGER DEFAULT 1,       -- global kill switch per model
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Prompt library: all scanner and judge prompts
CREATE TABLE prompts (
  id          TEXT PRIMARY KEY,        -- 'scanner-baseline-v1', 'judge-regime-v2'
  role        TEXT NOT NULL,           -- 'scanner' or 'judge'
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,           -- full prompt text
  version     TEXT,                    -- semver
  notes       TEXT,                    -- what changed, why
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Configs: the main config table
-- Each row is a complete, self-contained config that any subsystem can load
CREATE TABLE configs (
  id              TEXT PRIMARY KEY,    -- 'paper-live-v1', 'replay-aggressive', etc.
  name            TEXT NOT NULL,
  description     TEXT,
  baseline_id     TEXT,                -- parent config this was derived from
  config_json     TEXT NOT NULL,       -- full JSON blob (see Config Schema below)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Active config bindings: which subsystem is running which config
CREATE TABLE active_configs (
  subsystem   TEXT PRIMARY KEY,        -- 'live-agent', 'replay', 'autoresearch', 'monitor'
  config_id   TEXT NOT NULL,
  loaded_at   INTEGER NOT NULL,
  FOREIGN KEY(config_id) REFERENCES configs(id)
);

-- Replay results (migrated from replay.db)
CREATE TABLE replay_runs (
  id          TEXT PRIMARY KEY,
  config_id   TEXT NOT NULL,
  date        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  completed_at INTEGER,
  status      TEXT NOT NULL,           -- 'running', 'completed', 'failed'
  error       TEXT,
  FOREIGN KEY(config_id) REFERENCES configs(id)
);

CREATE TABLE replay_results (
  run_id      TEXT NOT NULL,
  config_id   TEXT NOT NULL,
  date        TEXT NOT NULL,
  trades      INTEGER,
  wins        INTEGER,
  win_rate    REAL,
  total_pnl   REAL,
  avg_pnl     REAL,
  max_win     REAL,
  max_loss    REAL,
  sharpe      REAL,
  trades_json TEXT,
  PRIMARY KEY(run_id, date),
  FOREIGN KEY(config_id) REFERENCES configs(id)
);
```

### Config JSON Schema

The `config_json` column in `configs` holds this structure:

```typescript
interface Config {
  // --- Scanners ---
  scanners: {
    enabled: boolean;
    models: string[];              // ['kimi', 'glm', 'haiku'] — references models.id
    cycleIntervalSec: number;
    minConfidenceToEscalate: number;
    promptAssignments: Record<string, string>;  // { 'kimi': 'scanner-v2', 'glm': 'scanner-v1' } — model→prompt
  };

  // --- Judges ---
  judges: {
    enabled: boolean;
    models: string[];              // ['sonnet'] — references models.id
    activeJudge: string;           // which judge's decision executes
    consensusRule: 'primary-decides' | 'majority' | 'unanimous' | 'first-agree';
    confidenceThreshold: number;
    escalationCooldownSec: number;
    promptId: string;              // references prompts.id
  };

  // --- Regime ---
  regime: {
    enabled: boolean;
    mode: 'enforce' | 'advisory' | 'disabled';
    classification: {
      trendThreshold: number;
      lookbackBars: number;
      openingRangeMinutes: number;
    };
    timeWindows: {
      morningEnd: string;          // 'HH:MM' ET
      middayEnd: string;
      gammaExpiryStart: string;
      noTradeStart: string;
    };
    emergencyRsi: {
      oversold: number;
      overbought: number;
      morningOversold: number;
      morningOverbought: number;
    };
    signalGates: Record<string, {
      allowOverboughtFade: boolean;
      allowOversoldFade: boolean;
      allowBreakoutFollow: boolean;
      allowVReversal: boolean;
      overboughtMeaning: 'reversal' | 'momentum';
      oversoldMeaning: 'reversal' | 'momentum';
    }>;
  };

  // --- Signals ---
  signals: {
    enableRsiCrosses: boolean;
    enableHmaCrosses: boolean;
    enableEmaCrosses: boolean;
    rsiOversold: number;
    rsiOverbought: number;
    optionRsiOversold: number;
    optionRsiOverbought: number;
  };

  // --- Position ---
  position: {
    stopLossPercent: number;
    takeProfitMultiplier: number;
    maxPositionsOpen: number;
    positionSizeMultiplier: number;
    defaultQuantity: number;
  };

  // --- Risk ---
  risk: {
    maxDailyLoss: number;
    maxTradesPerDay: number;
    maxRiskPerTrade: number;
    cutoffTimeET: string;          // 'HH:MM'
    minMinutesToClose: number;
  };

  // --- Strike Selection ---
  strikeSelector: {
    strikeSearchRange: number;
    otmDistanceMin: number;
    otmDistanceMax: number;
    emergencyStrikeRange: number;
    emergencyOtmMin: number;
    emergencyOtmMax: number;
  };

  // --- Time Windows ---
  timeWindows: {
    sessionStart: string;
    sessionEnd: string;
    activeStart: string;
    activeEnd: string;
    skipWeekends: boolean;
    skipHolidays: boolean;
  };

  // --- Escalation ---
  escalation: {
    signalTriggersJudge: boolean;
    scannerTriggersJudge: boolean;
    requireScannerAgreement: boolean;
    requireSignalAgreement: boolean;
  };

  // --- Exit Rules ---
  exit: {
    trailingStopEnabled: boolean;
    trailingStopPercent: number;
    timeBasedExitEnabled: boolean;
    timeBasedExitMinutes: number;  // close N min before session end
  };

  // --- Narrative ---
  narrative: {
    buildOvernightContext: boolean;
    barHistoryDepth: number;       // how many bars to include in prompts
    trackTrajectory: boolean;
  };

  // --- Data Pipeline ---
  pipeline: {
    pollUnderlyingMs: number;
    pollOptionsRthMs: number;
    pollOptionsOvernightMs: number;
    pollScreenerMs: number;
    strikeBand: number;
    strikeInterval: number;
    gapInterpolateMaxMins: number;
    maxBarsMemory: number;
  };

  // --- Contract Tracking ---
  contracts: {
    stickyBandWidth: number;       // how far from SPX to track
    stateTransitions: boolean;     // UNSEEN→ACTIVE→STICKY→EXPIRED
  };

  // --- Market Calendar ---
  calendar: {
    holidays: string[];            // ['2026-01-01', ...]
    earlyCloseDays: string[];      // ['2026-07-02', ...]
  };
}
```

---

## Phase 2: Config Manager Rewrite

### `src/config/manager.ts` — rewrite

- Opens `data/spxer.db` (the ONE database)
- Creates tables if missing (migration on first run)
- CRUD for configs, models, prompts
- `loadForSubsystem(name)` — returns full config with models and prompts resolved
- `bindSubsystem(name, configId)` — hot-swap which config a subsystem uses
- `seedDefaults()` — populate models table with current hardcoded values, seed default config, seed prompts from prompt-library

### `src/config/schema.ts` — new file

- TypeScript interface for Config (as above)
- Validation function (replaces current validateConfig)
- Default values
- Deep merge utility

---

## Phase 3: Migration

### 3a. Merge databases

1. Add new tables to `data/spxer.db`
2. Migrate `replay_runs` and `replay_results` from `replay.db` → `spxer.db`
3. Write migration script: `scripts/migrate-to-unified-db.ts`
4. Delete `data/replay.db` references everywhere

### 3b. Seed initial data

1. Populate `models` table from current hardcoded values in `model-clients.ts`
2. Populate `prompts` table from `prompt-library.ts` + inline prompts in `judgment-engine.ts`
3. Create default configs:
   - `paper-live-v1` — from current `agent-config.ts`
   - `replay-default` — from current `DEFAULT_CONFIG`
   - Presets (aggressive, conservative, etc.) — from current `CONFIG_PRESETS`
4. Bind: `live-agent` → `paper-live-v1`, `replay` → `replay-default`

---

## Phase 4: Intercept Points (consumer rewrites)

### 4a. `src/agent/model-clients.ts`
- **Before**: Hardcoded model configs, env var overrides
- **After**: Load from `models` table. Env vars only for API keys.
- `getModel(id)` returns { baseUrl, modelName, timeoutMs, maxTokens }

### 4b. `agent.ts`
- **Before**: `import { AGENT_CONFIG }` from file
- **After**: `configManager.loadForSubsystem('live-agent')` from DB
- Remove `agent-config.ts` file entirely

### 4c. `src/agent/judgment-engine.ts`
- **Before**: Hardcoded SCANNER_SYSTEM and JUDGE_SYSTEM prompts, hardcoded scanner list
- **After**: Load prompts from `prompts` table. Scanner list from config.scanners.models.
- `assess()` takes full Config, resolves models and prompts internally

### 4d. `src/agent/regime-classifier.ts`
- **Before**: Half-refactored, broken MEAN_REVERSION branch
- **After**: All params from config.regime. Fix the missing branch. If config.regime.enabled=false, skip entirely.

### 4e. `src/agent/risk-guard.ts`
- **Before**: Reads env vars directly
- **After**: Takes config.risk section. Env vars only as fallback for backwards compat.

### 4f. `src/replay/machine.ts`
- **Before**: Takes ReplayConfig param (works), but calls own DB for bars
- **After**: Takes Config (new unified type). Loads from same DB. Uses config.regime, config.signals, etc.

### 4g. `src/replay/store.ts`
- **Before**: Opens own connection to `data/replay.db`
- **After**: Uses shared connection to `data/spxer.db`

### 4h. `src/replay/prompt-library.ts`
- **Before**: Hardcoded prompt map
- **After**: Seed script moves all prompts to DB. File becomes the seed source only (run once).

### 4i. `src/replay/config.ts`
- **Before**: DEFAULT_CONFIG + CONFIG_PRESETS + mergeConfig + validateConfig
- **After**: Seed script moves defaults/presets to DB. mergeConfig and validateConfig move to `src/config/schema.ts`.

### 4j. `src/replay/cli-config.ts`
- **Before**: Broken (22 TS errors from half-refactor)
- **After**: Rewrite to load base config from DB, apply CLI overrides, validate.

### 4k. `scripts/autoresearch/verify-metric.ts`
- **Before**: Own merge logic with DEFAULT_CONFIG
- **After**: Load config from DB, apply CLI overrides.

### 4l. `src/config.ts` (basic service config)
- **Before**: Hardcoded poll intervals, holidays, strike band, etc.
- **After**: Infrastructure stays here (port, DB path, API base URLs). Everything else moves to config.pipeline and config.calendar.

### 4m. `src/agent/signal-detector.ts` + `src/agent/price-action.ts`
- **Before**: May have hardcoded thresholds
- **After**: Read from config.signals

---

## Phase 5: Files to delete after migration

- `agent-config.ts` — replaced by DB config
- `src/config/manager.ts` — rewritten in place
- `data/replay.db` — merged into spxer.db
- `CONFIG_FIX_PLAN.md` — obsolete
- `CONFIG_REVIEW.md` — obsolete

---

## Execution Order

1. **Schema + migration script** — create tables in spxer.db, migrate replay data
2. **Config manager rewrite** — CRUD against single DB
3. **Seed script** — populate models, prompts, default configs from current hardcoded values
4. **Fix regime-classifier** — restore MEAN_REVERSION branch, make fully config-driven
5. **Rewrite model-clients** — load from models table
6. **Rewrite judgment-engine** — load prompts from DB, scanner list from config
7. **Rewrite agent.ts** — load config from DB
8. **Rewrite risk-guard** — read from config, not env vars
9. **Rewrite replay consumers** — store.ts, machine.ts, cli-config.ts
10. **Rewrite autoresearch** — verify-metric loads from DB
11. **Clean up** — delete dead files, fix remaining TS errors
12. **Test** — build passes, replay works, agent starts

---

## What stays the same

- `data/spxer.db` structure for bars and contracts (untouched)
- In-memory bar cache in replay machine (performance critical)
- Direct HTTP for all LLM calls (no SDK iterator)
- Prompt format (JSON response schema stays the same)
- API keys in .env (never in DB)
- Port, DB path in env vars (infrastructure)

---

## Risk

- spxer.db is 2.8 GB. Adding config tables is trivial (KB-scale). No risk to market data.
- Replay results migration is small (912 KB). Can be scripted safely.
- The broken half-refactor needs to be cleaned up as part of this — not separately.
