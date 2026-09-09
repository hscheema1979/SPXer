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
  if (!(spec.entry.slow > spec.entry.fast)) push("entry.slow must be > entry.fast")
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
    if (tp && tp.kind !== "pricePct") push("long-option TP must be pricePct (e.g. 25)")
    if (sl && sl.kind !== "pricePct") push("long-option SL must be pricePct (e.g. 20)")
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
    const tp = spec.exit.tp as { kind: "pricePct"; value: number } | undefined
    const sl = spec.exit.sl as { kind: "pricePct"; value: number } | undefined
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
        tp: tp ? Math.round(tp.value) : undefined,
        sl: sl ? Math.round(sl.value) : undefined,
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

function tpSlText(t: TpSl): string {
  if (t.kind === "creditFrac") return `${Math.round(t.value * 100)}%cr`
  if (t.kind === "pricePct") return `${Math.round(t.value)}%`
  return `${t.value}x`
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
      tp: type === "shares" ? { kind: "priceMult", value: 1.1 } : type === "long-option" ? { kind: "pricePct", value: 25 } : { kind: "creditFrac", value: 0.1 },
      sl: type === "shares" ? { kind: "priceMult", value: 0.95 } : type === "long-option" ? { kind: "pricePct", value: 20 } : undefined,
      eodCutoffET: "15:45",
      settle: type === "option-sweep",
      flip: false, // flip-on-reversal is implicit in the long-option engine; explicit opt-in elsewhere
    },
    sizing: { mode: type === "shares" ? "dollars" : "engine-default", value: type === "shares" ? 10000 : undefined },
    length: { mode: "preset", preset: "3m" },
    structure,
  }
}
