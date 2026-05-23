# Code Review: SPXer Branch (feat/shorts-fresh-fill-study) — 2026-05-22

## Executive Summary

This branch is in **active refactoring** state. The codebase has undergone major deletions of live trading services (event handler, position monitor, data service, Schwaber) to focus exclusively on the replay/backtest system and EOD pipeline. While the core replay logic is sound, there are **15 TypeScript compilation errors**, **27 failing tests**, and **several critical type mismatches** that must be resolved before the code can be deployed.

**Status**: 🟠 **BLOCKED** — Requires fixes to compile and pass tests.

---

## Critical Issues (Must Fix)

### 1. **TypeScript Compilation Failures (15 errors)**

**Files**: `src/server/replay-routes.ts` (12 errors), `src/server/replay-server.ts` (1 error), `src/server/sweep-manager-routes.ts` (2 errors)

#### Issue 1.1: Function Signature Mismatch in `or-levels.ts`

**File**: `src/storage/or-levels.ts` is a **stub** with incorrect signatures.

```typescript
// Current (stub):
export function ensureOrLevelsTable(): void { }
export function getOrLevel(_date: string, _orMinutes: number): null { return null }
export function upsertOrLevel(_date: string, _orMinutes: number, _high: number, _low: number, _close: number): void { }

// Called as (replay-routes.ts:369):
ensureOrLevelsTable(_initDb)                              // ← expects 0 args, got 1 (db parameter)
ensurePivotLevelsTable(_initDb)                           // ← expects 0 args, got 1
getOrLevel(rdb, date, orMinutes)                          // ← expects 2 args, got 3
upsertOrLevel(wdb, level)                                 // ← expects 5 args, got 2 (takes single object)
```

**Fix**: Either:
- **Option A** (Recommended): Restore full OR-levels implementation from git history or previous commit
- **Option B** (Quick fix): Update stubs to match actual call sites
  ```typescript
  export function ensureOrLevelsTable(db: Database): void { /* ... */ }
  export function getOrLevel(db: Database, date: string, orMinutes: number): any | null { /* ... */ }
  export function upsertOrLevel(db: Database, level: any): void { /* ... */ }
  export function ensurePivotLevelsTable(db: Database): void { /* ... */ }
  ```

#### Issue 1.2: Missing `config` Property on `Config` Type

**File**: `src/server/replay-server.ts:50`

```typescript
// Line 50:
res.json({ config: sessionConfig.config });  // ← config doesn't exist on sessionConfig

// Likely should be:
res.json(sessionConfig);  // or
res.json({ config: sessionConfig });
```

**Fix**: Check what `sessionConfig` actually contains and adjust the response structure.

#### Issue 1.3: `string | string[]` Parameter Type Mismatch

**Files**: `src/server/sweep-manager-routes.ts:321, 341, 346`

```typescript
// Error: `req.query` returns `string | string[]`
const configIds = req.query.configIds as string;  // ← but assigned as string | string[]
```

**Fix**: Handle array case properly:
```typescript
const configIds = Array.isArray(req.query.configIds) 
  ? req.query.configIds.join(',') 
  : (req.query.configIds as string);
```

#### Issue 1.4: Undefined Parameter Handling

**Files**: `src/server/replay-routes.ts:2881, 3163, 3173, 3208`

```typescript
// Line 2881: profileId is string | undefined
const profileId = req.query.profileId as string;  // ← TypeScript complains it might be undefined
```

**Fix**: Add null checks:
```typescript
const profileId = req.query.profileId as string | undefined;
if (!profileId) return res.status(400).json({ error: 'profileId required' });
```

---

### 2. **Test Failures (27 failing tests)**

**Impact**: Tests cover critical paths and indicate real bugs, not just test infra issues.

```
Test Files: 3 failed | 35 passed (38 total)
Tests: 27 failed | 450 passed (477 total)
```

**Failing test areas** (from test output):
- `tests/server/admin-routes.test.ts` — Config grouped endpoint test failing (expecting 6 sections, getting 404)
- Database/storage tests likely failing due to OR-levels stub

**Action**: Run `npm run test` with `--reporter=verbose` to identify root causes and fix incrementally.

---

### 3. **Deleted Live Trading Services**

**Files deleted on this branch**:
- `event_handler_mvp.ts` — Event-driven trading agent (CRITICAL)
- `position_monitor.ts` — Exit observer
- `spx_agent.ts` — Legacy polling agent
- `schwaber.ts` — Schwab ETF trader
- `src/agent/account-balance.ts`, `account-stream.ts`, `position-order-manager.ts`, etc.
- `src/index.ts` — Data service entry point
- `src/dashboard/server.ts` — Live trading dashboard

**Status**: These are **not** deleted from `master` branch, only from this feature branch. Before merging, verify whether the intent is to:
- Keep deletions (live trading service no longer needed)
- Restore them (they'll be needed for live trading)
- Move them to archive

**Current code assumes these don't exist** — `package.json` has no `npm run handler`, `npm run agent`, or `npm run dev` scripts.

---

## High-Priority Issues

### 4. **Missing Implementations (Stubbed Out)**

| File | Issue | Fix |
|------|-------|-----|
| `src/storage/or-levels.ts` | Full stub, no-op functions | Restore or implement properly |
| `src/storage/pivot-levels.ts` | Likely also stubbed | Verify and restore |
| `src/pipeline/indicator-engine.ts` | Re-export shim to core | Verify tier 1/2 split is correct |

---

### 5. **Architecture Debt**

#### 5.1 Replay Routes Complexity (3000+ lines)

**File**: `src/server/replay-routes.ts`

- **Line count**: 3400+ lines in a single file
- **Concerns**: Routes, business logic, DuckDB queries, date manipulation, OR/pivot level computation all mixed
- **Impact**: Hard to test, maintain, and reason about

**Recommendation**: Split into:
- `replay-routes-core.ts` — API route handlers
- `replay-query.ts` — Database queries
- `replay-levels.ts` — OR/pivot level computation
- `replay-dates.ts` — Date discovery and calendar logic

#### 5.2 Config Type Inconsistencies

**File**: `src/config/types.ts` vs `src/replay/types.ts`

- Two slightly different `Config` types that should be unified
- Some places use `ReplayConfig`, others use `Config`

**Action**: Use a single `Config` type throughout.

#### 5.3 Indicator Computation Split

**Files**: `src/pipeline/indicator-engine.ts` (re-export) vs `src/core/indicator-engine.ts` (real logic) vs `src/pipeline/indicators/tier1.ts` and `tier2.ts`

- Hard to understand which file owns indicator logic
- Tier 1 and Tier 2 split exists but isn't clearly documented

**Action**: Document the indicator architecture clearly in CLAUDE.md.

---

## Medium-Priority Issues

### 6. **Type Safety Gaps**

#### 6.1 Loose `any` Types

```typescript
// src/replay/machine.ts
const loadBarCacheFromParquetSync: ((opts: any) => any) | undefined;
// Better:
interface BarCacheLoadOpts { profileId: string; date: string; /* ... */ }
interface BarCacheResult { spxBars: Bar[]; contractBars: Map<...> }
const loadBarCacheFromParquetSync: ((opts: BarCacheLoadOpts) => BarCacheResult) | undefined;
```

#### 6.2 Null/Undefined Handling

Many functions accept optional parameters but don't validate at entry:
```typescript
// Current:
function foo(date: string | undefined) { /* assumes it's defined */ }

// Better:
function foo(date: string) { /* requires valid input */ }
// Caller validates: if (!date) return error;
```

### 7. **Error Handling Gaps**

- Many try/catch blocks catch errors but only log or re-throw
- No structured error codes or error classes for specific failure modes
- HTTP error responses sometimes return `{ error: string }`, sometimes `{ message: string }`

**Action**: Define an `AppError` type with structured error codes.

---

## Low-Priority Issues

### 8. **Documentation**

- CLAUDE.md describes live trading services that no longer exist (event handler, data service)
- README is absent
- Architecture diagrams missing

### 9. **Code Quality**

- Some files have no comments; others have outdated ones
- Inconsistent naming (`tm`, `db`, `rdb`, `dataDb`, `getDb()`)
- Magic numbers scattered throughout (e.g., `9 * 3600` for market open)

### 10. **Build/Deployment**

- `npm run build` doesn't work (TypeScript errors)
- No CI/CD configuration visible
- No pre-commit hooks to catch errors before commit

---

## Testing Status

### Test Coverage

```
Files: 38 test files
Tests: 477 total (450 passing, 27 failing)
Pass rate: 94.3%
```

**Healthy**: Core logic tests pass (indicator-engine, signal-detector, position-manager all passing)
**Unhealthy**: Server/admin routes and some replay routes failing due to stub implementations

### Missing Test Coverage

- [ ] Full replay machine integration (dates, configs, trades)
- [ ] Sweep generation and aggregation
- [ ] OR/pivot level computation
- [ ] BRC cache file I/O
- [ ] Multi-instrument replay (SPX + NDX + SPY in same run)

---

## Recommendations (Priority Order)

### Tier 1: Must Do (Blocking)

1. **Fix OR-levels signatures** — Most critical, blocks compilation
   - Decision: Restore from git history or implement stub compatibility
   - Time: 30 min

2. **Fix Config type property** — Unblocks server tests
   - Check `sessionConfig` shape and adjust response
   - Time: 15 min

3. **Add null checks for query parameters** — Unblocks compilation
   - Systematic pass through replay-routes.ts
   - Time: 45 min

4. **Run tests and fix failures** — Ensures code works
   - Identify root causes of 27 failing tests
   - Fix systematically (likely all related to OR-levels stub)
   - Time: 1–2 hours

### Tier 2: Should Do (Quality)

5. **Split replay-routes.ts** — Improves maintainability
   - 3400+ lines is unmaintainable
   - Time: 2–3 hours

6. **Clarify indicator architecture** — Improves understanding
   - Document which file owns what in CLAUDE.md
   - Time: 30 min

7. **Define structured error types** — Prevents bugs
   - Create `AppError` with structured codes
   - Time: 1 hour

### Tier 3: Nice to Have (Polish)

8. **Add pre-commit hooks** — Prevents future issues
   - Compile check, test run
   - Time: 30 min

9. **Update CLAUDE.md** — Reflects current state
   - Remove deleted services section
   - Add current architecture
   - Time: 1 hour

10. **Add README** — Onboarding
    - Quick start guide for local dev
    - Time: 1 hour

---

## Dependency Review

**Safe to Use**:
- `better-sqlite3` — mature, well-maintained
- `express` — industry standard
- `vitest` — modern, good TypeScript support

**Concerning**:
- `@anthropic-ai/claude-agent-sdk` — v0.2.79 is beta, may have breaking changes
- `duckdb-async` — optional, used only for parquet; consider moving to `@duckdb/node-api` which is more stable

---

## Final Verdict

**Branch Status**: 🟠 **Not Production Ready**

**Blockers**:
- ❌ Code doesn't compile (15 TS errors)
- ❌ 27 tests failing
- ❌ Critical function signature mismatches

**Next Steps**:
1. Fix compilation errors (Tier 1 items above)
2. Pass all tests
3. Code review of changes after fixes
4. Merge to feature branch, then to master after validation

**Estimated Time to Production Ready**: 4–6 hours (Tier 1 + Tier 2)

---

## Appendix: Files Reviewed

- `src/replay/machine.ts` — Core replay engine (good)
- `src/server/replay-routes.ts` — API routes (needs splitting, has errors)
- `src/storage/or-levels.ts` — Stubbed out
- `src/config/types.ts` — Config types
- `src/core/signal-detector.ts` — Signal logic (good)
- `src/core/position-manager.ts` — Exit logic (good)
- `src/core/strike-selector.ts` — Strike selection (good)
- `src/pipeline/indicator-engine.ts` — Indicator wrapper
- `src/pipeline/indicators/tier1.ts` — Tier 1 indicators
- `package.json` — Build and test scripts

---

**Generated**: 2026-05-22 18:05 UTC
**Reviewer**: Claude Code
**Branch**: feat/shorts-fresh-fill-study
