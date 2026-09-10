// FR-003 — the single backtest config encoding (FROZEN CONTRACT).
// SYNCED COPY of spxer-studio lib/backtest/contract.ts — keep in sync; the
// studio repo's contract.test.ts pins this shape for both consumers.
//
// One BacktestSpec is what the Run dialog emits, what the specs library
// stores, and what `specToRunRequest` maps onto each engine's real request
// body. Pure TS, zero deps, no enums — loads under
// `node --experimental-strip-types` so the lab service (SPXer) can import
// this file directly and re-validate server-side.
//
// Pinned by lib/backtest/contract.test.ts. Shapes and behaviors are the
// contract; exact identifier names may evolve with the test in the same commit.

// ── Vocabularies ────────────────────────────────────────────────────────────

export type MaType = "hma" | "ema" | "dema" | "sma" | "wma"
// 1m is the finest granularity stored; everything above aggregates on the fly
// (stockx-backtest.ts menu). 2m/3m are options-sweep grid TFs.
export type Timeframe =
  | "1m" | "2m" | "3m" | "5m" | "10m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d"

export type SpecType = "shares" | "long-option" | "option-sweep"
export type SweepStructure = "credit-spread" | "iron-fly" | "iron-condor"
export type LengthPreset = "3m" | "6m" | "ytd" | "1y" | "all"

export const MA_TYPES: MaType[] = ["hma", "ema", "dema", "sma", "wma"]
export const TIMEFRAMES: Timeframe[] = [
  "1m", "2m", "3m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "1d",
]
// Trigger vocabularies the stockx engine whitelists (400 on unknown upstream —
// the UI must never silently default; see the 2026-08-08 direction incident).
export const SHARES_ENTRY_TRIGGERS = [
  "price_cross_fast_up", "price_cross_fast_down", "ma_cross_up", "ma_cross_down",
] as const
export const SHARES_EXIT_TRIGGERS = ["tp", "sl", "ma_cross_up", "ma_cross_down"] as const

// ── Spec shape ──────────────────────────────────────────────────────────────

/**
 * Tagged TP/SL. `priceMult` 1.25 == `pricePct` 25 (shares engine takes the
 * multiplier; the long-option engine takes the percent int). `creditFrac`
 * 0.10 is the credit-sweep "TP10" (10% of credit received).
 */
export type TpSl =
  | { kind: "priceMult"; value: number }
  | { kind: "pricePct"; value: number }
  | { kind: "creditFrac"; value: number }

export type SpecStructure =
  | { kind: "shares" }
  | { kind: "long-option"; offset: number } // strikes; negative = ITM
  | { kind: SweepStructure; geometry: string } // engine grid token, e.g. "15ITM w10"

export interface BacktestSpec {
  id: string
  name: string
  type: SpecType
  createdAt: string // ISO
  updatedAt: string // ISO
  note?: string
  /** dte === null means shares ("none for stocks"). */
  underlying: { symbol: string; dte: number | null }
  entry: {
    indicator: MaType
    fast: number
    slow: number
    timeframe: Timeframe
    direction: "long" | "short"
    /** Long-option only: which crosses are tradeable. A bull cross buys a
     *  CALL and a bear cross buys a PUT, so this selects both / calls / puts.
     *  Absent = "both", which is what every existing spec ran as. */
    sides?: "both" | "calls" | "puts"
    triggers: string[]
    mode: "all" | "any"
    /** ET "HH:MM" pair; engines that cannot honor it are labeled honestly. */
    windowET: { start: string; end: string }
  }
  exit: {
    tp?: TpSl
    sl?: TpSl
    eodCutoffET: string
    settle: boolean
    flip: boolean
  }
  sizing: {
    mode: "dollars" | "shares" | "risk" | "engine-default"
    value?: number
    maxPositions?: number
    accountValue?: number
  }
  length: { mode: "preset" | "range"; preset?: LengthPreset; from?: string; to?: string }
  structure: SpecStructure
}

// ── Capabilities (served by GET /api/capabilities on the lab service) ───────

export interface ProfileCoverage {
  profileId: string // e.g. "spx-0dte", "tqqq"
  symbol: string
  dte: number | null
  dateCount: number
  firstDate: string // YYYY-MM-DD
  lastDate: string
  /** $ between adjacent strikes (SPX 5, NDX 10, SPY/QQQ/XSP 1). Present on
   *  option profiles only — it is what turns a strike offset into dollars,
   *  which the two moneyness conventions in this app disagree about. */
  strikeInterval?: number
}

export interface EngineCapabilities {
  shares: {
    symbols: string[]
    timeframes: Timeframe[]
    indicators: MaType[]
    entryTriggers: typeof SHARES_ENTRY_TRIGGERS
    exitTriggers: typeof SHARES_EXIT_TRIGGERS
    sizing: ("dollars" | "shares" | "risk")[]
    windowET: boolean // whether the engine can honor entry windowET
  }
  longOption: {
    profiles: ProfileCoverage[]
    timeframes: Timeframe[]
    indicators: MaType[]
    sizing: false
  }
  optionSweep: {
    profiles: ProfileCoverage[] // coverage-backed only — no registry fantasy rows
    structures: SweepStructure[]
    indicators: MaType[]
    /** Fixed grid vocabularies: geometry/exit are select-not-type. */
    grid: Record<
      SweepStructure,
      { geometries: string[]; exits: string[] }
    >
    sizing: false
    lengthMode: "all-dates" // sweep regen runs the profile's full date range
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function isMaType(v: unknown): v is MaType {
  return typeof v === "string" && (MA_TYPES as string[]).includes(v)
}
function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === "string" && (TIMEFRAMES as string[]).includes(v)
}
function isTpSl(v: unknown): v is TpSl {
  if (typeof v !== "object" || v === null) return false
  const t = v as TpSl
  if (t.kind === "priceMult" || t.kind === "pricePct" || t.kind === "creditFrac") {
    return typeof t.value === "number" && isFinite(t.value) && t.value > 0
  }
  return false
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] }

/**
 * Structural validation. `caps` (optional) adds vocabulary membership checks
 * against the served capabilities. Honest by design: an out-of-vocabulary
 * value is an error, never a silent default.
 */
export function validateSpec(spec: BacktestSpec, caps?: EngineCapabilities): ValidationResult {
  const errors: string[] = []
  const push = (m: string) => errors.push(m)

  if (!spec.id) push("id is required")
  if (!spec.name) push("name is required")
  if (!spec.type || !["shares", "long-option", "option-sweep"].includes(spec.type)) {
    push(`unknown type: ${spec.type}`)
    return { ok: false, errors }
  }
  if (!spec.underlying?.symbol) push("underlying.symbol is required")

  // "DTE or none for stocks."
  if (spec.type === "shares") {
    if (spec.underlying.dte !== null) push("shares specs take dte: null (no DTE for stocks)")
    if (spec.structure.kind !== "shares") push("shares specs take structure.kind 'shares'")
  } else {
    if (spec.underlying.dte === null) push(`${spec.type} specs require a DTE`)
  }

  if (!isMaType(spec.entry?.indicator)) push(`unknown indicator: ${spec.entry?.indicator}`)
  if (!isTimeframe(spec.entry?.timeframe)) push(`unknown timeframe: ${spec.entry?.timeframe}`)
  if (!(spec.entry.fast > 0)) push("entry.fast must be > 0")
  if (!(spec.entry.slow > 0)) push("entry.slow must be > 0")
  // fast > slow is DELIBERATELY allowed: the engine compares MA(fast) to
  // MA(slow) and calls it bull when the first is higher, so swapping the two
  // lengths mirrors the signal — that is how you express "trade the opposite".
  // It is a different strategy, not a sign-flipped copy: on 5 sessions 3x18
  // and 18x3 both took 136 fills with ZERO in common. Equal lengths ARE
  // rejected: MA(p) > MA(p) is never true, so the direction would be a
  // constant and no cross could ever fire.
  if (spec.entry.slow === spec.entry.fast) {
    push("entry.fast and entry.slow must differ — equal lengths can never cross")
  }
  // Only the shares engine has a trigger vocabulary; option engines are
  // MA-cross driven and take no triggers ([] by design — see defaultSpec).
  if (spec.type === "shares") {
    if (!Array.isArray(spec.entry.triggers) || spec.entry.triggers.length === 0) {
      push("entry.triggers must be a non-empty array")
    }
  }
  for (const w of [spec.entry.windowET?.start, spec.entry.windowET?.end]) {
    if (!HHMM.test(w ?? "")) push(`entry window must be HH:MM ET, got: ${w}`)
  }
  if (!HHMM.test(spec.exit?.eodCutoffET ?? "")) {
    push(`exit.eodCutoffET must be HH:MM, got: ${spec.exit?.eodCutoffET}`)
  }

  // TP/SL kind must match the engine's semantics.
  const { tp, sl } = spec.exit ?? {}
  if (tp && !isTpSl(tp)) push("exit.tp is malformed")
  if (sl && !isTpSl(sl)) push("exit.sl is malformed")
  if (spec.type === "shares") {
    if (tp && tp.kind !== "priceMult") push("shares TP must be priceMult (e.g. 1.10)")
    if (sl && sl.kind !== "priceMult") push("shares SL must be priceMult (e.g. 0.95)")
  }
  if (spec.type === "long-option") {
    // Both spellings are accepted (priceMult is preferred — it matches the
    // shares specs and the live config), but a multiplier has to look like a
    // multiplier: pricePct 20 and priceMult 20 are the same keystrokes for a
    // 20% stop and a +1900% target.
    if (tp && tp.kind !== "pricePct" && tp.kind !== "priceMult") {
      push("long-option TP must be priceMult (e.g. 1.25) or pricePct (e.g. 25)")
    }
    if (sl && sl.kind !== "pricePct" && sl.kind !== "priceMult") {
      push("long-option SL must be priceMult (e.g. 0.80) or pricePct (e.g. 20)")
    }
    if (tp?.kind === "priceMult" && !(tp.value > 1)) {
      push(`TP multiplier must be > 1 (got ${tp.value}) — 1.25 is +25%`)
    }
    if (sl?.kind === "priceMult" && !(sl.value > 0 && sl.value < 1)) {
      push(`SL multiplier must be between 0 and 1 (got ${sl.value}) — 0.80 is -20%`)
    }
  }

  if (spec.entry?.sides && !["both", "calls", "puts"].includes(spec.entry.sides)) {
    push(`entry.sides must be both|calls|puts, got ${spec.entry.sides}`)
  }
  if (spec.type === "shares" && spec.entry?.direction === "short") {
    push("shares runs are long-only")
  }
  if (spec.length?.mode === "range") {
    if (!DATE.test(spec.length.from ?? "")) push("length.from must be YYYY-MM-DD")
    if (!DATE.test(spec.length.to ?? "")) push("length.to must be YYYY-MM-DD")
    if (DATE.test(spec.length.from ?? "") && DATE.test(spec.length.to ?? "")) {
      if (spec.length.from! > spec.length.to!) push("length.from must be ≤ length.to")
    }
  }
  if (spec.length?.mode === "preset" && !spec.length.preset) {
    push("length.preset is required in preset mode")
  }

  // Capabilities-aware checks (server is authority; the dialog pre-checks).
  if (caps) {
    const sym = spec.underlying.symbol.toUpperCase()
    if (spec.type === "shares") {
      if (!caps.shares.symbols.includes(sym)) push(`shares engine has no data for ${sym}`)
      if (!caps.shares.timeframes.includes(spec.entry.timeframe)) {
        push(`timeframe ${spec.entry.timeframe} not supported by the shares engine`)
      }
      for (const t of spec.entry.triggers) {
        if (!(SHARES_ENTRY_TRIGGERS as readonly string[]).includes(t)) {
          push(`unknown shares entry trigger: ${t}`)
        }
      }
      if (!caps.shares.indicators.includes(spec.entry.indicator)) {
        push(`indicator ${spec.entry.indicator} not supported by the shares engine`)
      }
    }
    if (spec.type === "option-sweep") {
      const st = spec.structure as { kind: SweepStructure; geometry: string }
      if (!caps.optionSweep.structures.includes(st.kind)) {
        push(`unknown sweep structure: ${st.kind}`)
      } else {
        const g = caps.optionSweep.grid[st.kind]
        if (!g.geometries.includes(st.geometry)) {
          push(`geometry "${st.geometry}" is outside the ${st.kind} grid — select, don't type`)
        }
      }
      const prof = caps.optionSweep.profiles.find(
        (p) => p.symbol === sym && p.dte === spec.underlying.dte,
      )
      if (!prof) push(`no coverage-backed profile for ${sym} ${spec.underlying.dte}DTE`)
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}

// ── Spec → engine request ───────────────────────────────────────────────────

export type RunRequest =
  | { engine: "shares"; body: Record<string, unknown> }
  | { engine: "long-option"; body: Record<string, unknown> }
  | { engine: "sweep-regen"; body: { engineKind: "credit" | "iron"; symbol: string; dte: number } }

/** percent-of-price ↔ multiplier (25% ↔ 1.25). */
export function pctToMult(pct: number): number {
  return Math.round(pct) / 100 + 1
}
export function multToPct(mult: number): number {
  return Math.round((mult - 1) * 100)
}
/** "3m" → 3 (the long engine takes whole minutes). */
export function tfMinutes(tf: Timeframe): number {
  const m = /^(\d+)m$/.exec(tf)
  if (m) return Number(m[1])
  if (tf === "1h") return 60
  if (tf === "2h") return 120
  if (tf === "4h") return 240
  if (tf === "1d") return 390
  throw new Error(`no minute representation for timeframe: ${tf}`)
}

/**
 * The ONE place units reconcile. Frozen conversions (see contract.test.ts):
 * pricePct 25 ↔ priceMult 1.25; long engine gets percent ints; shares engine
 * passes multipliers through.
 */

/**
 * Long-option TP/SL as the engine wants it: whole percent, TP as a gain and SL
 * as a loss (--tp 25 --sl 20 means +25% / -20%).
 *
 * Accepts BOTH spellings so nothing already stored shifts meaning:
 *   priceMult 1.25 / 0.80   (the current spelling — same convention as shares
 *                            specs and as the live optionx config)
 *   pricePct  25   / 20     (the legacy spelling this type used alone)
 *
 * The two are the same keystrokes for different intents — pricePct 20 is a 20%
 * stop, priceMult 20 would be +1900% — which is why validateSpec bounds the
 * multiplier form rather than trusting the number.
 */
export function longPctFrom(t: TpSl | undefined, side: "tp" | "sl"): number | undefined {
  if (!t) return undefined
  if (t.kind === "pricePct") return Math.round(t.value)
  if (t.kind === "priceMult") {
    return side === "tp" ? Math.round((t.value - 1) * 100) : Math.round((1 - t.value) * 100)
  }
  return undefined
}

export function specToRunRequest(spec: BacktestSpec): RunRequest {
  if (spec.type === "shares") {
    const exitTriggers: string[] = []
    if (spec.exit.tp) exitTriggers.push("tp")
    if (spec.exit.sl) exitTriggers.push("sl")
    if (spec.entry.direction === "long") {
      if (spec.exit.flip) exitTriggers.push("ma_cross_down")
    } else {
      if (spec.exit.flip) exitTriggers.push("ma_cross_up")
    }
    // engine-default sends NO sizing field — the "not applied by this engine"
    // honesty rule; widened type keeps strict mode happy on that branch.
    const sizing: Record<string, unknown> | undefined =
      spec.sizing.mode === "engine-default"
        ? undefined
        : { mode: spec.sizing.mode, value: spec.sizing.value ?? 0 }
    return {
      engine: "shares",
      body: {
        symbol: spec.underlying.symbol.toUpperCase(),
        direction: spec.entry.direction,
        hmaFast: spec.entry.fast,
        hmaSlow: spec.entry.slow,
        maType: spec.entry.indicator,
        timeframe: spec.entry.timeframe,
        takeProfitMultiplier: spec.exit.tp ? (spec.exit.tp as { value: number }).value : undefined,
        stopLossMultiplier: spec.exit.sl ? (spec.exit.sl as { value: number }).value : undefined,
        entryTriggers: spec.entry.triggers,
        exitTriggers,
        entryMode: spec.entry.mode,
        sizing,
        startDate: spec.length.mode === "range" ? spec.length.from : undefined,
        endDate: spec.length.mode === "range" ? spec.length.to : undefined,
        // Presets need the profile's last date to become a window, and that is
        // a disk read — so the preset travels and engines.ts resolves it.
        lengthPreset: spec.length.mode === "preset" ? spec.length.preset : undefined,
        session: "rth",
      },
    }
  }

  if (spec.type === "long-option") {
    const tpPct = longPctFrom(spec.exit.tp, "tp")
    const slPct = longPctFrom(spec.exit.sl, "sl")
    return {
      engine: "long-option",
      body: {
        ticker: profileId(spec.underlying.symbol, spec.underlying.dte),
        symbol: spec.underlying.symbol.toUpperCase(),
        tf: tfMinutes(spec.entry.timeframe),
        fast: spec.entry.fast,
        slow: spec.entry.slow,
        offset: (spec.structure as { offset: number }).offset,
        // The engine's --signal. Dropped before this, so the indicator menu
        // was decorative for option specs.
        indicator: spec.entry.indicator,
        sides: spec.entry.sides ?? "both",
        tp: tpPct,
        sl: slPct,
        gateStart: spec.entry.windowET.start,
        gateEnd: spec.entry.windowET.end,
        // Length travels for the option engine too. long-config-single.ts has
        // no --start/--end; it takes an explicit --dates list, which engines.ts
        // builds from these. Before this the Length control was silently
        // dropped and every run swept the profile's whole history.
        startDate: spec.length.mode === "range" ? spec.length.from : undefined,
        endDate: spec.length.mode === "range" ? spec.length.to : undefined,
        lengthPreset: spec.length.mode === "preset" ? spec.length.preset : undefined,
      },
    }
  }

  // option-sweep: full-grid regeneration for the profile (long sharded job).
  const st = spec.structure as { kind: SweepStructure }
  const engineKind = st.kind === "credit-spread" ? "credit" : "iron"
  return {
    engine: "sweep-regen",
    body: { engineKind, symbol: spec.underlying.symbol.toUpperCase(), dte: spec.underlying.dte as number },
  }
}


// ── Promotion: a spec becomes a live optionx config ─────────────────────────

/** Per-symbol engine plumbing, mirroring the studio's strategy editor. */
function livePlumbing(symbol: string): {
  optionPrefix: string; strikeInterval: number; signalSymbol?: string; strikeDivisor?: number
} {
  const s = symbol.trim().toUpperCase()
  if (s === "SPX") return { optionPrefix: "SPXW", strikeInterval: 5 }
  if (s === "NDX") return { optionPrefix: "NDXP", strikeInterval: 10 }
  // XSP has no book of its own and is exactly SPX/10: signal off SPX, then
  // scale the spot back down for the strike grid.
  if (s === "XSP") return { optionPrefix: "XSP", strikeInterval: 1, signalSymbol: "SPX", strikeDivisor: 10 }
  return { optionPrefix: s, strikeInterval: 1 }
}

export interface PromoteOptions {
  /** Dollars of premium per leg per trade. Equal dollars, not equal contracts:
   *  a $10-ITM leg costs ~$1,830 against a $10-OTM leg's ~$740, so equal
   *  contracts would put 71% of the capital in one leg. */
  dollarsPerTrade: number
  /** Live configs are created paused; the operator enables them. */
  disabled?: boolean
  idSuffix?: string
}

/**
 * Lab spec -> optionx live config. This is the ONE conversion; nothing about it
 * should ever be done by hand, because two fields change units on the way:
 *
 *   offset  spec is in STRIKES, the live config is in DOLLARS. Copying the
 *           number gives $2 ITM where $10 was meant on SPX (5x too shallow),
 *           and $20 SPX-equivalent where $10 was meant on XSP (2x too deep,
 *           since strikeDivisor scales the spot and not the offset).
 *   TP/SL   both are multipliers now, so these pass straight through — that is
 *           the point of the pricePct -> priceMult migration.
 */
export function specToLiveConfig(spec: BacktestSpec, opts: PromoteOptions): Record<string, unknown> {
  if (spec.type !== "long-option") {
    throw new Error(`only long-option specs promote today (got ${spec.type})`)
  }
  const sym = spec.underlying.symbol.toUpperCase()
  const plumb = livePlumbing(sym)
  const offsetStrikes = (spec.structure as { offset: number }).offset
  const tpMult = spec.exit.tp?.kind === "priceMult" ? spec.exit.tp.value
    : spec.exit.tp?.kind === "pricePct" ? 1 + spec.exit.tp.value / 100 : undefined
  const slMult = spec.exit.sl?.kind === "priceMult" ? spec.exit.sl.value
    : spec.exit.sl?.kind === "pricePct" ? 1 - spec.exit.sl.value / 100 : undefined
  // TP is required — an OTOCO/OTO always needs an exit leg.
  //
  // SL is OPTIONAL. A spec with no stop promotes with stopLossMultiplier: 0,
  // which optionx reads as "no broker stop": the entry goes out as an OTO
  // (entry + TP limit) and the only exits are the signal reversal and the
  // session cutoff. Forcing a made-up stop here instead would be worse than
  // refusing — validateConfig rejects anything outside [0,1), and
  // roundOptionTick(0) returns $0.05, so a fabricated "0 stop" would rest a
  // real order five cents above zero.
  if (tpMult === undefined) throw new Error("spec must carry a TP to promote")
  const slForLive = slMult ?? 0

  const money = offsetStrikes === 0 ? "atm"
    : `${Math.abs(offsetStrikes) * plumb.strikeInterval}${offsetStrikes < 0 ? "itm" : "otm"}`
  const id = [
    sym.toLowerCase(),
    `${spec.entry.indicator}${spec.entry.timeframe}`,
    `${spec.entry.fast}x${spec.entry.slow}`,
    money,
    `tp${Math.round((tpMult - 1) * 100)}`,
    // "noslI" not "sl100": slForLive===0 means NO broker stop, which is not the
    // same as a 100% stop. Using slMult here produced "slNaN" when the spec had
    // no SL at all.
    slForLive > 0 ? `sl${Math.round((1 - slForLive) * 100)}` : "nosl",
    opts.idSuffix,
  ].filter(Boolean).join("-")

  return {
    id,
    name: specLabel(spec),
    // Created paused on purpose: POST /api/configs starts a handler, and the
    // engine's tick loop skips only on disabled === true.
    enabled: true,
    disabled: opts.disabled !== false,
    signal: {
      type: "hma_cross",
      maType: spec.entry.indicator,
      hmaFast: spec.entry.fast,
      hmaSlow: spec.entry.slow,
      timeframes: [spec.entry.timeframe],
    },
    contract: {
      symbol: sym,
      optionPrefix: plumb.optionPrefix,
      strikeInterval: plumb.strikeInterval,
      // THE conversion: strikes -> dollars.
      strikeOffset: offsetStrikes * plumb.strikeInterval,
      ...(plumb.strikeDivisor ? { strikeDivisor: plumb.strikeDivisor } : {}),
      ...(plumb.signalSymbol ? { signalSymbol: plumb.signalSymbol } : {}),
      dte: spec.underlying.dte ?? 0,
      minContractPrice: 0.2,
      maxContractPrice: 99,
    },
    risk: {
      takeProfitMultiplier: tpMult,
      stopLossMultiplier: slForLive,
      maxPositions: 1,
      cooldownSec: 0,
      // The backtest's exits are overwhelmingly reversals, not TP — this is the
      // setting that reproduces it.
      useFlip: true,
    },
    sizing: { type: "dollars", value: opts.dollarsPerTrade },
    active: {
      start: spec.entry.windowET.start,
      end: spec.entry.windowET.end,
      timezone: "America/New_York",
    },
    execution: { maxSpreadForMarket: 0.75 },
    promotedFrom: { specId: spec.id, backtestLabel: specLabel(spec) },
  }
}

// ── Labels & keys (one encoder/decoder) ─────────────────────────────────────

/** Profile id / filename slug: SPX 0DTE → "spx-0dte", TQQQ (shares) → "tqqq". */
export function profileId(symbol: string, dte: number | null): string {
  const s = symbol.toLowerCase()
  return dte === null ? s : `${s}-${dte}dte`
}

/** Canonical signal token — the sweeps' double-spaced form, e.g. "HMA  2m 3x12". */
export function signalToken(spec: BacktestSpec): string {
  return `${spec.entry.indicator.toUpperCase()}  ${spec.entry.timeframe} ${spec.entry.fast}x${spec.entry.slow}`
}

/** "15ITM w10"-style geometry for a long-option spec's offset. */
export function moneynessToken(offset: number): string {
  if (offset === 0) return "ATM"
  return offset < 0 ? `${Math.abs(offset)}ITM` : `${offset}OTM`
}

/** Legacy variant key so lab-written rows stay resolvable in existing maps. */
export function variantKeyOf(spec: BacktestSpec): string {
  if (spec.type === "option-sweep") {
    const st = spec.structure as { kind: SweepStructure; geometry: string }
    const spread =
      st.kind === "credit-spread"
        ? st.geometry
        : st.kind === "iron-fly"
          ? `IB ${st.geometry.replace(/^IB\W*/, "")}`
          : `IC ${st.geometry.replace(/^IC\W*/, "")}`
    return `${signalToken(spec)}|${spread}|${exitToken(spec)}`
  }
  if (spec.type === "long-option") {
    return `long::${signalToken(spec)}::${moneynessToken((spec.structure as { offset: number }).offset)}::${exitToken(spec)}`
  }
  return `${spec.underlying.symbol.toLowerCase()}:${signalToken(spec)}`
}

function exitToken(spec: BacktestSpec): string {
  const parts: string[] = []
  if (spec.exit.tp?.kind === "creditFrac") {
    // Canonical sweep form: "TP10 only" (no SL, hold to settle), else "TP10".
    parts.push(`TP${Math.round(spec.exit.tp.value * 100)}${!spec.exit.sl && spec.exit.settle ? " only" : ""}`)
  } else if (spec.exit.tp?.kind === "pricePct") {
    parts.push(`TP${Math.round(spec.exit.tp.value)}`)
  }
  if (spec.exit.sl?.kind === "pricePct") parts.push(`SL${Math.round(spec.exit.sl.value)}`)
  if (spec.exit.flip) parts.push("flip")
  if (spec.exit.settle && spec.exit.tp?.kind !== "creditFrac") parts.push("settle")
  return parts.length ? parts.join("/") : "hold"
}

/** Short human label for tables and the specs library. */
export function specLabel(spec: BacktestSpec): string {
  const u =
    spec.underlying.dte === null
      ? spec.underlying.symbol.toUpperCase()
      : `${spec.underlying.symbol.toUpperCase()} ${spec.underlying.dte}DTE`
  const bits = [
    `${u} · ${typeNoun(spec)}`,
    `${spec.entry.indicator} ${spec.entry.fast}x${spec.entry.slow} ${spec.entry.timeframe}`,
  ]
  if (spec.exit.tp) bits.push(`TP ${tpSlText(spec.exit.tp)}`)
  if (spec.exit.sl) bits.push(`SL ${tpSlText(spec.exit.sl)}`)
  if (spec.sizing.mode !== "engine-default" && spec.sizing.value) {
    bits.push(`${spec.sizing.mode === "shares" ? "" : "$"}${spec.sizing.value}/${spec.sizing.mode === "shares" ? "sh" : "trade"}`)
  }
  bits.push(lengthText(spec.length))
  return bits.join(" · ")
}

function typeNoun(spec: BacktestSpec): string {
  if (spec.type === "shares") return spec.entry.direction === "long" ? "shares long" : "shares short"
  if (spec.type === "long-option") return "long option"
  return (spec.structure as { kind: string }).kind
}

/**
 * Always render a percent — the stored unit is an implementation detail and a
 * multiplier is not something anyone reads at a glance. 1.25 -> +25%,
 * 0.80 -> -20%, so the sign says which side of entry it sits on.
 */
function tpSlText(t: TpSl): string {
  if (t.kind === "creditFrac") return `${Math.round(t.value * 100)}%cr`
  if (t.kind === "pricePct") return `${Math.round(t.value)}%`
  const pct = Math.round((t.value - 1) * 100)
  return `${pct > 0 ? "+" : ""}${pct}%`
}

export function lengthText(l: BacktestSpec["length"]): string {
  if (l.mode === "preset") return ({ "3m": "3mo", "6m": "6mo", ytd: "YTD", "1y": "1yr", all: "all dates" } as const)[l.preset ?? "all"]
  return `${l.from}→${l.to}`
}

/** Default skeleton for the dialog to fill in. */
export function defaultSpec(type: SpecType): BacktestSpec {
  const now = new Date().toISOString()
  const structure: SpecStructure =
    type === "shares"
      ? { kind: "shares" }
      : type === "long-option"
        ? { kind: "long-option", offset: 0 }
        : { kind: "credit-spread", geometry: "" }
  return {
    id: `spec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    type,
    createdAt: now,
    updatedAt: now,
    underlying: { symbol: type === "shares" ? "TQQQ" : "SPX", dte: type === "shares" ? null : 0 },
    entry: {
      indicator: "hma",
      fast: 3,
      slow: 12,
      timeframe: type === "shares" ? "5m" : "2m",
      direction: "long",
      triggers: type === "shares" ? ["price_cross_fast_up"] : [],
      mode: "any",
      windowET: { start: "09:30", end: "16:00" },
    },
    exit: {
      tp: type === "shares" ? { kind: "priceMult", value: 1.1 } : type === "long-option" ? { kind: "priceMult", value: 1.25 } : { kind: "creditFrac", value: 0.1 },
      sl: type === "shares" ? { kind: "priceMult", value: 0.95 } : type === "long-option" ? { kind: "priceMult", value: 0.8 } : undefined,
      eodCutoffET: "15:45",
      settle: type === "option-sweep",
      flip: false, // flip-on-reversal is implicit in the long-option engine; explicit opt-in elsewhere
    },
    sizing: { mode: type === "shares" ? "dollars" : "engine-default", value: type === "shares" ? 10000 : undefined },
    length: { mode: "preset", preset: "3m" },
    structure,
  }
}
