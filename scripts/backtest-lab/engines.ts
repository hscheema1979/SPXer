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
import { specToRunRequest, type BacktestSpec, type RunRequest } from "./contract.ts"
import { SPXER_ROOT } from "./capabilities.ts"

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
    if (b.startDate) args.push("--start", b.startDate)
    if (b.endDate) args.push("--end", b.endDate)
    return { script: `${DIAG}/stockx-backtest.ts`, args, outputPaths: [jsonOut] }
  }

  if (runRequest.engine === "long-option") {
    const b = runRequest.body as {
      ticker: string; symbol: string; tf: number; fast: number; slow: number; offset: number
      tp?: number; sl?: number; gateStart: string; gateEnd: string
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
    return { script: `${DIAG}/long-config-single.ts`, args, outputPaths: [] }
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
