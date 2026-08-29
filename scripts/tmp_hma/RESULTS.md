# HMA 3x9 vs 3x12 vs 3x21 (1m) — long SPX 0DTE, trailing-stop exit, 301 days (2025-03-27..2026-06-22)

## Trailing-stop framework (reversal exit OFF) — PRIMARY
| config | totalPnL | trades | win% | PF | maxDD | avg/day |
|---|---|---|---|---|---|---|
| 3x9_1m  | -259,569 | 15088 | 47.4% | 0.72 | -262,483 | -862 |
| 3x12_1m | -259,230 | 14363 | 47.1% | 0.71 | -261,258 | -861 |
| 3x21_1m | -199,338 | 12134 | 47.9% | 0.73 | -200,040 | -662 |
Rank: 3x21 > 3x12 > 3x9. 3x21 loses ~$60k less.

## Same entries, engine reversal exit ON (for reference)
| config | totalPnL | trades | win% | PF | maxDD |
|---|---|---|---|---|---|
| 3x9_1m  | -153,381 | 14536 | 38.5% | 0.74 | -159,151 |
| 3x12_1m | -193,868 | 13820 | 38.1% | 0.68 | -195,603 |
| 3x21_1m | -159,313 | 11818 | 41.3% | 0.72 | -161,708 |

All three lose money. 1 contract / $100 multiplier sizing. PnL is exit-vs-entry option price
diff x100, NO commission/slippage friction applied (gross). Strike = engine dynamic OTM.
