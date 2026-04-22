# Edge-Adjusted Performance Metrics for Intraday Options Strategy Evaluation: An Empirical Framework Using R-Multiples and Breakeven Win Rates

**Working Paper — April 2026**

---

## Abstract

We present an empirical framework for evaluating intraday options trading strategies that replaces composite scoring with statistically grounded edge metrics. Using a dataset of 4.09 million simulated trades across 740 strategy configurations and 267 trading days (March 2025–April 2026) on 0DTE SPX options, we demonstrate that conventional performance measures — including win rate, Sharpe ratio, and weighted composite scores — systematically misidentify losing strategies as top performers. We introduce an edge-based ranking system built on three metrics: the R-multiple (average win percentage divided by average loss percentage), the breakeven win rate implied by a strategy's payoff asymmetry, and the edge (observed win rate minus breakeven win rate). We show that 38% of strategies with win rates exceeding 70% carry negative edge and lose money, while strategies with 59% win rates but R-multiples above 2.8 generate the highest risk-adjusted returns. Quarter-over-quarter walk-forward analysis across four independent 67-day windows demonstrates coefficient of variation below 0.10 on edge estimates for top strategies, confirming temporal stability. All results survive Bonferroni correction for 740 simultaneous hypothesis tests at the 0.05 family-wise significance level. The framework is implemented in a production replay system with realistic transaction cost modeling including participation-rate liquidity constraints, price-proportional spread scaling, and order-type-specific slippage.

**Keywords:** options trading, strategy evaluation, R-multiple, edge metrics, 0DTE options, walk-forward analysis, multiple testing correction, payoff asymmetry

**JEL Classification:** G11, G13, G17, C12

---

## 1. Introduction

### 1.1 The Problem with Win Rate

Win rate is the most commonly cited performance metric in options trading. A strategy that wins 75% of its trades is intuitively appealing and commercially marketable. Yet win rate alone is meaningless without reference to the payoff structure of wins versus losses — a fact well-established in probability theory but persistently ignored in practice.

Consider a 0DTE SPX options strategy with a tight take-profit at 10% of entry price and a stop-loss at 50%. This strategy can achieve win rates exceeding 74% while losing money on every calendar month for over a year. The reason is arithmetic: five wins at +10% each (+50%) are erased by one loss at -50%, requiring a win rate above 83.3% merely to break even. A 74.9% win rate against an 83.3% breakeven threshold produces -8.4% negative edge per trade — a systematic bleed that no amount of position sizing can overcome.

This paper formalizes the relationship between win rate, payoff asymmetry, and true strategic edge. We propose replacing composite scores with a three-metric framework that makes the break-even constraint explicit, and we validate it against the largest intraday options backtesting dataset we are aware of in the literature.

### 1.2 Contributions

1. **An edge-based ranking framework** that decomposes strategy performance into win rate, payoff ratio (R-multiple), and the gap between observed and required win rates (edge).
2. **Empirical demonstration** that 38% of high-win-rate strategies (WR > 70%) carry negative edge, using 740 configurations tested across 267 trading days.
3. **Walk-forward stability analysis** showing top strategies maintain edge with coefficient of variation below 0.10 across four independent quarterly windows.
4. **A fill model specification** that incorporates participation-rate liquidity constraints, preventing phantom sizing where backtested strategies "trade" quantities exceeding printed bar volume.
5. **A production-validated implementation** that computes edge metrics from pre-aggregated SQL columns, enabling real-time leaderboard ranking across hundreds of configurations without parsing millions of trade records.

### 1.3 Related Work

The concept of expectancy — the expected profit per dollar risked — has roots in Kelly (1956) and was popularized for trading by Tharp (2006). The R-multiple framework, where trade outcomes are normalized to units of initial risk, originates in Tharp's work but lacks formal statistical treatment in the academic literature.

In options-specific research, the profitability of short-dated options strategies has been studied by Israelov and Nielsen (2015) on S&P 500 index options and by Andersen et al. (2017) on high-frequency options data. However, these studies focus on option pricing efficiency rather than signal-based entry evaluation.

Our work differs in three respects: (1) we evaluate directional entry signals on 0DTE options rather than volatility harvesting strategies, (2) we explicitly model the multiple testing problem inherent in strategy optimization, and (3) we provide a framework for comparing strategies with fundamentally different payoff structures on a common scale.

---

## 2. Methodology

### 2.1 Edge Metric Definitions

For a strategy with observed win rate $\hat{p}$, average winning trade return $\bar{W}$ (in percent), and average losing trade return $\bar{L}$ (in percent, negative), we define:

**R-Multiple:**

$$R = \frac{\bar{W}}{|\bar{L}|}$$

The ratio of average win magnitude to average loss magnitude. $R > 1$ indicates wins are larger than losses on average; $R < 1$ indicates losses dominate.

**Breakeven Win Rate:**

$$p^* = \frac{|\bar{L}|}{\bar{W} + |\bar{L}|} = \frac{1}{1 + R}$$

The minimum win rate required for non-negative expected value given the observed payoff ratio. This is derived from setting $E[PnL] = p \cdot \bar{W} + (1-p) \cdot \bar{L} = 0$ and solving for $p$.

**Edge:**

$$\varepsilon = \hat{p} - p^*$$

The excess win rate above breakeven. Positive edge indicates a profitable strategy; negative edge indicates a losing strategy regardless of absolute win rate.

**Expected Value per Trade:**

$$EV = \hat{p} \cdot \bar{W} + (1 - \hat{p}) \cdot \bar{L}$$

The expected percentage return per trade, incorporating both win rate and payoff asymmetry.

### 2.2 Relationship Between Metrics

The edge framework reveals the implicit constraint that composite scores obscure. For a strategy with $R = 0.20$ (wins are one-fifth the size of losses), the breakeven win rate is:

$$p^* = \frac{1}{1 + 0.20} = 83.3\%$$

Even a 75% win rate — conventionally considered excellent — yields $\varepsilon = 75\% - 83.3\% = -8.3\%$ negative edge. Conversely, a strategy with $R = 3.0$ requires only $p^* = 25\%$ to break even, meaning a 60% win rate delivers $\varepsilon = +35\%$ edge.

### 2.3 Statistical Inference

For a strategy with $n$ trades and observed win rate $\hat{p}$, we test the null hypothesis $H_0: p = p^*$ (strategy has zero edge) against the alternative $H_1: p > p^*$ using the z-statistic:

$$z = \frac{\hat{p} - p^*}{\sqrt{p^*(1 - p^*) / n}}$$

To account for testing $K = 740$ strategy configurations simultaneously, we apply the Bonferroni correction:

$$\alpha_{corrected} = \frac{\alpha}{K} = \frac{0.05}{740} = 6.76 \times 10^{-5}$$

This corresponds to a required z-score of approximately 4.08 for any individual strategy to be declared statistically significant at the family-wise $\alpha = 0.05$ level.

### 2.4 Walk-Forward Stability

To assess temporal stability independent of in-sample optimization, we partition the 267-day sample into four non-overlapping quarterly windows of approximately 67 days each and compute edge independently in each window. We report the coefficient of variation:

$$CV(\varepsilon) = \frac{\sigma(\varepsilon_1, \varepsilon_2, \varepsilon_3, \varepsilon_4)}{|\bar{\varepsilon}|}$$

Strategies with $CV < 0.10$ are considered temporally stable; those with $CV > 0.25$ are flagged as regime-dependent.

---

## 3. Data and Simulation Environment

### 3.1 Dataset

The study uses historical OPRA trade data for SPX Weekly (SPXW) 0DTE options from March 27, 2025 through April 20, 2026, comprising 267 trading days. SPX underlying data is sourced from Polygon.io; options data from ThetaData. Both sources provide tick-level trade prints aggregated to 1-minute OHLCV bars.

For each trading day, the system tracks approximately 200–480 option contracts within a $\pm$100 strike band around the current SPX price. Each contract maintains a full indicator battery computed incrementally: Hull Moving Average (HMA) at multiple periods, Exponential Moving Average (EMA), Relative Strength Index (RSI-14), Bollinger Bands, Average True Range (ATR-14), and Volume-Weighted Average Price (VWAP).

### 3.2 Signal Generation

All 740 strategy configurations share a common signal architecture: HMA crossover detection on option contract price bars. A bullish HMA(fast) $\times$ HMA(slow) cross on a call contract's price series generates a buy signal for that call; similarly for puts. The SPX underlying HMA direction serves as an optional direction gate.

Configuration parameters vary across:
- HMA periods: fast $\in \{3, 5\}$, slow $\in \{12, 15, 19, 25\}$
- Signal timeframe: $\in \{1m, 3m, 5m\}$
- Take-profit multiplier: $\in \{1.1\times, 1.15\times, 1.25\times, 1.5\times, 2\times, 2.5\times, 3\times, 5\times, 10\times, 30\times\}$
- Stop-loss percentage: $\in \{20\%, 25\%, 35\%, 40\%, 45\%, 50\%, 70\%, 80\%, 85\%, 90\%\}$
- Strike offset: ATM, ITM5, OTM5, OTM10
- Basket vs. single-strike execution
- Direction gate: enabled/disabled

### 3.3 Transaction Cost Model

All trade returns are net of a multi-layer transaction cost model:

1. **Friction (always-on baseline):** Half-spread of max($0.05, entry price $\times$ 1%) per side plus $0.35 commission per contract per side. Applied to all entries and market exits. Take-profit limit orders are modeled as providing liquidity (no half-spread cost).

2. **Entry slippage:** $0.002 per contract book-walk on market buy orders, capped at $0.50 total.

3. **Stop-loss slippage:** $0.002 per contract on stop-market exit orders, capped at $0.50 total.

4. **Participation-rate constraint:** Entry quantity is capped at $\lfloor \text{bar volume} \times 0.20 \rfloor$. If the capped quantity falls below the minimum contract threshold, the trade is skipped entirely. This prevents the common backtesting artifact of "trading" quantities that exceed actual printed volume.

5. **Intrabar TP/SL resolution:** When a bar's range breaches both the take-profit and stop-loss levels, resolution follows configurable tie-breaking rules rather than defaulting to the favorable outcome.

### 3.4 Implementation

The replay engine loads all 1-minute bars for a given date into memory and iterates with binary search. A typical day with 159,000 bars across 648 contracts replays in approximately 5 seconds. Strategy logic is shared between the replay system and the production live trading agent — the same `Config` object produces identical signal detection, strike selection, and exit evaluation in both environments.

Edge metrics are pre-computed at the trade level during replay execution: each daily result record stores `sumWinPct` (sum of pnlPct for winning trades), `cntWins`, `sumLossPct`, and `cntLosses` alongside the traditional aggregate fields. This enables SQL-level aggregation across hundreds of days without re-parsing trade-level JSON — critical for maintaining sub-second leaderboard response times across 211,000+ daily result records.

---

## 4. Results

### 4.1 Descriptive Statistics

Table 1 summarizes the dataset.

| Metric | Value |
|--------|-------|
| Trading days | 267 |
| Strategy configurations | 740 |
| Total trades (all configs) | 4,093,385 |
| Trades per config (mean) | 5,531 |
| Configs with positive edge | 269 (36.4%) |
| Configs with negative edge | 471 (63.6%) |

The distribution of edge across configurations is right-skewed with a long left tail: mean +3.05%, median -5.16%, standard deviation 18.80%. The interquartile range spans from -9.14% (P25) to +21.85% (P75).

### 4.2 Win Rate Is Not Predictive of Profitability

The central finding is that win rate alone does not predict strategy profitability. Among 26 configurations with win rates exceeding 70%, ten (38%) carry negative edge and lose money over the full sample period.

Table 2 illustrates the mechanism with representative configurations.

| Configuration | Win Rate | Avg Win | Avg Loss | R-Multiple | Breakeven WR | Edge | Total P&L |
|--------------|----------|---------|----------|------------|-------------|------|-----------|
| TP1.1x / SL50% (ITM5) | 74.9% | +10.0% | -50.1% | 0.20 | 83.3% | **-8.4%** | **-$1.66M** |
| TP1.1x / SL50% (ATM) | 72.5% | +10.1% | -51.1% | 0.20 | 83.6% | **-11.1%** | **-$3.30M** |
| TP1.15x / SL25% (5m) | 80.6% | +14.5% | -16.5% | 0.88 | 53.2% | **+27.4%** | +$3.78M |
| TP3x / SL90% (ITM5) | 63.2% | +50.3% | -16.0% | 3.14 | 24.2% | **+39.0%** | +$7.20M |
| Basket TP10x / SL25% | 59.0% | +36.6% | -12.8% | 2.86 | 26.2% | **+32.8%** | +$32.3M |

The TP1.1x/SL50% configurations achieve 73-75% win rates — among the highest in the study — yet are the worst performers by edge and total P&L. Their small take-profit (+10%) against a deep stop-loss (-50%) creates a payoff ratio of 0.20, requiring 83%+ win rates merely to break even. The observed 75% win rate, while impressive in isolation, falls 8 percentage points short of this threshold.

Conversely, the TP3x/SL90% configuration wins only 63.2% of trades but achieves the highest edge (+39.0%) because its R-multiple of 3.14 sets the breakeven bar at just 24.2%.

### 4.3 Walk-Forward Temporal Stability

Table 3 presents quarter-by-quarter edge estimates for five representative configurations across four non-overlapping ~67-day windows.

| Configuration | Q1 Edge | Q2 Edge | Q3 Edge | Q4 Edge | CV(Edge) |
|--------------|---------|---------|---------|---------|----------|
| HMA 3x25 ITM5 TP3x SL90% | +40.8% | +41.0% | +37.8% | +36.8% | **0.047** |
| HMA 3x19 OTM0 TP2.5x SL70% | +40.1% | +35.7% | +38.5% | +37.8% | **0.042** |
| Sweep TP2x SL80% | +35.5% | +33.8% | +36.7% | +35.3% | **0.030** |
| Basket 3-strike TP10x SL25% | +35.7% | +28.8% | +32.0% | +36.8% | **0.095** |
| TP1.1x SL50% (negative control) | -9.6% | -6.9% | -8.8% | -8.2% | **0.119** |

All top strategies exhibit coefficient of variation below 0.10, indicating stable edge across market regimes. The negative-edge control configuration is equally stable in its losses, confirming the framework identifies both persistent edge and persistent anti-edge.

Monthly analysis of the top configuration (HMA 3x25 ITM5 TP3x SL90%) reveals no month with negative edge across the 14-month sample period. Edge ranges from +29.4% (March 2025, partial month with 3 trading days) to +43.4% (May and September 2025).

### 4.4 Multiple Testing Correction

With 740 simultaneous hypothesis tests, the Bonferroni-corrected significance threshold requires z > 4.08. Table 4 reports z-scores for selected configurations.

| Configuration | n | z-score | Significant? |
|--------------|---|---------|-------------|
| HMA 3x25 ITM5 TP3x SL90% | 3,509 | 53.9 | Yes |
| HMA 3x19 OTM0 TP2.5x SL70% | 3,822 | 54.5 | Yes |
| Basket TP10x SL25% (AGG) | 24,461 | 117.7 | Yes |
| Basket TP1.25x SL25% (AGG) | 24,461 | 79.4 | Yes |
| Sweep TP2x SL80% | 4,557 | 48.8 | Yes |
| TP1.1x SL50% (negative edge) | 4,138 | -14.5 | Yes (negative) |

All top configurations survive Bonferroni correction by an order of magnitude. The smallest z-score among positive-edge top-10 configurations is 48.8 — approximately 12 times the required threshold. This overdetermination reflects the large sample sizes (3,000–24,000+ trades per configuration) achievable with intraday strategies.

### 4.5 Basket Strategy Analysis

The basket configuration deploys three simultaneous legs per signal event at different strike offsets (ITM5, ATM, OTM5), generating approximately 90 trades per day (30 signal events $\times$ 3 legs) at fixed sizing of 15 contracts per leg at $10,000 per trade.

Table 5 decomposes edge by basket member.

| Member | Edge | R-Multiple | Win Rate | n |
|--------|------|------------|----------|---|
| ITM5 | +35.6% | 2.83 | 61.7% | 8,126 |
| ATM | +34.4% | 3.01 | 59.3% | 8,167 |
| OTM5 | +30.9% | 2.96 | 56.2% | 8,168 |
| **Aggregate** | **+33.4%** | **2.90** | **59.0%** | **24,461** |

ITM5 strikes consistently show the highest edge across basket configurations, while OTM5 strikes show the lowest. This suggests the optimal strike for directional 0DTE plays is slightly in-the-money, where gamma exposure is balanced against time decay and bid-ask spread costs.

### 4.6 Dual-Basket Correlation Analysis

An analysis of running two basket configurations simultaneously — one with TP1.25x (scalping) and one with TP10x (trend-following) — on the same signal reveals:

- **100% signal overlap**: identical entries on every trade across 24,418 matched pairs
- **Daily P&L correlation**: 0.623 (substantial but not perfect)
- **When the scalper takes profit** (n = 11,214 trades): the trend-follower wins 90.9% of the time, averaging +47.7% versus the scalper's +25%
- **When the scalper stops out**: the trend-follower also stops out 100% of the time (identical SL)
- **Combined green days**: 267/267 (vs. 266/267 for trend-follower alone)

This demonstrates a barbell execution structure — the scalp leg provides consistent extraction while the trend leg captures tail moves — achievable without additional signal generation or market exposure timing.

---

## 5. Discussion

### 5.1 Why Composite Scores Fail

The composite score previously used in this system was:

$$Score = (WR \times 40) + (\min(\max(Sharpe, 0), 1) \times 30) + \mathbb{1}_{AvgPnl > 0} \times 20 + \mathbb{1}_{WorstDay > -500} \times 10$$

This formula suffers from three defects:

1. **Win rate is weighted without reference to payoff structure.** A 75% WR contributes 30 points regardless of whether the strategy's breakeven WR is 50% or 85%.

2. **Sharpe ratio is clamped and discretized.** The [0,1] clamp followed by a 30-point multiplier means any Sharpe above 1.0 gets the same score. With daily returns, intraday strategies routinely produce Sharpe > 1 simply through high trade frequency, making this component non-discriminating.

3. **Binary P&L and risk thresholds.** The $AvgPnl > 0$ and $WorstDay > -500$ terms create cliff effects that don't scale with the magnitude of profitability or risk.

The edge framework replaces all four components with a single coherent metric that directly answers the question: "Does this strategy win often enough, given how much it wins and loses, to make money?"

### 5.2 Limitations

**In-sample optimization.** While the walk-forward quarterly analysis demonstrates temporal stability, all 740 configurations were designed with knowledge of the full sample period. A true out-of-sample test would require data from a period not used during strategy development. The 267-day sample should be extended and formally partitioned into training (configuration search) and validation (edge confirmation) windows.

**Non-independence of trades.** The z-test assumes independent observations. Intraday trades on the same underlying, even across different signal events, share common market microstructure, volatility regime, and order flow conditions. The effective sample size may be smaller than the nominal trade count. Clustering standard errors by trading day would provide more conservative inference.

**Survivorship in configuration space.** The 740 configurations tested are themselves a subset of the theoretically possible parameter space. The Bonferroni correction addresses only the tested configurations; it does not account for configurations that were considered and discarded during development.

**Single underlying.** All results are on SPX 0DTE options. Generalizability to other underlyings (NDX, individual equities, ETFs) remains untested, though preliminary results on NDX show qualitatively similar patterns.

**Fill model assumptions.** The participation-rate cap and slippage model, while more realistic than unconstrained backtesting, still assume fills at bar-level prices. Tick-level simulation with full order book modeling would provide tighter bounds on executable P&L.

### 5.3 Implications for Practitioners

The framework yields three actionable insights:

1. **Never evaluate strategies by win rate alone.** Always compute the breakeven win rate implied by the strategy's payoff structure. A "70% win rate" strategy may require 83% to break even.

2. **R-multiples above 2.0 create a wide margin of safety.** With $R = 2.0$, the breakeven win rate is 33%. Even significant degradation in signal quality — from 60% to 45% — would not eliminate profitability.

3. **Fixed sizing isolates signal quality.** By holding position size constant, the edge metric measures purely whether the signal predicts direction and magnitude. Sizing optimization is a separate problem that should be addressed only after edge is confirmed.

---

## 6. Conclusion

We have shown that conventional performance metrics systematically mislead strategy evaluation in intraday options trading. Win rate, the most commonly cited measure, fails to predict profitability when payoff structures vary across strategies. The Sharpe ratio, while theoretically sound, becomes non-discriminating at the high trade frequencies characteristic of 0DTE options strategies.

The edge-based framework — decomposing performance into win rate, R-multiple, breakeven win rate, and the gap between them — provides a statistically grounded alternative that:

- Correctly identifies losing strategies that conventional metrics rank highly
- Survives multiple testing correction across 740 simultaneous hypotheses
- Demonstrates temporal stability with coefficient of variation below 0.10 across quarterly walk-forward windows
- Scales computationally to production deployment over millions of trades

The critical insight is not that win rate is unimportant, but that win rate is meaningful only in the context of what you win and what you lose. A strategy with 59% win rate and R-multiple of 2.9 has stronger, more durable edge than a strategy with 75% win rate and R-multiple of 0.2. Making this relationship explicit transforms strategy evaluation from an exercise in curve-fitting to a question of statistical inference.

---

## References

Andersen, T.G., Bondarenko, O., & Gonzalez-Perez, M.T. (2017). Uncovering the skewness news impact curve. *Journal of Financial Economics*, 126(2), 232-250.

Israeov, R., & Nielsen, L.N. (2015). Covered calls uncovered. *Financial Analysts Journal*, 71(6), 44-57.

Kelly, J.L. (1956). A new interpretation of information rate. *Bell System Technical Journal*, 35(4), 917-926.

Tharp, V.K. (2006). *Trade Your Way to Financial Freedom* (2nd ed.). McGraw-Hill.

Holm, S. (1979). A simple sequentially rejective multiple test procedure. *Scandinavian Journal of Statistics*, 6(2), 65-70.

---

## Appendix A: Full Configuration Parameter Space

| Parameter | Values Tested | Count |
|-----------|--------------|-------|
| HMA Fast Period | 3, 5 | 2 |
| HMA Slow Period | 12, 15, 19, 25 | 4 |
| Signal Timeframe | 1m, 3m, 5m | 3 |
| Take-Profit Multiplier | 1.1x–30x | 10 |
| Stop-Loss Percentage | 20%–90% | 10 |
| Strike Offset | ATM, ITM5, OTM5, OTM10 | 4 |
| Execution Mode | Single, Basket (3-strike, 4-strike, 5-strike) | 4 |
| Direction Gate | Enabled, Disabled | 2 |

Not all combinations were tested; the 740 configurations represent targeted sweeps across this space.

## Appendix B: Edge Metric SQL Aggregation

The pre-computed columns enable efficient edge calculation without trade-level parsing:

```sql
SELECT
  configId,
  SUM(sumWinPct) / NULLIF(SUM(cntWins), 0) AS avgWinPct,
  SUM(sumLossPct) / NULLIF(SUM(cntLosses), 0) AS avgLossPct,
  SUM(wins) * 1.0 / SUM(trades) AS winRate
FROM replay_results
GROUP BY configId
```

R-multiple, breakeven WR, and edge are derived in application code from these four aggregated values.

## Appendix C: Quarterly Walk-Forward Results (All Top-10 Configurations)

| Config | Q1 Edge | Q2 Edge | Q3 Edge | Q4 Edge | Mean | CV |
|--------|---------|---------|---------|---------|------|-----|
| HMA3x25 ITM5 TP3x SL90 | +40.8% | +41.0% | +37.8% | +36.8% | +39.1% | 0.047 |
| HMA3x25 ITM5 TP30x SL25 | +39.5% | +35.0% | +36.5% | +42.1% | +38.3% | 0.077 |
| HMA3x19 UndHMA TP2.5x SL70 | +40.1% | +35.7% | +38.5% | +37.8% | +38.0% | 0.042 |
| HMA3x19 TP2.5x SL70 3m | +39.5% | +33.3% | +34.7% | +35.8% | +35.8% | 0.071 |
| Sweep TP2x SL80 | +35.5% | +33.8% | +36.7% | +35.3% | +35.3% | 0.030 |
| Basket TP10x SL25 (AGG) | +35.7% | +28.8% | +32.0% | +36.8% | +33.3% | 0.095 |

---

*Correspondence: [Author details to be added]*

*Data availability: The replay dataset and strategy configurations are maintained in a SQLite database. The edge metric computation is open-source and integrated into the SPXer replay system.*
