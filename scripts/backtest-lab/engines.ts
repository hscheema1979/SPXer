// Engine spawning — ONE place maps a contract RunRequest onto the real CLI.
// Every engine is spawned with cwd = SPXER_ROOT so its cwd-relative reads
// (data/parquet/bars/…) resolve exactly as they do for the nightly pipeline,
// and so resolveSymbolTarget finds scripts/diag/sweep-registry.json.
//
// Flags are transcribed from each engine argv parsing, verified this session
// against the sources (not guessed):
//   shares      scripts/diag/stockx-backtest.ts    argVal(symbol|direction|…)
//   long-option scripts/diag/long-config-single.ts argVal(--symbol|--tf|…)
//   sweep-regen scripts/diag/sweep-parallel.ts     flag(symbol|dte|engine)
//
// buildSpawn returns a PLAN (argv + cwd + artifacts); jobs.ts performs the
// actual spawn so a plan can be built and inspected without launching a child.
import * as path from "node:path"
import { specToRunRequest, type BacktestSpec, type LengthPreset, type RunRequest } from "./contract.ts"
import { SPXER_ROOT, coverageFor, datesFor } from "./capabilities.ts"

export { SPXER_ROOT }

const OUT_DIR = path.join(SPXER_ROOT, "scripts/autoresearch/output/backtest-lab/results")
const DIAG = "scripts/diag"

export interface SpawnPlan {
  cmd: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Artifact paths the engine is told to write (--json-out). */
  outputPaths: string[]
  /** Engine script path, for the job log. */
  script: string
}

const csv = (xs: string[] | undefined): string | undefined =>
  xs && xs.length ? xs.join(",") : undefined

/**
 * spec.length → a concrete [from,to] window.
 *
 * An explicit range is used as-is. A preset is relative to the profile's LAST
 * available date (not today) so "3mo" means three months of data, not three
 * months of calendar that may end in a data gap. "all" and an unknown preset
 * resolve to no window, which every engine reads as "its own full date list".
 */
export function resolveWindow(
  profileSlug: string,
  b: { startDate?: string; endDate?: string; lengthPreset?: LengthPreset },
): { from?: string; to?: string } {
  if (b.startDate || b.endDate) return { from: b.startDate, to: b.endDate }
  const preset = b.lengthPreset
  if (!preset || preset === "all") return {}
  const cov = coverageFor(profileSlug)
  if (!cov) return {}
  const to = cov.lastDate
  if (preset === "ytd") return { from: `${to.slice(0, 4)}-01-01`, to }
  const months = preset === "3m" ? 3 : preset === "6m" ? 6 : preset === "1y" ? 12 : 0
  if (!months) return {}
  const d = new Date(`${to}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - months)
  return { from: d.toISOString().slice(0, 10), to }
}

/** Dates a profile actually has inside the window (ascending). */
export function datesInWindow(profileSlug: string, w: { from?: string; to?: string }): string[] {
  return datesFor(profileSlug).filter((d) => (!w.from || d >= w.from) && (!w.to || d <= w.to))
}

const csv2 = (xs: string[]): string => xs.join(",")

/**
 * RunRequest → argv. The long-option dte is recovered from the ticker slug
 * (`-<n>dte` suffix) so resolveSymbolTarget's profileId always equals the
 * --ticker slug the row is written under.
 */
export function buildArgs(
  runRequest: RunRequest,
  jobId: string,
): { script: string; args: string[]; outputPaths: string[] } {
  if (runRequest.engine === "shares") {
    const b = runRequest.body as {
      symbol?: string; direction?: string; hmaFast?: number; hmaSlow?: number; maType?: string
      timeframe?: string; takeProfitMultiplier?: number; stopLossMultiplier?: number
      entryTriggers?: string[]; exitTriggers?: string[]; entryMode?: string
      sizing?: { mode: string; value?: number }; startDate?: string; endDate?: string; session?: string
      lengthPreset?: LengthPreset
    }
    const jsonOut = path.join(OUT_DIR, `${jobId}.json`)
    const args: string[] = [
      "--symbol", String(b.symbol ?? "").toUpperCase(),
      "--direction", String(b.direction ?? "long"),
      "--ma-type", String(b.maType ?? "hma"),
      "--timeframe", String(b.timeframe ?? "5m"),
      "--fast", String(b.hmaFast ?? 5),
      "--slow", String(b.hmaSlow ?? 100),
      "--entry-match", String(b.entryMode ?? "any"),
      "--session", String(b.session ?? "rth"),
      "--json-out", jsonOut,
    ]
    const entry = csv(b.entryTriggers)
    if (entry) args.push("--entry", entry)
    const exit = csv(b.exitTriggers)
    if (exit) args.push("--exit", exit)
    if (b.takeProfitMultiplier !== undefined) args.push("--tp", String(b.takeProfitMultiplier))
    if (b.stopLossMultiplier !== undefined) args.push("--sl", String(b.stopLossMultiplier))
    // Sizing: the engine takes one of --dollars/--shares/--risk <value>. A spec
    // with sizing.mode "engine-default" sends NO sizing flag, which the engine
    // resolves to its own dollars default — the contract name says as much.
    if (b.sizing) args.push(`--${b.sizing.mode}`, String(b.sizing.value ?? 0))
    // Length: stockx-backtest.ts filters its own continuous date list with
    // --start/--end, so a resolved preset rides the same two flags.
    const wShares = resolveWindow(String(b.symbol ?? "").toLowerCase(), b)
    if (wShares.from) args.push("--start", wShares.from)
    if (wShares.to) args.push("--end", wShares.to)
    return { script: `${DIAG}/stockx-backtest.ts`, args, outputPaths: [jsonOut] }
  }

  if (runRequest.engine === "long-option") {
    const jsonOut = path.join(OUT_DIR, `${jobId}.json`)
    const b = runRequest.body as {
      ticker: string; symbol: string; tf: number; fast: number; slow: number; offset: number
      tp?: number; sl?: number; gateStart: string; gateEnd: string
      startDate?: string; endDate?: string; lengthPreset?: LengthPreset
      indicator?: string; sides?: string
    }
    const dte = /-(\d+)dte$/.exec(b.ticker)?.[1]
    const args: string[] = [
      "--symbol", String(b.symbol).toUpperCase(),
      "--tf", String(b.tf),
      "--fast", String(b.fast),
      "--slow", String(b.slow),
      "--offset", String(b.offset),
      "--gate-start", String(b.gateStart),
      "--gate-end", String(b.gateEnd),
      "--ticker", String(b.ticker),
      // Without this the engine defaulted to HMA whatever the dialog said.
      "--signal", String(b.indicator ?? "hma"),
      // both | calls | puts — filters which crosses are tradeable.
      "--sides", String(b.sides ?? "both"),
      // Per-fill artifact: contract traded, entry/exit, P&L, exit reason.
      "--json-out", jsonOut,
    ]
    if (dte) args.push("--dte", dte)
    // sl 0 is the engine's own "no stop" encoding (slPct > 0 check in
    // long-config-single.ts simulateDay). There is NO honest encoding for "no
    // TP", so when a spec omits TP the engine default (--tp 25) applies and
    // the job log says so explicitly — visible, not silent.
    if (b.tp !== undefined) args.push("--tp", String(b.tp))
    // else: omit --tp (the engine default 25 applies; the job log says so).
    if (b.sl !== undefined) args.push("--sl", String(b.sl))
    else args.push("--sl", "0") // the engine's own "no stop" encoding
    // Length: this engine has no --start/--end — it takes an explicit --dates
    // list (DATES_OVR) and otherwise sweeps listDatesFor(TARGET) whole. An
    // EMPTY --dates silently falls back to "all dates", so a window that
    // selects nothing must fail loudly instead of running 100x the work.
    const wLong = resolveWindow(b.ticker, b)
    if (wLong.from || wLong.to) {
      const dates = datesInWindow(b.ticker, wLong)
      if (!dates.length) {
        throw new Error(
          `no ${b.ticker} dates in ${wLong.from ?? "start"}→${wLong.to ?? "end"} — widen the length or pick another profile`,
        )
      }
      args.push("--dates", csv2(dates))
    }
    return { script: `${DIAG}/long-config-single.ts`, args, outputPaths: [jsonOut] }
  }

  // sweep-regen — sweep-parallel.ts forwards --symbol/--dte to the engine and
  // strips its own orchestrator flags itself.
  const b = runRequest.body as { engineKind: "credit" | "iron"; symbol: string; dte: number }
  return {
    script: `${DIAG}/sweep-parallel.ts`,
    args: ["--symbol", String(b.symbol).toUpperCase(), "--dte", String(b.dte), "--engine", b.engineKind],
    outputPaths: [],
  }
}

/** Plan the child (argv + cwd + artifacts); jobs.ts does the actual spawn. */
export function buildSpawn(runRequest: RunRequest, jobId: string): SpawnPlan {
  const { script, args, outputPaths } = buildArgs(runRequest, jobId)
  return {
    cmd: "npx",
    args: ["tsx", script, ...args],
    cwd: SPXER_ROOT,
    env: process.env,
    script,
    outputPaths,
  }
}

/**
 * Spec → spawn plan in one step (what jobs.ts calls). Goes through
 * specToRunRequest so the unit reconciliation stays in the contract, not here.
 */
export function spawnPlanForSpec(spec: BacktestSpec, jobId: string): SpawnPlan {
  return buildSpawn(specToRunRequest(spec), jobId)
}
