// Stub for the pivot-levels storage helper. Like or-levels.ts, the real
// implementation was never committed (uncommitted deletion left the import
// in replay-routes.ts dangling). Returns null/no-op so spxer can boot.
// Replace with the real implementation when the pivot-levels feature is
// brought back.

export function ensurePivotLevelsTable(): void { /* no-op */ }

export function getPivotLevel(_date: string): null {
  return null
}
