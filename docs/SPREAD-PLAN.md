# Spread Trading — Revised Implementation Plan

## Core Concept

**Reuse the existing signal + strike selection entirely.** The config already picks a contract (e.g., CALL 6605 @ $9.90). The spread feature asks: "what if we structured a spread around this same contract instead of buying it outright?"

The selected contract becomes the **anchor leg**. The other leg is the anchor strike ± width. We test all combinations and compare.

## What Gets Tested (Automatically)

For every trade signal the existing system generates:

| Mode | Anchor Leg | Other Leg | You Pay/Collect |
|------|-----------|-----------|-----------------|
| **Straight buy** (existing) | Buy CALL 6605 @ $9.90 | — | Pay $9.90 |
| **Debit spread $5** | Buy CALL 6605 @ $9.90 | Sell CALL 6610 @ $7.50 | Pay $2.40 |
| **Debit spread $10** | Buy CALL 6605 @ $9.90 | Sell CALL 6615 @ $5.80 | Pay $4.10 |
| **Debit spread $15** | Buy CALL 6605 @ $9.90 | Sell CALL 6620 @ $4.30 | Pay $5.60 |
| **Credit spread $5** | Sell CALL 6605 @ $9.90 | Buy CALL 6600 @ $12.00 | Pay $2.10 (debit) |
| **Credit spread $5** | Sell CALL 6605 @ $9.90 | Buy CALL 6610 @ $7.50 | Collect $2.40 |

Wait — this needs clarifying. Let me define it precisely:

### Debit Spread (directional, cheaper than outright buy)
- **Buy** the anchor (what we'd normally buy outright)
- **Sell** a further-OTM contract (anchor + width) to reduce cost
- Max profit = width - debit paid
- Max loss = debit paid
- Lower cost, capped upside

### Credit Spread (sell premium, profit from theta/direction)
- **Sell** the anchor contract
- **Buy** a further-OTM contract (anchor + width) for protection
- Max profit = credit collected
- Max loss = width - credit
- Collect premium upfront, profit if price stays away

### What the config looks like

```typescript
spread: {
  enabled: boolean;          // false = straight buy (existing behavior)
  mode: 'debit' | 'credit'; // debit = buy anchor + sell further OTM
                             // credit = sell anchor + buy further OTM
  width: number;             // 5, 10, or 15 ($)
}
```

That's it. Three fields. Everything else comes from the existing config:
- Signal: HMA cross (from config.signals)
- Anchor contract: strike selector picks it (from config.strikeSelector + config.signals)
- Direction: bullish → calls, bearish → puts (from existing tick() logic)
- Exit: same scannerReverse / TP / SL logic, applied to spread price
- Sizing: based on max risk (debit paid or width - credit) instead of contract price

## Implementation Design

### No changes to tick() or signal detection

`tick()` continues to produce the same `entry` result it does now. The spread overlay happens at the **execution layer** — between tick() deciding "buy CALL 6605" and the position being created.

### New: `applySpreadOverlay(entry, candidates, config)` 

Takes tick()'s entry decision and converts it to a spread:

```
Input:  entry = { symbol: CALL 6605, price: $9.90, side: call, strike: 6605 }
Config: spread = { mode: 'debit', width: 10 }

Output: {
  anchorLeg: { symbol: CALL 6605, price: $9.90, action: 'buy' },
  otherLeg:  { symbol: CALL 6615, price: $5.80, action: 'sell' },
  spreadPrice: $4.10 (debit),
  maxLoss: $4.10,
  maxProfit: $5.90 (width - debit),
}
```

For credit mode, flip the actions:
```
anchorLeg: { symbol: CALL 6605, price: $9.90, action: 'sell' },
otherLeg:  { symbol: CALL 6610, price: $7.50, action: 'buy' },
spreadPrice: $2.40 (credit),
maxLoss: $2.60 (width - credit),
maxProfit: $2.40,
```

### Spread position tracking

New `SpreadPosition` extends the concept but both legs need price tracking:

```typescript
interface SpreadPosition {
  id: string;
  anchorSymbol: string;      // the contract tick() selected
  otherSymbol: string;       // anchor ± width
  anchorStrike: number;
  otherStrike: number;
  side: 'call' | 'put';
  mode: 'credit' | 'debit';
  width: number;
  qty: number;
  entrySpreadPrice: number;  // net debit or credit at entry
  maxLoss: number;
  maxProfit: number;
  entryTs: number;
  stopLoss: number;          // spread price that triggers SL
  takeProfit: number;        // spread price that triggers TP
}
```

### Spread price at each timestamp

```
For debit spread (bought anchor, sold other):
  spreadValue = anchorPrice - otherPrice
  P&L = (spreadValue - entryDebit) × qty × 100

For credit spread (sold anchor, bought other):  
  spreadValue = anchorPrice - otherPrice  (what it would cost to close)
  P&L = (entryCredit - spreadValue) × qty × 100
```

### Exit logic

Same signals, different price check:
- **Signal reversal**: same — exit when HMA reverses (close both legs)
- **Take profit**: spread price reaches TP threshold
  - Debit: spreadValue >= entryDebit × takeProfitMultiplier
  - Credit: spreadValue <= entryCredit × (1 - takeProfitPct) (spread collapsed)
- **Stop loss**: spread price hits max loss threshold
  - Debit: spreadValue <= entryDebit × (1 - stopLossPct)
  - Credit: spreadValue >= (width - entryCredit) × stopLossPct
- **Time exit**: same — close at cutoff

### Replay integration

In `runDeterministicReplay()`:

```
// After tick() returns an entry...
if (config.spread?.enabled && result.entry) {
  // Find the other leg's price from bar cache
  const otherStrike = computeOtherStrike(result.entry, config.spread);
  const otherPrice = getContractPriceAt(cache, otherStrike, ts);
  
  if (otherPrice) {
    // Create spread position instead of single-leg position
    const spread = buildSpreadPosition(result.entry, otherPrice, config.spread);
    state.spreads.set(spread.id, spread);
  }
}

// For exit checks, compute spread value from both leg prices
for (const spread of state.spreads.values()) {
  const anchorPrice = getPrice(spread.anchorSymbol, ts);
  const otherPrice = getPrice(spread.otherSymbol, ts);
  const spreadValue = anchorPrice - otherPrice;
  // Check TP/SL/reversal against spreadValue
}
```

### Position sizing

For debit spreads: qty = floor(baseDollarsPerTrade / (debit × 100))
For credit spreads: qty = floor(baseDollarsPerTrade / (maxLoss × 100))
  where maxLoss = width - credit

### Friction model

4 commissions per round-trip (open 2 legs + close 2 legs):
```
spreadCommission = $0.35 × qty × 4 = $1.40 per contract round-trip
```

Plus half-spread on each leg entry and exit (4 × $0.05 = $0.20 total friction per contract).

## File Changes (Revised)

| File | Change | Effort |
|------|--------|--------|
| `src/config/types.ts` | Add 3-field `spread` section | Small |
| `src/config/defaults.ts` | Add spread defaults | Small |
| `src/core/types.ts` | Add `SpreadPosition`, `SpreadLeg` | Small |
| `src/core/friction.ts` | Add `computeSpreadPnl()` | Small |
| `src/replay/machine.ts` | Spread overlay in `runDeterministicReplay()` | Medium |
| `src/replay/types.ts` | Extend `Trade` with spread fields | Small |
| `src/server/replay-viewer.html` | Spread config fields + trade display | Small |

**NOT changing:** `tick()`, `strategy-engine.ts`, `strike-selector.ts`, `position-manager.ts` — the signal/selection logic is untouched.

## Sweep Strategy

Once built, run a sweep across all combinations:

```
For each existing top config:
  For each mode in [debit, credit]:
    For each width in [5, 10, 15]:
      Run 255-day replay
      Store as: {configId}-spread-{mode}-w{width}
```

9 top configs × 2 modes × 3 widths = 54 spread configs + 9 baseline (straight buy) = 63 configs × 255 days = 16,065 replays (~20 min at 14/sec).

Compare: straight buy P&L vs debit spread vs credit spread at each width. The results will show whether spreads produce better risk-adjusted returns for the same signals.

## Phases

1. **Types + Config** (15 min) — spread section in config, SpreadPosition type
2. **Spread P&L + Friction** (15 min) — computeSpreadPnl, 4-leg commission
3. **Replay Engine** (45 min) — spread overlay in runDeterministicReplay, both leg price tracking, exit logic
4. **Config UI** (15 min) — spread fields in replay viewer form
5. **Test + Sweep** (30 min) — run spread backtests, compare results
