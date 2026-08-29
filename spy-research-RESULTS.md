# SPY pattern research — Krafer premise (1h/2h/4h/1d)

Walk-forward 70/30 per TF. Baseline to beat = BUY&HOLD SPY Sharpe (SPY drifts up). Gates: ≥500 trades, |dir-z|>1.96, Δ-Sharpe>+0.2.

| TF | buy&hold Sharpe | survivors |
|----|-----------------|-----------|
| 1d (N_sr=20,N_tr=50) | 0.94 | NONE |
| 1h (N_sr=24,N_tr=50) | 2.00 | NONE |
| 2h (N_sr=24,N_tr=50) | 1.96 | NONE |
| 4h (N_sr=24,N_tr=50) | 2.15 | NONE |

## MTF 1h×1d (test)
base P(up)=0.512; both↑ P(up)=0.505 (n=200); both↓ P(up)=0.484 (n=190).

See scripts/autoresearch/output/spy-research-progress.md for per-signal numbers.

## Conclusion (honest)
NO signal × TF clears both gates (≥500 trades AND |dir-z|>1.96 AND Δ-Sharpe>+0.2 vs buy&hold).

- **Daily (1d, 20y, 1509 test bars, B&H Sharpe 0.94)** — the robust sample:
  - TREND_UP long: n=340, dir-z=-0.05 (NO directional edge), Sharpe 0.71 → Δ-Sharpe -0.22. Trend-following on daily SPY adds nothing beyond buy&hold.
  - SR_SUPPORT: Sharpe 9.01/Δ+8.08 looks spectacular but n=27, z=1.62 — underpowered & not significant (classic small-sample illusion).
  - All gaps (incl. overnight gap-up/down fade): negative Δ-Sharpe.
- **Intraday (1h/2h/4h, cached SPY 1m aggregated, 1.4yr)** — single regime (2025-26 bull tape):
  - TREND_UP long shows positive Sharpe (1h 3.35/Δ1.35, 2h 4.27/Δ2.31, 4h 4.21/Δ2.06) but n=44–161 (<500) and dir-z <1.96 → NOT robust; confounded by drift in one up-regime.
  - All S/R and gap signals negative or n<30.
- **MTF 1h×1d agreement**: no effect (both↑ z=-0.20, both↓ z=-0.76) — unlike the SPX-0DTE intraday MTF (z~2.5); here nothing.

Two bugs found & fixed during the run: (1) P&L was open[i+1]→close[i+1] while direction label was close-to-close (overnight-gap mismatch) — aligned to close-to-close; (2) SPY spread was price-scaled 0.1% = $0.50 half-spread (100x too wide) — set to flat $0.005 (real). After fixes the negative result stands and is not a friction artifact.

Bottom line: on tradeable SPY at 1h–1d, S/R + trend-line + gap patterns do NOT beat buy&hold out-of-sample once properly powered and costed. Consistent with the SPX-index and SPX-0DTE negative results.
