# Timezone Bug Fix Brief

**Date:** 2026-03-30
**Priority:** HIGH — blocks live trading
**Status:** Partially fixed (risk-guard patched, position-manager still broken)

---

## Problem

The server runs in UTC (Ubuntu VPS). Multiple places in the codebase convert between UTC and Eastern Time (ET) using fragile `toLocaleString` → `new Date()` round-trips. These silently misinterpret ET-formatted strings as UTC, causing times to be **4–5 hours off** depending on DST.

### How it manifested

The live agent hit "Past close cutoff time" at **12:27 PM ET** — it thought the 4:00 PM ET cutoff had already passed because `computeCloseCutoffTs()` was treating `16:00:00` as UTC (= 12:00 PM ET).

### Root cause

```typescript
// BROKEN — position-manager.ts line 189
private computeCloseCutoffTs(): number {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const datePart = etStr.split(', ')[0];       // "3/30/2026"
  const closeET = new Date(`${datePart} 16:00:00`);  // ← Interpreted as UTC!
  return Math.floor(closeET.getTime() / 1000);
}
```

`new Date("3/30/2026 16:00:00")` on a UTC server creates a Date at **16:00 UTC** (= 12:00 ET), not 16:00 ET (= 20:00 UTC).

---

## Current State

### Fixed (risk-guard.ts)
`risk-guard.ts` was patched mid-session on 2026-03-30 using `Intl.DateTimeFormat.formatToParts()` to compute the UTC↔ET offset dynamically:

```typescript
// FIXED — risk-guard.ts line 101
private computeCloseCutoffTs(): number {
  const now = new Date();
  const etDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const etNowMs = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
  const utcNowMs = now.getTime();
  const offsetMs = utcNowMs - etNowMs;
  const close16EtMs = Date.parse(`${etDateStr}T16:00:00`) + offsetMs;
  return Math.floor(close16EtMs / 1000);
}
```

### Still broken (position-manager.ts)
`position-manager.ts` line 189 still uses the old broken pattern. Same bug — close cutoff fires 4h early.

---

## Full Audit — All ET Timezone Patterns

| File | Line | Pattern | Status |
|------|------|---------|--------|
| `src/agent/risk-guard.ts:101` | `computeCloseCutoffTs()` | `formatToParts` offset trick | ✅ Fixed |
| `src/agent/risk-guard.ts:45` | `minutesToMarketClose()` | `toLocaleString` → split → extract h:m | ⚠️ Works (only reads time, doesn't construct Date) |
| `src/agent/risk-guard.ts:84` | cutoff time check | `toLocaleString` → split → compare h:m | ⚠️ Works (only reads time, doesn't construct Date) |
| `src/agent/position-manager.ts:189` | `computeCloseCutoffTs()` | `toLocaleString` → `new Date(datePart + " 16:00:00")` | ❌ **BROKEN** — same bug |
| `src/agent/position-manager.ts:191` | | `toLocaleString` for ET time display | ⚠️ Works (read-only) |
| `src/agent/regime-classifier.ts:133` | ET time extraction | `toLocaleString` → parse h:m | ⚠️ Works (read-only) |
| `src/agent/market-feed.ts:128` | ET time extraction | `toLocaleString` → parse h:m | ⚠️ Works (read-only) |
| `src/agent/market-feed.ts:248` | today's date in ET | `toLocaleDateString('en-CA')` | ✅ OK (returns YYYY-MM-DD string) |
| `src/agent/trade-executor.ts:77` | today's date in ET | `toLocaleDateString('en-CA')` | ✅ OK |
| `src/agent/market-narrative.ts:283,306` | time display | `toLocaleTimeString` | ✅ OK (display only) |
| `src/pipeline/scheduler.ts:14` | ET date construction | `new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))` | ⚠️ Risky — same round-trip pattern, but used for scheduling only |
| `src/pipeline/contract-tracker.ts:52,88` | ET date construction | `new Date(new Date().toLocaleString(...))` | ⚠️ Risky — same round-trip anti-pattern |
| `src/index.ts:44` | today's date | `toLocaleDateString('en-CA')` | ✅ OK |

---

## Recommended Fix

### 1. Create a shared `src/utils/et-time.ts` helper

```typescript
/**
 * Get the current UTC↔ET offset in milliseconds.
 * Handles DST automatically via Intl.DateTimeFormat.
 */
export function getETOffsetMs(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const etNowMs = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
  return now.getTime() - etNowMs;
}

/** Today's date in ET as YYYY-MM-DD */
export function todayET(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Current ET time as { h, m, s } */
export function nowET(now = new Date()): { h: number; m: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { h: Number(p.hour), m: Number(p.minute), s: Number(p.second) };
}

/** Convert an ET time (e.g., "16:00") on today's ET date to a Unix timestamp (seconds) */
export function etTimeToUnixTs(timeET: string, now = new Date()): number {
  const date = todayET(now);
  const offsetMs = getETOffsetMs(now);
  return Math.floor((Date.parse(`${date}T${timeET}:00`) + offsetMs) / 1000);
}
```

### 2. Replace all `computeCloseCutoffTs()` with the shared helper

```typescript
// risk-guard.ts and position-manager.ts
import { etTimeToUnixTs } from '../utils/et-time';

private computeCloseCutoffTs(): number {
  return etTimeToUnixTs('16:00');
}
```

### 3. Replace fragile `toLocaleString` → `new Date()` round-trips

Target: `scheduler.ts:14`, `contract-tracker.ts:52,88`. Use `nowET()` or `getETOffsetMs()` instead of `new Date(date.toLocaleString(...))`.

### 4. Add a test

```typescript
// Verify ET conversion is correct regardless of server timezone
test('etTimeToUnixTs returns correct UTC timestamp for 16:00 ET', () => {
  const ts = etTimeToUnixTs('16:00');
  const d = new Date(ts * 1000);
  const etHour = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  expect(etHour).toBe(16);
});
```

---

## Scope

- **Immediate**: Fix `position-manager.ts:189` (same pattern as risk-guard fix)
- **Short-term**: Extract `src/utils/et-time.ts`, replace all 12 call sites
- **Test**: Unit test for the helper + integration test that `computeCloseCutoffTs()` returns correct value regardless of server TZ
- **Estimated effort**: 1–2 hours
