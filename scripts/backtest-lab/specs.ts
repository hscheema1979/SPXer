// Spec library — a JSON file store at
// scripts/autoresearch/output/backtest-lab/specs.json. The library always
// holds what was run: POST /api/run upserts the spec BEFORE the job is queued.
// Writes mkdir -p the output dir (gitignored, like the rest of autoresearch).
import * as fs from "node:fs"
import * as path from "node:path"
import { SPXER_ROOT } from "./capabilities.ts"
import type { BacktestSpec } from "./contract.ts"

const SPEC_DIR = path.join(SPXER_ROOT, "scripts/autoresearch/output/backtest-lab")
const SPEC_PATH = path.join(SPEC_DIR, "specs.json")

let cache: BacktestSpec[] | undefined

function read(): BacktestSpec[] {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"))
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = [] // missing or corrupt file = empty library, never a crash
  }
  return cache
}

function write(): void {
  try {
    fs.mkdirSync(SPEC_DIR, { recursive: true })
    fs.writeFileSync(SPEC_PATH, JSON.stringify(cache ?? [], null, 2))
  } catch (err) {
    console.error("[backtest-lab] specs write failed:", (err as Error).message)
  }
}

export function listSpecs(): BacktestSpec[] {
  return [...read()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
}

export function getSpec(id: string): BacktestSpec | undefined {
  return read().find((s) => s.id === id)
}

/** Insert-or-update, newest-updated first. Re-stamps updatedAt=now. */
export function upsertSpec(spec: BacktestSpec): BacktestSpec {
  const stamped: BacktestSpec = { ...spec, updatedAt: new Date().toISOString() }
  if (!stamped.createdAt) stamped.createdAt = stamped.updatedAt
  const all = read()
  const i = all.findIndex((s) => s.id === stamped.id)
  if (i >= 0) all[i] = stamped
  else all.push(stamped)
  write()
  return stamped
}

export function deleteSpec(id: string): boolean {
  const all = read()
  const i = all.findIndex((s) => s.id === id)
  if (i < 0) return false
  all.splice(i, 1)
  write()
  return true
}
