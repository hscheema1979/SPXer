// Stub for the OR-levels storage helper. The full implementation was never
// committed (deleted from working tree pre-existing this session); the
// import in src/server/replay-routes.ts was committed without it. These
// stubs return empty/no-op so the spxer service can boot. Replace with the
// real implementation when the OR-levels feature is brought back.

export function ensureOrLevelsTable(): void { /* no-op */ }

export function getOrLevel(_date: string, _orMinutes: number): null {
  return null
}

export function upsertOrLevel(
  _date: string, _orMinutes: number,
  _high: number, _low: number, _close: number,
): void { /* no-op */ }

export function getAllOrLevels(_orMinutes: number): Array<{
  date: string; orMinutes: number; high: number; low: number; close: number
}> {
  return []
}
