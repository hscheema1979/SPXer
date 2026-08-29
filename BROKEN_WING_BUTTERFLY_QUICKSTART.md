# Broken-Wing Butterfly (BWB) — Quick Start

## What It Is

A **4-leg defined-risk credit structure** with asymmetric wings:
```
Short put @ SPX, Long put @ SPX − putWingWidth
Short call @ SPX, Long call @ SPX + callWingWidth
```

Example: `BWB 5w10` = 5-point put wing (tight), 10-point call wing (wide). Bullish bias.

## Running the Sweep

### Full run (all dates, parallel)
```bash
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine broken-wing-butterfly --shards 8
```

### Include in nightly (`--engine both`)
```bash
# Now runs: credit → iron → broken-wing-butterfly
npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine both --shards 8
```

### Single-day debug
```bash
SWEEP_ALLOW_SERIAL=1 npx tsx scripts/diag/broken-wing-butterfly-sweep.ts --symbol SPX --dates 2026-05-24
```

## Output

Results append to `scripts/autoresearch/output/spread-sweep.json`:
- Keeps all existing iron/credit rows
- Adds new BWB rows with structure labels: `BWB 5w10`, `BWB 5w15`, etc.
- No dashboard changes needed — auto-detected by prefix

## Structure Labels

| Label | Meaning |
|-------|---------|
| `BWB 5w10` | 5-pt put wing (tight, downside protection), 10-pt call wing (wide, upside) — **bullish** |
| `BWB 10w5` | 10-pt put wing (wide, downside), 5-pt call wing (tight, upside protection) — **bearish** |
| `BWB 5w5` | Symmetric (same as iron butterfly) |

## Max Risk Calculation

```
Max Risk = min(putWingWidth, callWingWidth) − credit
```

The **narrower wing caps total loss** regardless of how wide the other side is.

## Exit Logic

Identical to iron-sweep:
- **TP-only**: exit when P&L reaches X% of credit (5%, 6%, 7%, 10%, 15%, 20%, 25%, 50%, 75%)
- **TP + SL**: also exit if loss exceeds Y% of max risk (50%, 60%, 70%, 80%)
- **TP + flip**: close early if opposite direction confirmed
- **Hold-to-settle**: 0DTE close at intrinsic
- **Flip-only**: exit on signal reversal only

## Verify Append Worked

```bash
bash /tmp/verify-bwb-append.sh
```

Shows:
- Total rows in spread-sweep.json
- Iron rows, BWB rows, credit rows
- Sample BWB results

## Code Files

| File | Purpose |
|------|---------|
| `scripts/diag/broken-wing-butterfly-sweep.ts` | Main sweep engine (505 lines) |
| `scripts/diag/sweep-parallel.ts` | Parallel orchestrator (updated line 70) |
| `scripts/autoresearch/backtest-server.ts` | Parser for `BWB Nw M` labels |

## Backtest Server API

When you query a BWB structure via backtest-server, it parses as:
```javascript
{
  kind: "bwb",
  putWingWidth: 5,
  callWingWidth: 10
}
```

Used for live trading integration (future: `take-live` endpoint).

## Expected Performance

- **Per date**: ~8–10 seconds for all BWB variants
- **280-day dataset**: ~5–8 minutes on 8 shards
- **Output**: 15k–20k BWB rows per sweep (adds to 40k+ existing iron/credit)

## Coexistence

No conflicts with existing sweeps. All three types share the same `spread-sweep.json`:
- **Iron** (`IB w10`, `IC 20w10`): 20k+ rows
- **Credit** (`ATM w5`, `5OTM w10`): 15k+ rows  
- **BWB** (`BWB 5w10`, `BWB 10w5`): 15k–20k rows
- **Total**: 50k–55k rows on the dashboard

De-dup on re-run removes prior BWB rows; iron/credit rows preserved.

---

**Status**: Sweep running. Check `/tmp/bwb-sweep.log` for progress.
