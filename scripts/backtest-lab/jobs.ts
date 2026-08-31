// Job runner — in-memory map + persistent history, FIFO queue with per-engine
// concurrency 1. The engines are long CLI jobs (a sweep regen is a sharded,
// hours-long run), so the lab serializes each engine class independently:
// two shares runs never block a sweep, but two sweeps queue behind each other.
//
// History lives at scripts/autoresearch/output/backtest-lab/jobs-history.json
// (capped, newest-first) and is loaded at boot so the studio sees past runs
// after a restart.
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { specLabel, specToRunRequest, type BacktestSpec } from "./contract.ts"
import { SPXER_ROOT } from "./capabilities.ts"
import { buildSpawn, type SpawnPlan } from "./engines.ts"

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled"
export type EngineKind = "shares" | "long-option" | "sweep-regen"

export interface LabJobResult {
  kpis?: { n?: number; wr?: number; pnl?: number; avgPnl?: number; dd?: number }
  artifactPath?: string
  deepLink?: string
}

export interface LabJob {
  jobId: string
  specId: string
  engine: EngineKind
  status: JobStatus
  spec: BacktestSpec
  /** specLabel() of the spec — stable for tables. */
  label: string
  startedAt?: string
  endedAt?: string
  error?: string
  /** Ring buffer (tail) of combined engine output. */
  log?: string
  result?: LabJobResult
}

const LAB_DIR = path.join(SPXER_ROOT, "scripts/autoresearch/output/backtest-lab")
const HISTORY_PATH = path.join(LAB_DIR, "jobs-history.json")
const HISTORY_CAP = 500
const LOG_CAP_BYTES = 200 * 1024

const jobs = new Map<string, LabJob>()
const queues: Record<EngineKind, LabJob[]> = { shares: [], "long-option": [], "sweep-regen": [] }
const running: Record<EngineKind, ChildProcess | undefined> = {
  shares: undefined, "long-option": undefined, "sweep-regen": undefined,
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Persistence ─────────────────────────────────────────────────────────────

function persist(): void {
  const all = [...jobs.values()]
  all.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
  const trimmed = all.slice(0, HISTORY_CAP)
  try {
    fs.mkdirSync(LAB_DIR, { recursive: true })
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2))
  } catch (err) {
    console.error("[backtest-lab] history write failed:", (err as Error).message)
  }
}

function loadHistory(): void {
  let raw: string
  try {
    raw = fs.readFileSync(HISTORY_PATH, "utf8")
  } catch {
    return // first boot — nothing to restore
  }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    for (const j of parsed as LabJob[]) {
      if (!j?.jobId) continue
      // A job that claims to be mid-flight was killed by the restart: mark it
      // honestly rather than let the UI poll a zombie forever.
      if (j.status === "queued" || j.status === "running") {
        j.status = "failed"
        j.error = "service restarted before this job finished"
        j.endedAt = new Date().toISOString()
      }
      jobs.set(j.jobId, j)
    }
  } catch (err) {
    console.error("[backtest-lab] history parse failed:", (err as Error).message)
  }
}

// ── Log ring buffer ─────────────────────────────────────────────────────────

function appendLog(job: LabJob, chunk: string): void {
  job.log = (job.log ?? "") + chunk
  if (job.log.length > LOG_CAP_BYTES) job.log = job.log.slice(-LOG_CAP_BYTES)
}

// ── Result folding ──────────────────────────────────────────────────────────

/** resolveSymbolTarget outSuffix rule: SPX 0DTE keeps the legacy bare name. */
function sweepOutSuffix(symbol: string, dte: number): string {
  const s = symbol.toLowerCase()
  if (s === "spx" && dte === 0) return ""
  return `-${s}${dte === 0 ? "" : `-${dte}dte`}`
}

/**
 * Last stdout line is the engine result contract. Only exit 0 jobs reach here.
 * Field names are the engines OWN (summary.trades / summary.totalPnl / …) —
 * renaming them here would silently break the KPIs the studio displays.
 */
function foldResult(engine: EngineKind, spec: BacktestSpec, stdout: string, outputPaths: string[]): LabJobResult {
  const lastLine = [...stdout.split("\n")].reverse().find((l) => l.trim().length > 0) ?? ""
  if (engine === "sweep-regen") {
    return { deepLink: `/dashboard/spreads?profile=${sweepOutSuffix(spec.underlying.symbol, spec.underlying.dte as number)}` }
  }
  let parsed: any
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    return {}
  }
  if (engine === "shares") {
    const s = parsed?.summary
    if (!s) return { artifactPath: outputPaths[0] }
    return {
      kpis: {
        n: s.trades,
        wr: s.winRate,
        pnl: s.totalPnl,
        avgPnl: s.avgPnlPerTrade,
        dd: s.maxDrawdown,
      },
      artifactPath: outputPaths[0],
    }
  }
  // long-option: last line is { configId, row }
  const r = parsed?.row
  if (!r) return {}
  return { kpis: { n: r.n, wr: r.wr, pnl: r.pnl, dd: r.dd } }
}

// ── Queue ───────────────────────────────────────────────────────────────────

function pump(engine: EngineKind): void {
  if (running[engine]) return // per-engine concurrency 1
  const job = queues[engine].shift()
  if (!job) return
  job.status = "running"
  job.startedAt = new Date().toISOString()
  const plan = buildSpawn(specToRunRequest(job.spec), job.jobId)
  let stdout = ""
  let stderr = ""
  let child: ChildProcess
  try {
    // detached + group kill: `npx tsx` is two processes deep, and killing only
    // the npx wrapper orphans the engine (it reparents to init and keeps
    // running — the FR-001 leak class sweep-parallel.ts guards against).
    child = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // child leads its own process group
    })
  } catch (err) {
    job.status = "failed"; job.error = `spawn failed: ${(err as Error).message}`
    job.endedAt = new Date().toISOString()
    appendLog(job, `[lab] spawn failed: ${(err as Error).message}\n`)
    persist(); setImmediate(() => pump(engine))
    return
  }
  running[engine] = child
  persist()
  appendLog(job, `[lab] ${new Date().toISOString()} $ ${plan.cmd} ${plan.args.join(" ")} (cwd=${plan.cwd})\n`)
  child.stdout?.on("data", (d) => {
    const s = String(d)
    stdout += s
    if (stdout.length > 2 * LOG_CAP_BYTES) stdout = stdout.slice(-2 * LOG_CAP_BYTES)
    appendLog(job, s)
  })
  child.stderr?.on("data", (d) => {
    const s = String(d)
    stderr += s
    if (stderr.length > 2 * LOG_CAP_BYTES) stderr = stderr.slice(-2 * LOG_CAP_BYTES)
    appendLog(job, s)
  })
  child.on("error", (err) => {
    job.status = "failed"
    job.error = `engine failed to start: ${err.message}`
    job.endedAt = new Date().toISOString()
    appendLog(job, `[lab] error: ${err.message}\n`)
    persist()
    running[engine] = undefined
    setImmediate(() => pump(engine))
  })
  child.on("close", (code) => {
    running[engine] = undefined
    // cancelJob already marked it — a SIGTERM'd child exits non-zero and must
    // not be re-labelled "failed" over the caller's "cancelled".
    if (job.status === "cancelled") {
      appendLog(job, "[lab] engine exited after cancel\n")
      persist()
      setImmediate(() => pump(engine))
      return
    }
    job.endedAt = new Date().toISOString()
    if (code === 0) {
      job.status = "completed"
      job.result = foldResult(engine, job.spec, stdout, plan.outputPaths)
      if (engine === "long-option" && !job.spec.exit.tp) {
        appendLog(job, "[lab] note: spec had no TP — the engine default --tp 25 applied\n")
      }
      appendLog(job, `[lab] ${job.endedAt} completed\n`)
    } else {
      job.status = "failed"
      job.error = `engine exited ${code}: ${stderrTail(stderr)}`
      appendLog(job, `[lab] ${job.endedAt} FAILED exit ${code}\n${stderrTail(stderr)}\n`)
    }
    persist()
    setImmediate(() => pump(engine))
  })
}

function stderrTail(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.trim().length > 0)
  if (!lines.length) return "(no stderr)"
  return lines.slice(-3).join(" | ").slice(0, 400)
}

// ── Public API ──────────────────────────────────────────────────────────────

export function initJobs(): void {
  loadHistory()
}

/** Queue a validated spec. The caller has already upserted it into specs.json. */
export function enqueueJob(spec: BacktestSpec): LabJob {
  const engine = (spec.type === "option-sweep" ? "sweep-regen" : spec.type) as EngineKind
  const job: LabJob = {
    jobId: newId("job"),
    specId: spec.id,
    engine,
    status: "queued",
    spec,
    label: specLabel(spec),
  }
  jobs.set(job.jobId, job)
  queues[engine].push(job)
  persist()
  setImmediate(() => pump(engine))
  return job
}

/** Newest first, log tails stripped (they are 200KB each — list must stay light). */
export function listJobs(limit = 50): LabJob[] {
  const all = [...jobs.values()]
  all.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
  return all.slice(0, limit).map((j) => {
    const { log, ...rest } = j
    return { ...rest }
  })
}

export function getJob(jobId: string): LabJob | undefined {
  return jobs.get(jobId)
}

/** SIGTERM a live job; queued jobs are dropped in place. Terminal jobs: no-op. */
export function cancelJob(jobId: string): LabJob | undefined {
  const job = jobs.get(jobId)
  if (!job) return undefined
  if (job.status === "queued") {
    const q = queues[job.engine]
    const i = q.indexOf(job)
    if (i >= 0) q.splice(i, 1)
    job.status = "cancelled"
    job.endedAt = new Date().toISOString()
    appendLog(job, "[lab] cancelled while queued\n")
    persist()
    return job
  }
  if (job.status !== "running") return job // terminal — nothing to signal
  const child = running[job.engine]
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM") // negative pid = the whole group
    } catch {
      child.kill("SIGTERM") // group already gone — belt and braces
    }
  }
  appendLog(job, "[lab] SIGTERM sent to process group\n")
  job.status = "cancelled"
  job.endedAt = new Date().toISOString()
  persist()
  return job
}

/** job.result plus a spec summary for the studio result panel. */
export function jobResultPayload(jobId: string): { job: LabJob; result?: LabJobResult; specSummary: Record<string, unknown> } | undefined {
  const job = jobs.get(jobId)
  if (!job) return undefined
  const specSummary = {
    id: job.spec.id,
    name: job.spec.name,
    label: job.label,
    engine: job.engine,
    symbol: job.spec.underlying.symbol,
    dte: job.spec.underlying.dte,
    indicator: job.spec.entry.indicator,
    fast: job.spec.entry.fast,
    slow: job.spec.entry.slow,
    timeframe: job.spec.entry.timeframe,
  }
  return { job, result: job.result, specSummary }
}
