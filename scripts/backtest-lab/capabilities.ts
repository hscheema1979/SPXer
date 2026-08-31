// Capabilities builder — sweep-registry.json ∩ real parquet coverage, plus the
// sweep-grid vocabularies reproduced from the engine sources.
//
// SPXER_ROOT is env-overridable (default: the repo root two dirs up, i.e. the
// SPXer checkout this file lives in). The lab service spawns engines with
// cwd = SPXER_ROOT, so the same root governs what we advertise and what the
// engines actually read: data/parquet/bars/<profileId>/*.parquet.
//
// Honest-by-design rule (contract.ts): a profile with no coverage is NOT
// advertised — no registry-fantasy rows. If data/ is missing entirely (e.g. a
// bare worktree), capabilities come back empty rather than invented.
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  EngineCapabilities,
  MaType,
  ProfileCoverage,
  SweepStructure,
} from "./contract.ts"
import { SHARES_ENTRY_TRIGGERS, SHARES_EXIT_TRIGGERS } from "./contract.ts"

// CJS-safe root resolution: derive the root from THIS file's location, not
// cwd — PM2's shim cwd is not the SPXer checkout. tsx always sets
// import.meta.url; the __filename fallback covers the CJS transform.
const thisFile =
  typeof import.meta.url === "string"
    ? fileURLToPath(import.meta.url)
    : (globalThis as { __filename?: string }).__filename ?? ""
export const SPXER_ROOT = process.env.SPXER_ROOT
  ? path.resolve(process.env.SPXER_ROOT)
  : path.resolve(path.dirname(thisFile), "../..")
const BARS_ROOT = path.join(SPXER_ROOT, "data/parquet/bars")
const REGISTRY_PATH = path.join(SPXER_ROOT, "scripts/diag/sweep-registry.json")

// ── Registry ────────────────────────────────────────────────────────────────

interface RegistryProfile {
  symbol: string
  dte: number
  class: string
  assetClass?: "shares" | "options"
  profileId: string
  optionPrefix: string
  strikeInterval: number
  label?: string
}

function readRegistry(): RegistryProfile[] {
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"))
    return Array.isArray(reg.profiles) ? (reg.profiles as RegistryProfile[]) : []
  } catch {
    return [] // registry optional — capabilities just come back empty
  }
}

// ── Coverage ────────────────────────────────────────────────────────────────

const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.parquet$/

/** Same date-listing rule as sweep-symbol.ts::listDatesFor (no SWEEP_DAYS cut). */
export function coverageFor(profileId: string): ProfileCoverage | undefined {
  const dir = path.join(BARS_ROOT, profileId)
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((f) => DATE_FILE.test(f)).sort()
  } catch {
    return undefined // no parquet dir → no coverage
  }
  if (!names.length) return undefined
  return {
    profileId,
    symbol: "",
    dte: null,
    dateCount: names.length,
    firstDate: names[0].slice(0, 10),
    lastDate: names[names.length - 1].slice(0, 10),
  }
}

/** Registry row for a profileId, so single-coverage lookups can name symbol/dte. */
export function registryProfileFor(profileId: string): RegistryProfile | undefined {
  return readRegistry().find((p) => p.profileId === profileId)
}

/**
 * Instrument name for a profileId from EITHER source — registry first, then the
 * BASES 0DTE fast path. Keeps GET /api/coverage consistent with the profiles
 * list capabilities advertises (spx-0dte is a BASES profile, not a registry row).
 */
export function optionSourceFor(profileId: string): { symbol: string; dte: number } | undefined {
  const reg = registryProfileFor(profileId)
  if (reg) return { symbol: reg.symbol, dte: reg.dte }
  const m = /^([a-z0-9]+)-0dte$/.exec(profileId)
  const symbol = m?.[1].toUpperCase()
  if (symbol && BASES[symbol]) return { symbol, dte: 0 }
  return undefined
}

function profileCoverage(p: RegistryProfile): ProfileCoverage | undefined {
  const cov = coverageFor(p.profileId)
  if (!cov) return undefined
  return { ...cov, symbol: p.symbol, dte: p.dte }
}

// ── Sweep-grid vocabularies ─────────────────────────────────────────────────
// Reproduced from the engines' own generators — regenerate when the grids
// change. Geometry is defined in STRIKE COUNTS and scaled by strikeInterval.

// credit-spread-sweep.ts:137-148 SPREAD_DEFS (soS,wS) →
//   label = soS===0 ? `ATM w${wS*SI}` : `${abs(soS*SI)}${soS<0?'ITM':'OTM'} w${wS*SI}`
const SPREAD_DEFS: Array<[number, number]> = [
  [-3, 2], [-2, 2], [-2, 4], // ITM
  [-1, 2], [-1, 1],
  [0, 1], [0, 2], // ATM
  [1, 1], [1, 2], // OTM
  [2, 1], [2, 2], [3, 2],
]

function creditGeometries(SI: number): string[] {
  return SPREAD_DEFS.map(([soS, wS]) => {
    const w = wS * SI
    if (soS === 0) return `ATM w${w}`
    return `${Math.abs(soS * SI)}${soS < 0 ? "ITM" : "OTM"} w${w}`
  })
}

// iron-sweep.ts:208-222. The engine branches on instrumentClass (registry
// `class`: etf → the narrow liquid range, index → wide). For every registered
// profile the two discriminators agree (etf ⇒ strikeInterval 1, index ⇒ 5/10),
// so we branch on strikeInterval like the rest of the grid does.
function ironVocab(SI: number): { wing: number[]; icOffset: number[]; dirCenter: number[]; dirWing: number[] } {
  const etf = SI === 1
  return {
    wing: etf ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 8, 10],
    icOffset: etf ? [1, 2, 3] : [2, 3, 4],
    dirCenter: etf ? [1, 2, 3] : [1, 2, 3, 4, 5],
    dirWing: etf ? [1, 2, 3] : [2, 3, 4, 5],
  }
}

// iron-sweep.ts STRUCTURES, split by `kind`: butterflies (`IB w*` static +
// `IB±co w*` directional) feed the "iron-fly" structure; condors (`IC off w*`)
// feed "iron-condor".
function ironFlyGeometries(SI: number): string[] {
  const v = ironVocab(SI)
  const ib = v.wing.map((s) => `IB w${s * SI}`)
  const dir = v.dirCenter.flatMap((cs) =>
    v.dirWing.map((s) => `IB±${cs * SI} w${s * SI}`),
  )
  return [...ib, ...dir]
}

function ironCondorGeometries(SI: number): string[] {
  const v = ironVocab(SI)
  return v.icOffset.flatMap((os) => v.wing.map((s) => `IC ${os * SI}w${s * SI}`))
}

// Exit policies — credit-spread-sweep.ts:154-184, and iron-sweep.ts:229-259
// carries the IDENTICAL 29-label list (both engines copy this array). Count
// must stay in lockstep with EXITS.length upstream.
const SWEEP_EXITS: string[] = [
  "hold-to-settle",
  "TP5 only", "TP6 only", "TP7 only", "TP8 only",
  "TP10 only", "TP15 only", "TP20 only", "TP25 only", "TP35 only",
  "TP50 only", "TP75 only",
  "TP5 SL50%", "TP5 SL60%", "TP5 SL70%", "TP5 SL80%",
  "TP10 SL50%", "TP10 SL60%", "TP10 SL70%", "TP10 SL80%",
  "TP15 SL50%", "TP15 SL60%", "TP15 SL70%", "TP15 SL80%",
  "TP10 +flip", "TP15 +flip", "TP25 +flip", "TP50 +flip",
  "flip only",
]

/**
 * Strike interval keying the flat grid — the contract serves ONE vocabulary per
 * structure, so we pin it to SPX ($5, the legacy dashboard dataset). SPX and
 * NDX ($10) both land on the engine's wide (index) branch. CAVEAT, stated
 * rather than hidden: SPY/QQQ/XSP are $1 instruments, so the engine generates
 * their NARROW branch (ETF class in iron-sweep.ts) — the served grid is a
 * superset for those profiles. Harmless in practice because a sweep-regen job
 * regenerates the profile's WHOLE grid (specToRunRequest sends only
 * engineKind/symbol/dte); geometry is a select, not an engine input.
 */
function servedStrikeInterval(candidates: OptionCandidate[]): number {
  const preferred = candidates.find((c) => c.symbol === "SPX") ?? candidates[0]
  return preferred?.strikeInterval ?? 5
}

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * Symbols the shares engine has data for — assetClass:'shares' registry rows
 * with real coverage. SERVED UPPERCASE: validateSpec() checks
 * caps.shares.symbols.includes(spec.underlying.symbol.toUpperCase()), and the
 * contract is frozen. The engine itself reads
 * data/parquet/bars/<symbol.toLowerCase()>, which for these profiles is the
 * same directory the profileId names.
 */
export function sharesSymbols(): string[] {
  return readRegistry()
    .filter((p) => p.assetClass === "shares")
    .map((p) => profileCoverage(p))
    .filter((c): c is ProfileCoverage => Boolean(c))
    .map((c) => c.symbol.toUpperCase())
}

/**
 * sweep-symbol.ts:31-37 BASES — the hardcoded resolution fast path. These five
 * run WITHOUT any registry row (resolveSymbolTarget consults BASES first and
 * only falls back to sweep-registry.json), so a registry-only capabilities
 * builder would never advertise SPX 0DTE. Advertised at their defaultDte (0),
 * profileId `<sym>-0dte`, strike interval from BASES, only when the parquet
 * exists on disk.
 */
const BASES: Record<string, { optionPrefix: string; strikeInterval: number; class: "index" | "etf" }> = {
  SPX: { optionPrefix: "SPXW", strikeInterval: 5, class: "index" },
  SPY: { optionPrefix: "SPY", strikeInterval: 1, class: "etf" },
  QQQ: { optionPrefix: "QQQ", strikeInterval: 1, class: "etf" },
  XSP: { optionPrefix: "XSP", strikeInterval: 1, class: "etf" },
  NDX: { optionPrefix: "NDXP", strikeInterval: 10, class: "index" },
}

interface OptionCandidate {
  symbol: string
  dte: number
  profileId: string
  strikeInterval: number
}

/**
 * Options profiles to advertise: BASES symbols at 0DTE plus every non-shares
 * registry row. Deduped by profileId with the registry row winning — it is the
 * source that carries real symbol/dte fields for multi-DTE profiles. The
 * no-coverage-no-row rule still holds: candidates without parquet are dropped.
 */
function optionCandidates(): OptionCandidate[] {
  const byId = new Map<string, OptionCandidate>()
  for (const [symbol, base] of Object.entries(BASES)) {
    byId.set(`${symbol.toLowerCase()}-0dte`, {
      symbol,
      dte: 0,
      profileId: `${symbol.toLowerCase()}-0dte`,
      strikeInterval: base.strikeInterval,
    })
  }
  for (const p of readRegistry()) {
    if (p.assetClass === "shares") continue
    byId.set(p.profileId, {
      symbol: p.symbol,
      dte: p.dte,
      profileId: p.profileId,
      strikeInterval: p.strikeInterval,
    })
  }
  return [...byId.values()]
}

function optionProfiles(): ProfileCoverage[] {
  return optionCandidates()
    .map((c): ProfileCoverage | undefined => {
      const cov = coverageFor(c.profileId)
      return cov ? { ...cov, symbol: c.symbol, dte: c.dte } : undefined
    })
    .filter((c): c is ProfileCoverage => Boolean(c))
}

// The long engine takes whole minutes (contract.tfMinutes); it is MA-cross
// driven on the same 1m parquet. 2m/3m are the sweep-grid TFs, 1m/5m the edges.
const LONG_TIMEFRAMES = ["1m", "2m", "3m", "5m"] as const
const OPTION_INDICATORS: MaType[] = ["hma", "dema"] // engine --signal whitelist

export function buildCapabilities(): EngineCapabilities {
  const candidates = optionCandidates()
  const profiles = optionProfiles()
  const SI = servedStrikeInterval(candidates)

  return {
    shares: {
      symbols: sharesSymbols(),
      // 2m is the options-sweep grid TF (contract.ts note) — the stockx menu
      // aggregates 1m up to everything else on the fly.
      timeframes: ["1m", "3m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "1d"],
      indicators: ["hma", "ema", "dema", "sma", "wma"],
      entryTriggers: SHARES_ENTRY_TRIGGERS,
      exitTriggers: SHARES_EXIT_TRIGGERS,
      sizing: ["dollars", "shares", "risk"],
      windowET: false, // stockx-backtest.ts has no ET entry window; --session rth only
    },
    longOption: {
      profiles,
      timeframes: [...LONG_TIMEFRAMES],
      indicators: OPTION_INDICATORS,
      sizing: false,
    },
    optionSweep: {
      profiles,
      structures: ["credit-spread", "iron-fly", "iron-condor"],
      indicators: OPTION_INDICATORS,
      grid: {
        "credit-spread": { geometries: creditGeometries(SI), exits: SWEEP_EXITS },
        "iron-fly": { geometries: ironFlyGeometries(SI), exits: SWEEP_EXITS },
        "iron-condor": { geometries: ironCondorGeometries(SI), exits: SWEEP_EXITS },
      },
      sizing: false,
      lengthMode: "all-dates",
    },
  }
}

/** Vocabularies exposed for tests / the studio's dialog sanity checks. */
export function sweepVocabularies(SI: number): Record<SweepStructure, { geometries: string[]; exits: string[] }> {
  return {
    "credit-spread": { geometries: creditGeometries(SI), exits: SWEEP_EXITS },
    "iron-fly": { geometries: ironFlyGeometries(SI), exits: SWEEP_EXITS },
    "iron-condor": { geometries: ironCondorGeometries(SI), exits: SWEEP_EXITS },
  }
}
