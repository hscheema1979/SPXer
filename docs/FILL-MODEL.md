# Fill Model

**Scope:** How the backtest (and, implicitly, the live-parity replay) turns a signal + bar into a realistic fill price and P&L.

**Why this exists:** Without an execution-aware fill model, the replay systematically over-counted wins. TPs got credited from bar-close prices that were already past the limit, stops exited at bar close rather than the stop level, market entries didn't pay size-based book impact, and configs could "trade" 1,000 contracts into a bar that only printed 30 contracts of volume. Result: phantom P&L that didn't survive contact with live.

The fill model is applied in four composable phases. Each is independently configurable and independently disable-able (all defaults are conservative; setting slippage knobs to zero reproduces the pre-Phase-2 behavior).

> **Terminology warning:** "Phase 1–4" here refers to fill-model phases in code (`src/core/fill-model.ts`, `src/core/position-manager.ts`, `src/core/trade-manager.ts`). These are **different** from:
> - `docs/BRACKET-PLAN.md` "Phase 1/2/3" (live-safety / replay modeling / reconciliation rollout phases)
>
> (The option stream used to have its own two-phase startup at 8:00 / 9:30 ET,
> but as of 2026-04-20 it's a single-phase wake at 09:22 ET — see CLAUDE.md's
> "Time-based data flow" section. No more startup-phase namespace collision.)
>
> Keep the remaining namespaces straight when reading other docs.

---

## Architectural separation

```
friction.ts          Always-on baseline cost (half-spread + commission).
                     Assumes you cross a ~$0.05 spread and pay $0.35/contract.
                     Applied to every fill regardless of phase settings.

fill-model.ts        Order-type-specific slippage ON TOP of friction.
                     Models SL stop-market slip and market-buy entry slip.
                     TP limits get zero slip (you provide liquidity).

position-manager.ts  Exit detection. Decides WHICH exit fires and clamps
                     the fill price to the TP/SL level (not bar close).

trade-manager.ts     Entry gate. Sizes the trade, applies the participation
                     cap, and layers entry slippage into the fill price.
```

Friction is **always on** and not configurable at the Config level. The fill model is **opt-in per Config** via `config.fill.*` and `config.exit.exitPricing`.

---

## Phase 1 — TP/SL price clamping

**Location:** `src/core/position-manager.ts` (`checkExit()`)

**Gate:** `config.exit.exitPricing === 'intrabar'` (enables bar high/low detection; required for Phase 1 to detect intrabar breaches).

**Behavior:**

- When `bar.high >= position.takeProfit`, the exit reason is `take_profit` and the fill price is clamped to **exactly `takeProfit`**. It never fills above (TP is a limit sell; no price improvement is assumed).
- When `bar.low <= position.stopLoss`, the exit reason is `stop_loss` and the stop level is the starting point for Phase 2 slippage.
- When both TP and SL are breached in the same bar, the tie is broken by `config.position.intrabarTieBreaker`:
  - `'sl_wins'` (default, conservative) — always pick SL
  - `'tp_wins'` — always pick TP (useful when you know entry happened on a favorable gap)
  - `'by_open'` — whichever target `bar.open` is closer to wins

When `exitPricing !== 'intrabar'`, checkExit falls back to close-based comparisons (the pre-Phase-1 behavior). This is still used for non-TP/SL exits (trailing, signal reversal, time exit).

**Why it matters:** Before Phase 1, a bar whose high hit TP would exit at `bar.close`, which was often already beyond TP. That gifted extra P&L that a real limit order could never collect.

---

## Phase 2 — SL stop-market slippage

**Location:** `src/core/fill-model.ts` → `slipSellPrice()`

**Called from:** `position-manager.checkExit()` whenever the exit reason is `stop_loss` (hard SL breach, both-breached tie where SL wins, or trailing-stop trigger).

**Model:**

```
fillPrice = stopPrice - min(sizeImpact + spreadImpact + eodImpact, cap)
         clamped to a $0.01 floor

sizeImpact   = slSlipPerContract × qty
spreadImpact = context.spread × slSpreadFactor          (0 if slSpreadFactor=0)
eodImpact    = slEodPenalty                              (0 unless inside slEodWindowMin)
cap          = slSlipMax > 0 ? slSlipMax : sizeImpact + spreadImpact + eodImpact
```

Rationale: a stop-market sell sweeps the bid-side book. For small size, only the top of book matters; for large size, you walk deeper. Under wide spreads or in the last 15 minutes of 0DTE (when liquidity evaporates), the slip gets worse.

**Knobs** (all under `config.fill.slippage`):

| Key | Default | Notes |
|---|---|---|
| `slSlipPerContract` | `0.002` | $ per contract knocked off SL fill. $0.002 × 100-lot = $0.20 |
| `slSlipMax` | `0.50` | Absolute cap on SL slippage dollars per option |
| `slSpreadFactor` | `0` | Multiplier on observed `bar.spread` (recommended: `0.5`) |
| `slEodPenalty` | `0` | Flat $ penalty inside the EOD window |
| `slEodWindowMin` | `15` | Minutes before `risk.cutoffTimeET` the EOD penalty applies |

All-zero settings reproduce pre-Phase-2 behavior (`slFillPrice === stopPrice`).

---

## Phase 3 — Market-buy entry slippage

**Location:** `src/core/fill-model.ts` → `slipBuyPrice()`

**Called from:** `trade-manager.evaluateEntry()` (fresh entries) and `replay/machine.ts` (re-entries after a TP).

**Model:**

```
fillPrice = rawPrice + min(entrySlipPerContract × qty, entrySlipMax)
         clamped to $0.01 floor
```

**Call order matters:** qty is sized off the **pre-slippage** effective entry (`unslippedEffective = frictionEntry(candidate.price)`), so slippage doesn't feed back into sizing. Then Phase 4 possibly caps qty. Then Phase 3 applies slippage to the raw price. Then friction adds the standing half-spread for the accounting effective entry.

```
candidate.price (raw mid)
  → frictionEntry()  → unslippedEffective
  → computeQty(unslippedEffective, ...)                    ← qty uses unslipped price
  → Phase 4 cap (may lower qty, may skip trade)
  → slipBuyPrice(candidate.price, qty, slip)               ← Phase 3 raw-price slip
  → frictionEntry()  → effectiveEntry                      ← used for TP/SL anchoring
  → roundToOptionTick() on TP & SL
```

**Knobs** (under `config.fill.slippage`):

| Key | Default | Notes |
|---|---|---|
| `entrySlipPerContract` | `0.002` | $ per contract added to entry fill |
| `entrySlipMax` | `0.50` | Cap on total entry slippage |

Setting `entrySlipPerContract = 0` reproduces pre-Phase-3 behavior.

---

## Phase 4 — Participation-rate liquidity gate

**Location:** `src/core/trade-manager.ts:276-289` (fresh entries) and `src/replay/machine.ts:960-967` (re-entries).

**Model:**

```
maxFill = floor(bar.volume × participationRate)
qty     = min(sizedQty, maxFill)
if qty < minContracts → skip trade entirely
```

Rationale: you cannot realistically take more than ~20% of a bar's printed volume without moving the market. Historically the replay happily took 1,000 contracts on a bar that only printed 30 — pure phantom sizing.

**Knobs** (under `config.fill`):

| Key | Default | Notes |
|---|---|---|
| `participationRate` | `0.20` | Cap = 20% of signal-bar volume. `undefined` disables the gate |
| `minContracts` | `1` | If the capped qty falls below this, skip the trade |

Setting `participationRate = undefined` (omit the key) reproduces pre-Phase-4 behavior.

**Interaction with sizing:** Phase 4 caps the qty produced by `computeQty()`. It does NOT re-size based on slippage — that would create a feedback loop. Sizing sees the unslipped price; the gate just truncates.

**Interaction with `maxContracts`:** the `config.sizing.maxContracts` cap is the sizing-side upper bound. Phase 4 is the liquidity-side upper bound. A config with `maxContracts: 1000` and `participationRate: 0.20` on a bar with `volume: 30` gets qty = 6. Before Phase 4, that same config would have fired 1000 contracts into a 30-contract bar.

---

## End-to-end P&L flow

For a single long option trade (entry → TP or SL exit):

```
ENTRY
  raw_entry = candidate.price (bar mid at signal)
  qty       = computeQty(frictionEntry(raw_entry), ...)
  qty       = min(qty, floor(bar.volume × participationRate))    [Phase 4]
  if qty < minContracts: SKIP
  raw_entry = slipBuyPrice(raw_entry, qty, slip)                  [Phase 3]
  eff_entry = frictionEntry(raw_entry)                            [+$0.05 half-spread]
  takeProfit = roundToOptionTick(eff_entry × tpMultiplier)
  stopLoss   = roundToOptionTick(eff_entry × (1 - slPct/100))

EXIT (intrabar detection)
  if bar.high >= takeProfit and bar.low <= stopLoss:
      resolve tie per config.position.intrabarTieBreaker          [Phase 1]
  elif bar.high >= takeProfit:
      exit_price = takeProfit                                     [Phase 1 clamp]
      exit_kind  = 'tp'
  elif bar.low <= stopLoss:
      exit_price = slipSellPrice(stopLoss, qty, slip, context)    [Phase 2 + Phase 1]
      exit_kind  = 'sl'
  else:
      (continue — non-TP/SL exits fall through to close-based logic)

P&L
  eff_exit = frictionTpExit(exit_price)      if exit_kind == 'tp'      [no half-spread]
           = frictionSlExit(exit_price)      if exit_kind == 'sl'      [-$0.05]
           = frictionMarketExit(exit_price)  otherwise                 [-$0.05]
  pnl$    = (eff_exit - eff_entry) × qty × 100 − frictionCommission(qty)
          = (eff_exit - eff_entry) × qty × 100 − ($0.35 × qty × 2)
```

The TP path specifically does NOT pay the exit half-spread — limit sells provide liquidity instead of crossing the spread. This is the single biggest correction Phase 1 + friction rework made together vs. the pre-phase behavior.

---

## Defaults in `DEFAULT_CONFIG`

Located at `src/config/defaults.ts:204-219`:

```ts
fill: {
  slippage: {
    slSlipPerContract:   0.002,
    slSlipMax:           0.50,
    entrySlipPerContract: 0.002,
    entrySlipMax:        0.50,
    // slSpreadFactor, slEodPenalty both default to 0 (disabled)
  },
  participationRate: 0.20,
  minContracts:       1,
}
```

Default `config.exit.exitPricing` is `'intrabar'` (Phase 1 on). Default `config.position.intrabarTieBreaker` is `'sl_wins'`.

---

## Testing

- `tests/core/fill-model.test.ts` — slipSellPrice / slipBuyPrice unit tests including context handling and edge cases.
- `tests/core/position-manager.test.ts` — intrabar TP/SL clamping and tie-breaker behavior.
- `tests/core/trade-manager.test.ts` — participation gate + entry slippage + sizing order-of-operations.
- `tests/core/strategy-engine.test.ts` — end-to-end signal → entry → exit with the full fill model active.

**Replay parity check:** after any Phase 2/3/4 knob change, run `npx tsx src/replay/cli.ts backtest --dates=2026-02-20,...,2026-03-20` across the 22-day replay library and diff the composite-score delta per config. Phantom-sizing configs (those with `maxContracts > 100`) should drop disproportionately — that's the signal that the gate is working.

---

## Validation from the 2026-04-19 full sweep

The sweep re-ran all 243 configs × 266 dates under the Phase 1–4 model (64,637 pairs, 3 hours, 0 systemic failures). Results stored in `replay_results`.

- **Top realistic configs** (cap ≤ 10): worst day under $1K. `hma3x15-itm5-tp125x-sl40-3m v3` led with 66.4% WR, +$20.5K/day, worst −$266.
- **Phantom-sizing configs** (cap > 100): still posted huge raw P&L but with worst days of −$10K to −$48K, exactly the damage pattern Phase 4 was designed to expose.
- **Broken configs** (`TP0.4x SL4%`, `nosl` variants) score 0.0 under the composite — the clamp + participation gate removed their prior phantom wins.

Leaderboard at `http://localhost:3601/replay/sweep` reflects all of the above.
