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

/**
 * Last stdout line is the engine result contract. Only exit 0 jobs reach here.
 * Field names are the engines OWN (summary.trades / summary.totalPnl / …) —
 * renaming them here would silently break the KPIs the studio displays.
 */
function foldResult(engine: EngineKind, spec: BacktestSpec, stdout: string, outputPaths: string[]): LabJobResult {
  const lastLine = [...stdout.split("\n")].reverse().find((l) => l.trim().length > 0) ?? ""
  if (engine === "sweep-regen") {
    // FR-003 consolidation: sweep results live under the Backtest Lab's
    // Sweeps tab (the old /dashboard/spreads route redirects there).
    return { deepLink: `/dashboard/backtest?tab=sweeps` }
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
  // long-option: last line is { configId, row }; the trade log lives in the
  // --json-out artifact so the run can be checked fill by fill.
  const r = parsed?.row
  if (!r) return { artifactPath: outputPaths[0] }
  return { kpis: { n: r.n, wr: r.wr, pnl: r.pnl, dd: r.dd }, artifactPath: outputPaths[0] }
}

// ── Queue ───────────────────────────────────────────────────────────────────

function pump(engine: EngineKind): void {
  if (running[engine]) return // per-engine concurrency 1
  const job = queues[engine].shift()
  if (!job) return
  job.status = "running"
  job.startedAt = new Date().toISOString()
  let stdout = ""
  let stderr = ""
  let child: ChildProcess
  let plan: SpawnPlan
  try {
    // Inside the try on purpose: buildSpawn validates the spec against what is
    // on disk (e.g. a length window that selects no dates) and throws. Outside,
    // that throw escaped pump() and took the service down with it.
    plan = buildSpawn(specToRunRequest(job.spec), job.jobId)
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
/** One fill, engine-agnostic — the runs page renders exactly these columns. */
export interface TradeRow {
  entry: string        // "2026-09-02 14:04"
  exit: string
  instrument: string   // OCC contract for options, the ticker for shares
  side?: string        // C/P (options) or long/short (shares)
  strike?: number
  qty?: number
  entryPx: number
  exitPx: number
  pnl: number
  retPct: number
  hold?: number        // minutes (options) / bars (shares)
  reason: string
}

/**
 * Read a finished run's artifact and normalise its fills. The two engines
 * write different shapes — shares emits {entryTime,exitTime,qty,bars}, the
 * option engine {date,entryET,exitET,symbol,strike,holdMin} — and the review
 * page should not have to know which engine produced the row it is showing.
 */
function tradesFromArtifact(job: LabJob): { trades: TradeRow[]; tradesPnl: number } | undefined {
  const file = job.result?.artifactPath
  if (!file) return undefined
  let raw: any
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")) } catch { return undefined }
  const list: any[] = Array.isArray(raw?.trades) ? raw.trades : Array.isArray(raw?.tradesList) ? raw.tradesList : []
  if (!list.length) return undefined
  const underlying = job.spec?.underlying?.symbol ?? ""
  const trades: TradeRow[] = list.map((t) => {
    const isOption = typeof t.entryET === "string"
    return {
      entry: isOption ? `${t.date} ${t.entryET}` : String(t.entryTime ?? ""),
      exit: isOption ? `${t.date} ${t.exitET}` : String(t.exitTime ?? ""),
      instrument: isOption ? String(t.symbol ?? "") : underlying,
      side: isOption ? String(t.side ?? "") : (t.qty as number) < 0 ? "short" : "long",
      strike: isOption ? Number(t.strike) : undefined,
      qty: isOption ? 1 : Number(t.qty ?? 0),
      entryPx: Number(t.entryPx ?? 0),
      exitPx: Number(t.exitPx ?? 0),
      pnl: Number(t.pnl ?? 0),
      retPct: Number(t.retPct ?? 0),
      hold: isOption ? Number(t.holdMin ?? 0) : Number(t.bars ?? 0),
      reason: String(t.reason ?? ""),
    }
  })
  const tradesPnl = +trades.reduce((a, t) => a + t.pnl, 0).toFixed(2)
  return { trades, tradesPnl }
}

/**
 * Position sizing applied AFTER the fact.
 *
 * Quantity does not change when a trade is entered or exited — no capital,
 * margin or liquidity constraint is modelled — so sizing is a pure function of
 * the stored fills. Runs stay canonical at one contract and this rescales the
 * view, which means "what would 10 contracts have done" costs no re-run.
 *
 *   contracts N  every fill takes N
 *   dollars   X  spend up to $X of premium per fill: floor(X / (entryPx*100))
 *   risk      X  risk $X per fill: floor(X / maxLoss), where maxLoss is the
 *                stop distance when the run had one, else the whole premium
 *
 * A fill the budget cannot afford one unit of is DROPPED and counted — that
 * trade could not have been taken. Shares runs already carry a real qty from
 * their engine, so a sizing override replaces it rather than multiplying it.
 */
export interface SizingOverride {
  mode: "contracts" | "dollars" | "risk"
  value: number
  /** Stop distance as a fraction of premium, for risk mode (0 = no stop). */
  slFrac?: number
}

export function applySizing(
  trades: TradeRow[],
  sizing: SizingOverride,
): { trades: TradeRow[]; unaffordable: number } {
  const out: TradeRow[] = []
  let unaffordable = 0
  for (const t of trades) {
    const unit = Math.abs(t.entryPx) * (t.strike != null ? 100 : 1) // options are per-100
    let qty: number
    if (sizing.mode === "contracts") {
      qty = Math.max(0, Math.floor(sizing.value))
    } else if (sizing.mode === "dollars") {
      qty = unit > 0 ? Math.floor(sizing.value / unit) : 0
    } else {
      const maxLoss = sizing.slFrac && sizing.slFrac > 0 ? unit * sizing.slFrac : unit
      qty = maxLoss > 0 ? Math.floor(sizing.value / maxLoss) : 0
    }
    if (qty < 1) { unaffordable++; continue }
    // Scale the STORED pnl by the quantity ratio rather than recomputing it
    // from entryPx/exitPx: those are rounded to cents in the log, and
    // re-deriving 50 fills from them drifted the total by $3 against the
    // engine's own figure. Ratio scaling is exact at any qty.
    const baseQty = t.qty && t.qty > 0 ? t.qty : 1
    out.push({ ...t, qty, pnl: +((t.pnl * qty) / baseQty).toFixed(2) })
  }
  return { trades: out, unaffordable }
}

/** Per-run analytics derived from the fills — no second source of truth. */
export interface RunAnalytics {
  byDay: Array<{ date: string; pnl: number; n: number; wins: number; cum: number }>
  byHour: Array<{ hour: string; pnl: number; n: number; wins: number }>
  byReason: Array<{ reason: string; pnl: number; n: number }>
  bySide: Array<{ side: string; pnl: number; n: number }>
  stats: {
    n: number; wins: number; losses: number; wr: number
    pnl: number; avgPnl: number; avgWin: number; avgLoss: number
    profitFactor: number | null; expectancy: number
    bestTrade: number; worstTrade: number
    bestDay: number; worstDay: number; posDays: number; negDays: number
    maxDrawdown: number      // on the fill-ordered cumulative curve (intraday)
    maxDrawdownDaily: number // on the DAILY cumulative curve — the engine's own `dd`
    avgHold: number
  }
}

function analyzeTrades(trades: TradeRow[]): RunAnalytics {
  const day = new Map<string, { pnl: number; n: number; wins: number }>()
  const hour = new Map<string, { pnl: number; n: number; wins: number }>()
  const reason = new Map<string, { pnl: number; n: number }>()
  const side = new Map<string, { pnl: number; n: number }>()

  let pnl = 0, wins = 0, grossWin = 0, grossLoss = 0, hold = 0
  let best = -Infinity, worst = Infinity
  let cum = 0, peak = 0, maxDrawdown = 0

  for (const t of trades) {
    const d = (t.entry || "").slice(0, 10)
    const h = (t.entry || "").slice(11, 13)
    const won = t.pnl > 0

    const dd = day.get(d) ?? { pnl: 0, n: 0, wins: 0 }
    dd.pnl += t.pnl; dd.n++; if (won) dd.wins++
    day.set(d, dd)

    if (h) {
      const hh = hour.get(`${h}:00`) ?? { pnl: 0, n: 0, wins: 0 }
      hh.pnl += t.pnl; hh.n++; if (won) hh.wins++
      hour.set(`${h}:00`, hh)
    }

    const r = reason.get(t.reason || "—") ?? { pnl: 0, n: 0 }
    r.pnl += t.pnl; r.n++
    reason.set(t.reason || "—", r)

    const sd = side.get(t.side || "—") ?? { pnl: 0, n: 0 }
    sd.pnl += t.pnl; sd.n++
    side.set(t.side || "—", sd)

    pnl += t.pnl
    if (won) { wins++; grossWin += t.pnl } else { grossLoss += -t.pnl }
    hold += t.hold ?? 0
    if (t.pnl > best) best = t.pnl
    if (t.pnl < worst) worst = t.pnl

    // Drawdown on the fill-ordered curve — the same order the run took them.
    cum += t.pnl
    if (cum > peak) peak = cum
    if (peak - cum > maxDrawdown) maxDrawdown = peak - cum
  }

  const dayRows = [...day.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  let running = 0
  const byDay = dayRows.map(([date, v]) => {
    running += v.pnl
    return { date, pnl: +v.pnl.toFixed(2), n: v.n, wins: v.wins, cum: +running.toFixed(2) }
  })

  // Two drawdowns, deliberately: the per-fill curve dips intraday, the daily
  // curve is what the engine reports as `dd`. Showing only one invites a
  // "these numbers disagree" moment that is really a definition mismatch.
  let dPeak = 0, dCum = 0, maxDrawdownDaily = 0
  for (const r of dayRows) {
    dCum += r[1].pnl
    if (dCum > dPeak) dPeak = dCum
    if (dPeak - dCum > maxDrawdownDaily) maxDrawdownDaily = dPeak - dCum
  }

  const n = trades.length
  const losses = n - wins
  const r2 = (x: number) => +x.toFixed(2)
  return {
    byDay,
    byHour: [...hour.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([h, v]) => ({ hour: h, pnl: r2(v.pnl), n: v.n, wins: v.wins })),
    byReason: [...reason.entries()].sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => ({ reason: k, pnl: r2(v.pnl), n: v.n })),
    bySide: [...side.entries()].sort((a, b) => b[1].n - a[1].n)
      .map(([k, v]) => ({ side: k, pnl: r2(v.pnl), n: v.n })),
    stats: {
      n, wins, losses,
      wr: n ? r2((wins / n) * 100) : 0,
      pnl: r2(pnl),
      avgPnl: n ? r2(pnl / n) : 0,
      avgWin: wins ? r2(grossWin / wins) : 0,
      avgLoss: losses ? r2(-grossLoss / losses) : 0,
      profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
      expectancy: n ? r2(pnl / n) : 0,
      bestTrade: Number.isFinite(best) ? r2(best) : 0,
      worstTrade: Number.isFinite(worst) ? r2(worst) : 0,
      bestDay: byDay.length ? r2(Math.max(...byDay.map(d => d.pnl))) : 0,
      worstDay: byDay.length ? r2(Math.min(...byDay.map(d => d.pnl))) : 0,
      posDays: byDay.filter(d => d.pnl > 0).length,
      negDays: byDay.filter(d => d.pnl < 0).length,
      maxDrawdown: r2(maxDrawdown),
      maxDrawdownDaily: r2(maxDrawdownDaily),
      avgHold: n ? r2(hold / n) : 0,
    },
  }
}

export function jobResultPayload(jobId: string, sizing?: SizingOverride): {
  job: LabJob; result?: LabJobResult; specSummary: Record<string, unknown>
  trades?: TradeRow[]; tradesPnl?: number; analytics?: RunAnalytics
  sizing?: SizingOverride & { unaffordable: number }
} | undefined {
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
  // The fills ride along so the review page can show WHAT a run did, and
  // whether the fills add up to the P&L the summary claims.
  const log = tradesFromArtifact(job)
  if (!log) return { job, result: job.result, specSummary }

  // The stored run is the baseline; a sizing override is a view over it.
  const sized = sizing ? applySizing(log.trades, sizing) : undefined
  const trades = sized ? sized.trades : log.trades
  const tradesPnl = sized ? +trades.reduce((a, t) => a + t.pnl, 0).toFixed(2) : log.tradesPnl
  return {
    job, result: job.result, specSummary,
    trades, tradesPnl,
    analytics: analyzeTrades(trades),
    sizing: sizing ? { ...sizing, unaffordable: sized!.unaffordable } : undefined,
  }
}
