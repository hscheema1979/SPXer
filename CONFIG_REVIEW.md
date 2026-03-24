# Config System Code Review & Impact Analysis

**Date**: 2026-03-24
**Status**: CRITICAL - Two incompatible config structures + wrong DB architecture

---

## Executive Summary

The codebase has **THREE ARCHITECTURAL PROBLEMS**:

1. **Two incompatible config structures** both claiming to implement `ReplayConfig`
2. **Config storage in wrong database** - `replay_configs` table is in `replay.db` (should be separate)
3. **Hardcoded configs** - `agent-config.ts` has hardcoded values instead of loading from DB

1. **`agent-config.ts`** - Live agent config (WRONG structure for ReplayConfig type)
2. **`src/replay/config.ts`** - Replay system config (CORRECT structure for ReplayConfig type)

This mismatch causes:
- 22 TypeScript compilation errors in `cli-config.ts`
- Incompatible property names throughout codebase
- Configs cannot be shared between live agent and replay system
- **Configs stored in wrong database** (`replay.db` instead of dedicated `configs.db`)

---

## Database Architecture Issues

### Current (WRONG):
```
data/
├── replay.db          # Has BOTH configs AND replay results ❌
│   ├── replay_configs
│   ├── replay_runs
│   └── replay_results
└── spxer.db           # Market data only
```

### Target (CORRECT):
```
data/
├── configs.db         # Config storage ONLY ✅
│   ├── configs
│   └── active_configs (which service uses which config)
├── replay.db          # Replay results ONLY ✅
│   ├── replay_runs
│   └── replay_results
└── spxer.db           # Market data only
```

### Why Separate?
1. **Single responsibility**: `configs.db` manages configs, `replay.db` manages results
2. **Multiple systems can share configs**: Live agent, replay, autoresearch all read from same `configs.db`
3. **Independent operations**: Can backup/migrate configs without touching replay data
4. **Cleaner schema**: No foreign keys from replay_runs to configs in different database

---

## Structural Incompatibilities

### Property Mapping: AGENT_CONFIG vs ReplayConfig Type

| ReplayConfig Type (correct) | AGENT_CONFIG (wrong) | Impact |
|---------------------------|---------------------|--------|
| `rsi.oversoldThreshold` | `signals.rsiOversold` | ❌ Missing property, wrong location |
| `rsi.overboughtThreshold` | `signals.rsiOverbought` | ❌ Missing property, wrong location |
| `indicators.*` | *(doesn't exist)* | ❌ Missing entire section |
| `signals.optionRsiOversold` | `signals.optionRsiOversold` | ✅ Matches |
| `position.maxPositionsOpen` | `position.maxPositionsOpen` | ✅ Matches |
| `position.positionSizeMultiplier` | *(doesn't exist)* | ❌ Missing |
| `timing.*` | `timeWindows.*` | ❌ Wrong name |
| `judge.models[]` | `judge.activeJudge` (string) | ❌ Wrong type |
| `judge.consensusRule` | *(doesn't exist)* | ❌ Missing |
| `judge.confidenceThreshold` | *(doesn't exist)* | ❌ Missing |
| `sizing.*` | *(doesn't exist)* | ❌ Missing entire section |
| `exit.*` | *(doesn't exist)* | ❌ Missing entire section |
| `strikeSelector.minOtmDollar` | `strikeSelector.otmDistanceMin` | ❌ Wrong name |
| `strikeSelector.maxOtmDollar` | `strikeSelector.otmDistanceMax` | ❌ Wrong name |
| `strikeSelector.minOtmPoints` | *(doesn't exist)* | ❌ Missing |
| `strikeSelector.maxOtmPoints` | *(doesn't exist)* | ❌ Missing |
| `position.defaultQuantity` | *(doesn't exist in ReplayConfig)* | ⚠️ Extra property |
| `timeWindows.sessionStart` | *(doesn't exist in ReplayConfig)* | ⚠️ Extra property |
| `timeWindows.sessionEnd` | *(doesn't exist in ReplayConfig)* | ⚠️ Extra property |
| `timeWindows.skipWeekends` | *(doesn't exist in ReplayConfig)* | ⚠️ Extra property |
| `timeWindows.skipHolidays` | *(doesn't exist in ReplayConfig)* | ⚠️ Extra property |

---

## Files Requiring Changes

### Phase 1: Type Definition (1 file)

| File | Action | Details |
|------|--------|---------|
| `src/replay/types.ts` | Rename `ReplayConfig` → `Config` | Universal config type for all systems |

### Phase 2: Core Config Files (3 files)

| File | Action | Details |
|------|--------|---------|
| `agent-config.ts` | DELETE | Migrate defaults to DB seed, remove file |
| `src/replay/config.ts` | UPDATE | Rename ReplayConfig → Config, fix DEFAULT_CONFIG |
| `src/config.ts` | REVIEW | Data pipeline config (Portainer), separate system |

### Phase 3: DB/Storage (3 files, 1 new)

| File | Action | Details |
|------|--------|---------|
| `src/replay/store.ts` | UPDATE | Remove replay_configs table, keep only runs/results |
| `src/config/manager.ts` | REWRITE | Use new `configs.db` instead of `replay.db` |
| `src/config/store.ts` | CREATE | New ConfigStore class for configs.db |
| `data/configs.db` | CREATE | New database for config storage only |

### Phase 4: Live Agent (1 file)

| File | Action | Details |
|------|--------|---------|
| `agent.ts` | UPDATE | Remove AGENT_CONFIG import, load from ConfigManager |

### Phase 5: Regime System (2 files)

| File | Action | Details |
|------|--------|---------|
| `src/agent/regime-classifier.ts` | NO CHANGE | Already uses config.regime correctly |
| `src/agent/judgment-engine.ts` | NO CHANGE | Already uses config.regime correctly |

### Phase 6: Replay System (5 files)

| File | Action | Details |
|------|--------|---------|
| `src/replay/config.ts` | UPDATE | Rename ReplayConfig → Config |
| `src/replay/machine.ts` | UPDATE | Rename ReplayConfig → Config |
| `src/replay/cli-config.ts` | DELETE OR FIX | 22 errors, old property names - recommend DELETE |
| `src/replay/index.ts` | UPDATE | Update exports |
| `src/replay/store.ts` | UPDATE | Update type imports |

### Phase 7: Scripts (12 files)

| File | Action | Details |
|------|--------|---------|
| `scripts/autoresearch/param-search.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/autoresearch/verify-metric.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/backtest/run-replay.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/backtest/replay-machine.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/backtest/replay-configurator.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/backtest/run-questionnaire-configs.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/backtest/example-replay-workflow.ts` | UPDATE | Rename ReplayConfig → Config |
| `scripts/backtest/*.ts` (other) | REVIEW | Check for ReplayConfig usage |

---

## Detailed Fix Plan

### Step 1: Rename Type (1 file)

```typescript
// src/replay/types.ts
export interface Config {  // was ReplayConfig
  id: string;
  name: string;
  // ... rest of properties
}
```

### Step 2: Update All Type Imports (17 files)

```bash
# Global find/replace
# Old: import type { ReplayConfig } from './types';
# New: import type { Config } from './types';
```

Files affected:
- src/replay/config.ts
- src/replay/store.ts
- src/replay/machine.ts
- src/replay/cli-config.ts (or DELETE)
- src/config/manager.ts
- agent-config.ts (or DELETE)
- agent.ts
- scripts/autoresearch/param-search.ts
- scripts/autoresearch/verify-metric.ts
- scripts/backtest/run-replay.ts
- scripts/backtest/replay-machine.ts
- scripts/backtest/replay-configurator.ts
- scripts/backtest/run-questionnaire-configs.ts
- scripts/backtest/example-replay-workflow.ts

### Step 3: Fix AGENT_CONFIG Structure Mismatch

**Option A: Update ReplayConfig type to include AGENT_CONFIG properties**
- Add `position.defaultQuantity`
- Add `timeWindows.sessionStart`, `timeWindows.sessionEnd`
- Add `timeWindows.skipWeekends`, `timeWindows.skipHolidays`
- Change `strikeSelector.minOtmDollar` ↔ `otmDistanceMin`
- Add `judge.activeJudge` as alias for `primaryModel`

**Option B: Update AGENT_CONFIG to match ReplayConfig (RECOMMENDED)**
- Move `rsiOversold`/`rsiOverbought` to `rsi.oversoldThreshold`/`rsi.overboughtThreshold`
- Add `indicators.*` section
- Change `judge.activeJudge` to `judge.models: ['sonnet']`
- Add missing `judge.consensusRule`, `judge.confidenceThreshold`
- Add `sizing.*` section
- Add `exit.*` section
- Rename `timeWindows` → `timing` or merge into existing
- Remove extra properties not in type

### Step 4: Delete or Fix cli-config.ts

**RECOMMEND: DELETE** - 22 errors, obsolete once we have DB-based configs

```bash
rm /home/ubuntu/SPXer/src/replay/cli-config.ts
```

### Step 5: Fix Compilation Errors

1. **model-clients.ts line 276**: Add type assertion
   ```typescript
   return (data as any).content?.[0]?.text || '';
   ```

2. **All ReplayConfig → Config renames**: Global find/replace

### Step 6: Create Separate Config Database

```sql
-- data/configs.db (NEW DATABASE)
CREATE TABLE configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config_json TEXT NOT NULL,  -- Full Config object as JSON
  baseline_config_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE active_configs (
  service_name TEXT PRIMARY KEY,  -- e.g., 'agent', 'replay-1', 'autoresearch'
  config_id TEXT NOT NULL,
  loaded_at INTEGER NOT NULL,
  FOREIGN KEY(config_id) REFERENCES configs(id)
);

CREATE INDEX idx_active_loaded ON active_configs(loaded_at);
```

### Step 7: Migrate Existing Data

```bash
# 1. Export configs from replay.db
sqlite3 data/replay.db "SELECT * FROM replay_configs" > /tmp/configs_export.csv

# 2. Import to new configs.db
# (Use migration script)

# 3. Remove replay_configs table from replay.db
sqlite3 data/replay.db "DROP TABLE replay_configs;"
```

### Step 8: Update ReplayStore

```typescript
// src/replay/store.ts - REMOVE config methods
- saveConfig()
- getConfig()
- listConfigs()
- deleteConfig()

// Keep ONLY replay-related methods:
+ createRun()
+ completeRun()
+ failRun()
+ saveResult()
// etc.
```

### Step 9: Create New ConfigStore

```typescript
// src/config/store.ts (NEW FILE)
export class ConfigStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || 'data/configs.db');
    this.initTables();
  }

  private initTables() {
    // Creates configs + active_configs tables
  }

  saveConfig(config: Config) { /* ... */ }
  getConfig(id: string): Config | null { /* ... */ }
  listConfigs(): Config[] { /* ... */ }
  deleteConfig(id: string) { /* ... */ }
  deriveConfig(baseId: string, newId: string, overrides: Partial<Config>): Config { /* ... */ }

  // Service tracking
  registerActiveService(serviceName: string, configId: string) { /* ... */ }
  getActiveServiceConfig(serviceName: string): string | null { /* ... */ }
  listActiveServices() { /* ... */ }
}
```

### Step 10: Update ConfigManager to Use ConfigStore

```typescript
// src/config/manager.ts
import { ConfigStore } from './store';

export class ConfigManager {
  private store: ConfigStore;

  constructor(dbPath?: string) {
    this.store = new ConfigStore(dbPath);
  }

  // Delegate to ConfigStore
  saveConfig(config: Config) => this.store.saveConfig(config);
  getConfig(id: string) => this.store.getConfig(id);
  // ... etc
}
```

### Step 11: Integrate ConfigManager

1. **Create seed script**: `scripts/seed-configs.ts`
   - Loads defaults from `src/replay/config.ts`
   - Loads agent config from `agent-config.ts` (before deletion)
   - Saves to `replay.db` via ConfigManager

2. **Update agent.ts**:
   ```typescript
   // Old
   import { AGENT_CONFIG } from './agent-config';
   result = await assess(snap, positions.getAll(), guard, narratives, AGENT_CONFIG.regime);

   // New
   const configManager = getConfigManager();
   const config = configManager.getOrCreateDefaultAgentConfig();
   result = await assess(snap, positions.getAll(), guard, narratives, config.regime);
   ```

3. **Add env var support**:
   ```bash
   # .env
   AGENT_CONFIG_ID=agent-default  # or custom config ID
   ```

---

## Testing Checklist

- [ ] TypeScript compilation succeeds (npx tsc --noEmit)
- [ ] Live agent loads config from DB
- [ ] Replay system loads config from DB
- [ ] Both can run in parallel with different configs
- [ ] Regime system works with config-driven parameters
- [ ] Autoresearch scripts work with new Config type
- [ ] Backtest scripts work with new Config type
- [ ] ConfigManager can save/load/derive configs

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking existing scripts | HIGH | Test all scripts after change |
| DB migration needed | MEDIUM | replay.db already has correct schema |
| Runtime errors from missing properties | HIGH | Thorough testing, gradual rollout |
| Config incompatibility between systems | CRITICAL | This is what we're fixing |

---

## Estimated Effort

- Phase 1 (Type rename): 30 min
- Phase 2 (Core config): 1 hour
- Phase 3 (DB/Storage): 30 min
- Phase 4 (Live agent): 30 min
- Phase 5 (Regime): 0 min (already done)
- Phase 6 (Replay): 1 hour
- Phase 7 (Scripts): 1 hour
- Testing: 1 hour

**Total**: ~5 hours

---

## Decision Points

1. **Keep or delete `cli-config.ts`?**
   - Recommend: DELETE (22 errors, obsolete with DB approach)

2. **Unified Config type name: `Config` or `TradingConfig`?**
   - Recommend: `Config` (simple, universal)

3. **How to handle `AGENT_CONFIG` properties not in `ReplayConfig`?**
   - Option A: Extend ReplayConfig type
   - Option B: Update AGENT_CONFIG to match type
   - Recommend: **Option B** - keep type minimal, match existing structure

4. **Migration strategy:**
   - Option A: Big bang (all changes at once)
   - Option B: Gradual (fix compilation first, refactor later)
   - Recommend: **Option B** - fix compilation errors first, then integrate ConfigManager
