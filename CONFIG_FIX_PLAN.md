# Config System Fix Plan

**Goal**: Consolidate all configs and replay data into `spxer.db`, fix incompatible config structures, make everything DB-driven.

---

## Database Consolidation

### Current State:
```
data/
├── spxer.db (2.8GB)
│   ├── bars
│   └── contracts
└── replay.db (933KB)
    ├── replay_configs
    ├── replay_runs
    └── replay_results
```

### Target State:
```
data/
└── spxer.db (2.8GB + replay data)
    ├── bars
    ├── contracts
    ├── configs (renamed from replay_configs)
    ├── active_configs (new)
    ├── replay_runs (moved from replay.db)
    └── replay_results (moved from replay.db)
```

### Migration Steps:
1. Add `configs` table to `spxer.db` (rename from `replay_configs`)
2. Add `active_configs` table to `spxer.db`
3. Add `replay_runs` table to `spxer.db`
4. Add `replay_results` table to `spxer.db`
5. Copy data from `replay.db` to `spxer.db`
6. Backup and delete `replay.db`
7. Update all code to use `spxer.db` path

---

## Type System Fix

### Current Problem:
- Two incompatible config structures both called `ReplayConfig`
- `agent-config.ts` has wrong property names
- 22 compilation errors in `cli-config.ts`

### Solution:
1. Keep `ReplayConfig` type (don't rename, it's the right name)
2. Fix `AGENT_CONFIG` to match the `ReplayConfig` type structure
3. Delete `cli-config.ts` (obsolete with DB approach)
4. Fix minor type error in `model-clients.ts`

### Property Mappings to Fix in AGENT_CONFIG:

| Current (wrong) | Target (ReplayConfig type) |
|----------------|---------------------------|
| `signals.rsiOversold` | DELETE (use `rsi.oversoldThreshold`) |
| `signals.rsiOverbought` | DELETE (use `rsi.overboughtThreshold`) |
| `rsi` section (missing) | ADD: `rsi: { oversoldThreshold: 20, overboughtThreshold: 80 }` |
| `indicators` section (missing) | ADD: `indicators: { hma: true, ema: true, rsi: true, bollingerBands: false }` |
| `position.defaultQuantity` | DELETE (not in type) |
| `timeWindows.sessionStart` | DELETE (not in type) |
| `timeWindows.sessionEnd` | DELETE (not in type) |
| `timeWindows.skipWeekends` | DELETE (not in type) |
| `timeWindows.skipHolidays` | DELETE (not in type) |
| `judge.activeJudge` | CHANGE to: `judge.models: ['sonnet']` |
| `judge.consensusRule` | ADD: `consensusRule: 'primary-decides'` |
| `judge.confidenceThreshold` | ADD: `confidenceThreshold: 0.5` |
| `sizing` section (missing) | ADD: `sizing: { baseDollarsPerTrade: 250, ... }` |
| `exit` section (missing) | ADD: `exit: { strategy: 'takeProfit', ... }` |
| `timing` section (missing) | ADD: `timing: { tradingStartEt: '09:30', ... }` |
| `strikeSelector.otmDistanceMin` | CHANGE to: `minOtmDollar` |
| `strikeSelector.otmDistanceMax` | CHANGE to: `maxOtmDollar` |
| `strikeSelector.minOtmPoints` | ADD |
| `strikeSelector.maxOtmPoints` | ADD |

---

## Code Changes Required

### Phase 1: Database (low risk)
1. Create migration script to add tables to `spxer.db`
2. Copy data from `replay.db` to `spxer.db`
3. Update `ReplayStore` to use `spxer.db` instead of `replay.db`
4. Update `ConfigManager` to use `spxer.db` instead of `replay.db`

### Phase 2: Type System (medium risk)
1. Fix `agent-config.ts` structure to match `ReplayConfig` type
2. Delete `src/replay/cli-config.ts` (22 errors, obsolete)
3. Fix `src/agent/model-clients.ts` line 276 type error
4. Run TypeScript compile to verify no errors

### Phase 3: Integration (medium risk)
1. Update `agent.ts` to load config from `ConfigManager` instead of importing `AGENT_CONFIG`
2. Create seed script to populate `configs` table with defaults
3. Test live agent loads config from DB
4. Test replay system loads config from DB

### Phase 4: Cleanup (low risk)
1. Delete `agent-config.ts` (after seeding to DB)
2. Backup and delete `replay.db`
3. Update all documentation

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Data loss during migration | CRITICAL | Backup both databases before migration |
| Compilation breaks | HIGH | Fix types before touching DB code |
| Runtime errors from wrong properties | HIGH | Thorough testing after each phase |
| Live agent fails to start | CRITICAL | Test in dev environment first |
| Replay system breaks | MEDIUM | Test with existing replay data |

---

## Order of Execution

1. **Backup everything** (databases, code)
2. Fix compilation errors (Phase 2) - verify code compiles
3. Database migration (Phase 1) - move data, update paths
4. Integration testing (Phase 3) - verify systems work
5. Cleanup (Phase 4) - delete obsolete files

**STOP AFTER EACH PHASE AND VERIFY**

---

## Testing Checklist

- [ ] TypeScript compilation succeeds (npx tsc --noEmit)
- [ ] Backup databases created
- [ ] Migration script runs without errors
- [ ] Data copied correctly to spxer.db
- [ ] ReplayStore uses spxer.db
- [ ] ConfigManager uses spxer.db
- [ ] Live agent starts and loads config from DB
- [ ] Replay system runs and loads config from DB
- [ ] No runtime errors
- [ ] Delete replay.db only after all tests pass

---

## Rollback Plan

If anything breaks:
1. Stop all processes
2. Restore databases from backup
3. Git revert code changes
4. Investigate what went wrong
5. Fix and retry

Do NOT proceed to next phase until current phase is verified working.
