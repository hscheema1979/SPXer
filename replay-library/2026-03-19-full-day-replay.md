# SPX 0DTE Full-Day Replay — March 19, 2026

## Quick Reference

- **Date**: March 19, 2026 (Wednesday)
- **SPX Range**: 6558 (open) → 6634 (high) → 6573 (low) → 6606 (close)
- **Key Contracts**: SPXW260319C06600000, SPXW260319C06615000
- **Database**: `/home/ubuntu/SPXer/data/spxer.db`
- **Tables**: `bars` (price data), `contracts` (option chain metadata)
- **Replay Logs**: `/home/ubuntu/SPXer/logs/replay-report.json`, `/home/ubuntu/SPXer/logs/hypothesis-review.log`

### DB Queries to Reproduce Any Chapter

```sql
-- SPX 1m bars for any time window (adjust timestamps)
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi,
  json_extract(indicators, '$.ema9') as ema9,
  json_extract(indicators, '$.ema21') as ema21,
  json_extract(indicators, '$.hma5') as hma5
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= {start_ts} AND ts <= {end_ts}
ORDER BY ts;

-- Option prices at a specific moment
SELECT c.strike, c.type, b.close as opt_price, b.volume
FROM bars b JOIN contracts c ON b.symbol=c.symbol
WHERE b.symbol LIKE 'SPXW260319%' AND b.timeframe='1m'
  AND b.ts = (SELECT MAX(b2.ts) FROM bars b2
              WHERE b2.symbol=b.symbol AND b2.timeframe='1m' AND b2.ts<={moment_ts})
  AND c.strike BETWEEN {low_strike} AND {high_strike}
ORDER BY c.type, c.strike;

-- Track a specific contract through the day
SELECT datetime(b.ts, 'unixepoch', '-4 hours') as et, b.close, b.high, b.low
FROM bars b
WHERE b.symbol='{contract_symbol}' AND b.timeframe='1m'
  AND b.ts >= 1773927000 AND b.ts <= 1773950400
ORDER BY b.ts;
```

### Timestamp Reference (Unix → ET)

| ET Time | Unix Timestamp | Note |
|---------|---------------|------|
| 09:30 | 1773927000 | Market open |
| 09:50 | 1773928200 | Signal #1 (RSI=85.7) |
| 10:12 | 1773929520 | Stop-loss #1 |
| 11:30 | 1773934200 | Signal #2 (RSI=19.3) |
| 12:56 | 1773939360 | Signal #3 (RSI=17.0) |
| 13:14 | 1773940440 | Signal #4 (RSI=19.4) |
| 13:27 | 1773941220 | Signal #5 (RSI=89.5) |
| 14:34 | 1773945240 | Signal #6 (RSI=8.4) ★ |
| 14:57 | 1773946620 | Signal #7 (RSI=82.2) |
| 15:07 | 1773947220 | C6600 peak ($33.82) |
| 16:00 | 1773950400 | Market close |

### Expiry Data in DB

| Expiry | Type | Contracts | Note |
|--------|------|-----------|------|
| 260319 | call/put | 63 each | **0DTE** — this replay |
| 260320 | call/put | 65 each | 1DTE — different prices (~$20 more time value) |
| 260323 | call/put | 43 each | 2DTE (Monday) |

---

## Chapter 1: The Blind Opening (09:30–09:44)

**SPX**: 6558 → 6580 | **RSI**: not computed | **System**: DARK

```sql
-- Chapter 1 data
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi,
  json_extract(indicators, '$.hma5') as hma5,
  json_extract(indicators, '$.ema9') as ema9
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773927000 AND ts <= 1773928080
ORDER BY ts;
```

The first 14 minutes are among the most violent of the open — and the system is completely blind. RSI-14 needs 14 bars to warm up.

| Time | SPX | Move | RSI | HMA5 | Key Event |
|------|-----|------|-----|------|-----------|
| 09:30 | 6558.31 | — | — | — | Open. C6600=$3.40, C6615=$1.17 |
| 09:32 | 6570.26 | +12 | — | — | Aggressive gap-up buying |
| 09:34 | 6566.85 | -4 | — | — | First red bar, pullback |
| 09:35 | 6566.16 | -1 | — | 6566.2 | HMA5 born — at price, no signal |
| 09:36 | 6562.56 | -4 | — | 6562.6 | Two red bars. P6570 vol=282 (heaviest on board) |
| 09:38 | 6569.52 | +7 | — | 6566.2 | V-bounce. HMA5 turns sharply up |
| 09:40 | 6570.30 | +1 | — | 6572.2 | Back to highs, consolidation |
| 09:41 | 6578.77 | +8 | — | 6576.9 | Breakout candle |
| 09:44 | 6579.92 | +1 | 76.5 | 6580.6 | **RSI finally computes** — already overbought |

**Option chain at 09:35** (heaviest volume):

```sql
SELECT c.strike, c.type, b.close as opt_price, b.volume
FROM bars b JOIN contracts c ON b.symbol=c.symbol
WHERE b.symbol LIKE 'SPXW260319%' AND b.timeframe='1m'
  AND b.ts = 1773927300
  AND c.strike BETWEEN 6555 AND 6580
ORDER BY c.type, c.strike;
```

| Contract | Price | Volume | Read |
|----------|-------|--------|------|
| P6570 | $8.00 | **282** | Heaviest volume — institutional hedging |
| P6560 | $4.60 | 226 | |
| C6580 | $7.60 | 213 | Most call volume |
| C6575 | $9.80 | 111 | |

**Key observation**: P6570 had the most volume of any contract. Institutions were buying downside protection into a rally. The system has no volume analysis to detect this.

**System verdict**: Completely blind. No RSI, no signal. HMA5 turn at 09:38 was a valid bullish signal the system doesn't use.

---

## Chapter 2: Signal #1 — Overbought Trap (09:44–10:12)

**SPX**: 6580 → 6595 → 6602 | **RSI**: 76→86→varies | **System**: FIRST TRADE

```sql
-- Chapter 2: SPX and all indicators
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi,
  json_extract(indicators, '$.hma5') as hma5,
  json_extract(indicators, '$.ema9') as ema9,
  json_extract(indicators, '$.ema21') as ema21
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773928080 AND ts <= 1773929520
ORDER BY ts;

-- P6570 (the trade) and C6600/C6615 (the missed trades)
SELECT datetime(b.ts, 'unixepoch', '-4 hours') as et, b.symbol, b.close
FROM bars b
WHERE b.symbol IN ('SPXW260319P06570000','SPXW260319C06600000','SPXW260319C06615000')
  AND b.timeframe='1m'
  AND b.ts >= 1773928200 AND b.ts <= 1773929700
ORDER BY b.ts, b.symbol;
```

**Signal #1 fires at 09:50 — RSI=85.7 EMERGENCY OVERBOUGHT**

| Indicator | Value | Read |
|-----------|-------|------|
| SPX | 6590.43 | +32 from open |
| EMA9 | 6580.9 | Price 10pts ABOVE — extended |
| EMA21 | 6574.7 | Price 16pts above — very extended |
| HMA5 | 6590.7 | At price — no divergence |

**Both judges**: BUY puts. Haiku picked P6570 @ $5.60, Opus picked P6555.

**The trade unfolds:**

| Time | SPX | P6570 | C6600 | C6615 |
|------|-----|-------|-------|-------|
| 09:50 | 6590 | **$5.60 ENTRY** | $2.00 | $0.67 |
| 09:52 | 6589 | $3.90 | $4.12 | $1.45 |
| 10:01 | 6598 | $5.10 | $1.77 | $0.62 |
| 10:03 | 6598 | $6.60 | $1.35 | $0.52 |
| **10:12** | **6602** | **$2.50 STOP** | $4.40 | $1.52 |
| 10:13 | 6593 | $2.10 | **$6.90** | **$2.90** |

**Result**: P6570 stopped out at -55% ($-310).

**What was missed**: C6600 $2.00 → $6.90 (+245%) at 10:13. C6615 $0.67 → $2.90 (+333%).

**Post-mortem**: Morning overbought in a strong trend = trap. EMA9 was accelerating away from EMA21 (diverging upward, not converging). In a real reversal, EMA9 flattens. No trend filter existed.

---

## Chapter 3: The Morning Crater (10:12–10:33)

**SPX**: 6602 → 6571 → 6585 | **RSI**: OFFLINE (indicator resets) | **System**: BLIND

```sql
-- Chapter 3: Note the indicator resets
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi,
  json_extract(indicators, '$.ema9') as ema9,
  CASE WHEN abs(close - json_extract(indicators, '$.ema9')) < 0.01
       THEN 'RESET' ELSE 'ok' END as status
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773929400 AND ts <= 1773930900
ORDER BY ts;
```

**Five indicator pipeline resets during the day**:

| Reset Time | EMA9 Snaps To Close | Duration of Blindness |
|------------|--------------------|-----------------------|
| 09:30 | 6558.31 | Normal — session start |
| **10:08** | 6591.65 | RSI → null for ~10min |
| **10:18** | 6582.56 | Another reset |
| **10:20** | 6587.96 | Third reset in 12 min |
| **10:34** | 6588.11 | RSI dark until 10:48 |

SPX dropped 31 points (6602→6571) during this 40-minute blind spot. P6570 (if not stopped out) would have gone from $2.50 to $6.60 (+164%).

**Root cause**: The indicator computation pipeline restarted multiple times (likely PM2 restarts or websocket reconnections). All bar data exists — only the computed indicators (RSI, EMA, HMA) reset to null.

---

## Chapter 4: The Midday Rally (10:33–11:07)

**SPX**: 6585 → 6603 | **RSI**: 39→70 | **System**: WATCHING

```sql
-- Chapter 4: The rally and C6600's 53x spike
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773930780 AND ts <= 1773933700
ORDER BY ts;

-- C6600's 53x move in this window
SELECT datetime(b.ts, 'unixepoch', '-4 hours') as et, b.close
FROM bars b WHERE b.symbol='SPXW260319C06600000' AND b.timeframe='1m'
  AND b.ts >= 1773930600 AND b.ts <= 1773933700
ORDER BY b.ts;
```

C6600 went from $0.70 (10:50) to $37.30 (11:06) — a **53x move** — while RSI sat at 62 (neutral). SPX only moved from 6587 to 6601 (14 points). This was a **gamma squeeze** — dealers short gamma at the 6600 strike forced to delta-hedge, creating a feedback loop. The system has zero awareness of gamma positioning.

| Time | SPX | RSI | C6600 | Event |
|------|-----|-----|-------|-------|
| 10:50 | 6587 | 39.2 | $0.70 | C6600 at day low |
| 10:56 | 6584 | 41.7 | $1.50 | Stirring |
| 10:58 | 6589 | 56.7 | $6.03 | Sudden spike |
| 11:00 | 6587 | 62.6 | $7.90 | 11x from low |
| 11:01 | 6588 | 62.1 | $15.70 | 22x — gamma cascade |
| 11:06 | 6601 | 67.4 | **$37.30** | **53x. Peak.** |
| 11:07 | 6603 | **70.1** | $26.52 | RSI=70, below 80 threshold |

**MISSED**: RSI=70.1 at the day high. Below 80 threshold. System silent while C6600 peaked at $37.30.

---

## Chapter 5: The Midday Top and Crash (11:07–11:42)

**SPX**: 6603 → 6572 (-31pts) | **RSI**: 70→19 | **System**: SIGNAL #2 FIRES

```sql
-- Chapter 5: The selloff
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773933700 AND ts <= 1773934800
ORDER BY ts;
```

| Time | SPX | RSI | Event |
|------|-----|-----|-------|
| 11:07 | 6603 | 70.1 | Day high — not triggered (needs 80) |
| 11:16 | 6602 | 74.9 | Retest — still below 80 |
| 11:19 | 6594 | 43.5 | RSI drops 27pts in 2 bars! |
| 11:21 | 6587 | 26.4 | Oversold zone |
| 11:27 | 6581 | 22.0 | Approaching 20 threshold |
| **11:30** | **6585** | **19.3** | **TRIGGER — Signal #2** |
| 11:31 | 6580 | 17.0 | Still dropping |
| **11:37** | **6572** | **25.6** | **TRUE BOTTOM** |
| 11:40 | 6578 | 38.3 | Bounce begins |

**Signal #2: RSI=19.3 at 11:30**

Both judges say BUY calls, target C6600. **BUG**: `C6600` parsed as PUT (code checks for `C0` not `C6`). Stopped out in 1 minute at -20%.

**Even with correct entry**: C6600 was $14.50 at 11:30. SPX kept dropping to 6572. C6600 would have hit ~$6.90 before bouncing. Stop-loss at 30% (~$10.15) would have triggered. **The signal was too early** — RSI crossed 20 before the actual bottom (11:37 at 6572, RSI=25.6).

---

## Chapter 6: Dead Money — The Midday Grind (11:42–12:50)

**SPX**: 6576 → 6594 → 6584 | **RSI**: 29→75→50 | **System**: WATCHING

```sql
-- Chapter 6: The grind and missed signals
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773934800 AND ts <= 1773937800
ORDER BY ts;

-- C6600 theta decay during the grind
SELECT datetime(b.ts, 'unixepoch', '-4 hours') as et, b.close
FROM bars b WHERE b.symbol='SPXW260319C06600000' AND b.timeframe='1m'
  AND b.ts >= 1773934800 AND b.ts <= 1773937800
ORDER BY b.ts;
```

Quietest 70 minutes. System correctly inactive. Two missed mild signals:

| Missed Signal | Time | RSI | Why Missed | What Would've Worked |
|--------------|------|-----|-----------|---------------------|
| 12:08 | 12:08 | 75.2 | Below 80 threshold | Put at local top (~$8→$12) |
| 12:17 | 12:17 | 24.9 | Above 20 threshold | C6600 $7.30→$9.40 (+29%) |

C6600 decayed from $14.50 (11:30) to $5.60 (12:50). Losing $0.13/minute to theta.

---

## Chapter 7: The Afternoon Selloff (12:50–13:14)

**SPX**: 6584 → 6566 (-18pts) | **RSI**: 52→17→19 | **System**: SIGNALS #3 AND #4 FIRE

```sql
-- Chapter 7: The selloff and signals 3+4
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi,
  json_extract(indicators, '$.hma5') as hma5
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773937800 AND ts <= 1773940500
ORDER BY ts;
```

**Signal #3 at 12:56 — RSI=17.0**: Entered P6595 (bug) @ $22.90. TP bug fired at -10%.

**Signal #4 at 13:14 — RSI=19.4**: Entered P6575 (bug) @ $17.30. TP bug fired at -12%.

**Signal #4 was THE TRADE THE BUG DESTROYED:**

| Time | SPX | C6575 (correct trade) |
|------|-----|----------------------|
| 13:14 | 6566 | ~$5.30 **ENTRY** |
| 13:18 | 6572 | ~$7.50 (+42%) |
| 13:23 | 6578 | ~$13.00 (+145%) |
| 13:27 | 6581 | ~$15.50 (**+192%**) |

### 4-Moment Replay: What Each Judge Said at 13:14

```
Data source: /home/ubuntu/SPXer/logs/replay-report.json
```

| Judge | Decision | Conf | Strike | Result |
|-------|----------|------|--------|--------|
| **Haiku** | BUY | 70% | C6575 | Entry couldn't be determined |
| **Sonnet** | WAIT | 38% | — | **MISSED THE MOVE** — "sellers still in control, wait for confirmed green close" |
| **Opus** | BUY | 62% | C6575 | **+54%** — Entry $8.70, Exit $13.40 |
| **Kimi** | BUY | 68% | C6575 | **+54%** — Same strike, same result |
| **GLM** | BUY | 74% | C6570 | **+48%** — More aggressive ATM strike |
| **MiniMax** | TIMEOUT | — | — | Never responded |

**Key insight**: Sonnet's "wait for confirmation" instinct missed the move. On 0DTE, by the time you have confirmation, the trade is half over.

---

## Chapter 8: The Overbought Whipsaw (13:23–13:55)

**SPX**: 6578 → 6582 → 6574 | **RSI**: 78→92→35 | **System**: SIGNAL #5 FIRES

```sql
-- Chapter 8: The whipsaw
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773941000 AND ts <= 1773942300
ORDER BY ts;
```

**Signal #5 at 13:27 — RSI=89.5**: RSI spiked from 19 to 92 in 14 bars. This is a "whipsaw RSI" — the math amplifies rebounds from extremes. The tell: EMA9 was BELOW price but EMA21 was below EMA9 — early bullish crossover, not a topping pattern.

Entered P6570 @ $6.00. Stopped out at 13:53 @ $3.90 = **-35%**.

---

## Chapter 9: The Quiet Before the Storm (13:35–14:29)

**SPX**: 6577 → 6593 → 6583 | **RSI**: oscillating 23–79 | **System**: COOLDOWN / MISSED SIGNALS

```sql
-- Chapter 9: The frustrating hour with near-misses
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773941700 AND ts <= 1773945000
ORDER BY ts;
```

| Missed Signal | Time | RSI | Why Missed | Impact |
|--------------|------|-----|-----------|--------|
| 14:07 | 14:07 | 23.3 | Cooldown from 13:27 | C6600 $1.65→$5.10 (+209%) |
| **14:15** | **14:15** | **79.0** | **1 POINT below 80 threshold** | Put before 20pt drop |

The 14:15 miss is the most painful: RSI=79.03, threshold=80.00. This was the local top. SPX dropped 20 points from here.

---

## Chapter 10: The Emergency — RSI 8.4 (14:29–14:46)

**SPX**: 6583 → 6573 | **RSI**: 25→8.4 | **System**: SIGNAL #6 — THE BIG ONE ★

```sql
-- Chapter 10: The emergency and the option chain
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773945000 AND ts <= 1773946000
ORDER BY ts;

-- The option chain at 14:34 (ts=1773945269)
SELECT c.type, c.strike, b.close as opt_price
FROM bars b JOIN contracts c ON b.symbol=c.symbol
WHERE b.symbol LIKE 'SPXW260319C%' AND b.timeframe='1m'
  AND b.ts = (SELECT MAX(b2.ts) FROM bars b2
              WHERE b2.symbol=b.symbol AND b2.timeframe='1m' AND b2.ts<=1773945269)
  AND c.type='call' AND c.strike BETWEEN 6570 AND 6620
ORDER BY c.strike;
```

**Signal #6 at 14:34 — RSI=8.4 EMERGENCY OVERSOLD**

**The option chain at this exact moment:**

| Contract | Price | If SPX +30pts | If SPX +55pts |
|----------|-------|--------------|--------------|
| C6585 | $5.40 | ~$24 (+344%) | ~$49 (+807%) |
| C6595 | $2.49 | ~$14 (+462%) | ~$40 (+1,506%) |
| **C6600** | **$1.62** | ~$10 (+517%) | **~$34 (+1,986%)** |
| C6615 | $0.55 | ~$2 (+264%) | ~$23 (+4,082%) |

### 4-Moment Replay: What Each Judge Said at 14:34

| Judge | Decision | Conf | Strike | Result |
|-------|----------|------|--------|--------|
| **Haiku** | BUY | 78% | **C6600** | **+2,718%** — Picked the home run! |
| **Sonnet** | BUY | 62% | C6590 | Entry couldn't be determined — explicitly REJECTED C6600 as "lottery ticket" |
| **Opus** | BUY | 62% | C6595 | **+2,122%** — Conservative but still massive |
| **Kimi** | BUY | 68% | C6590 | **+1,374%** — Solid |
| **GLM** | BUY | 72% | **C6600** | Entry couldn't be determined — but picked the right strike |
| **MiniMax** | TIMEOUT | — | — | Never responded |

**BUG**: C6585 parsed as PUT in the full-day replay. Accidental P6585 entry profited from the continued dip (+22%, the only winner).

**What actually happened**: C6600 $1.62 → $33.82 in 33 minutes (+1,986%). C6615 $0.55 → $23.20 (+4,118%).

---

## Chapter 11: The Explosion (14:46–15:12)

**SPX**: 6573 → 6634 (+61pts in 26min) | **RSI**: 27→94 | **System**: WRONG-WAY SIGNAL #7

```sql
-- Chapter 11: The monster rally
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773946000 AND ts <= 1773947700
ORDER BY ts;

-- C6600's journey during the explosion
SELECT datetime(b.ts, 'unixepoch', '-4 hours') as et, b.close, b.high
FROM bars b WHERE b.symbol='SPXW260319C06600000' AND b.timeframe='1m'
  AND b.ts >= 1773946000 AND b.ts <= 1773947700
ORDER BY b.ts;
```

**Signal #7 at 14:57 — RSI=82.2**: System entered P6570 @ $2.40. SPX then ripped to 6634.

| Time | SPX | RSI | C6600 | P6570 (the trade) |
|------|-----|-----|-------|-------------------|
| 14:57 | 6584 | 82.2 | $1.72 | **$2.40 ENTRY** |
| 14:59 | 6594 | 88.7 | $5.50 | $1.20 |
| 15:01 | 6603 | 91.0 | $10.12 | $0.55 |
| 15:02 | 6613 | 94.2 | $18.88 | $0.30 |
| 15:05 | 6618 | 92.8 | $22.30 | $0.20 |
| **15:07** | **6634** | **94.2** | **$33.82** | $0.10 |

**Result**: P6570 stopped out at 15:21 @ $0.35 = **-85%** ($-205).

C6600 went from $1.72 to $33.82 (+1,867%) in the 10 minutes AFTER the system entered a put.

### 4-Moment Replay: What Each Judge Said at 15:07 (Puts After the Rally)

| Judge | Decision | Conf | Strike | Result |
|-------|----------|------|--------|--------|
| **Haiku** | BUY puts | 82% | P6620 | Entry couldn't be determined |
| **Sonnet** | BUY puts | 70% | P6620 | **+62%** |
| **Opus** | BUY puts | 68% | P6620 | **+69%** |
| **Kimi** | BUY puts | 62% | P6615 | Entry couldn't be determined |
| **GLM** | BUY puts | 72% | P6620 | **+62%** |
| **MiniMax** | TIMEOUT | — | — | Never responded |

This was the ONE moment all judges agreed — unanimous BUY puts after the exhaustion.

---

## Chapter 12: The Denouement (15:12–16:00)

**SPX**: 6634 → 6607 | **RSI**: 94→34→50 | **System**: STOPPED OUT

```sql
-- Chapter 12: The pullback and close
SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,
  json_extract(indicators, '$.rsi14') as rsi
FROM bars WHERE symbol='SPX' AND timeframe='1m'
  AND ts >= 1773947700 AND ts <= 1773950400
ORDER BY ts;

-- C6600 final decay
SELECT datetime(b.ts, 'unixepoch', '-4 hours') as et, b.close
FROM bars b WHERE b.symbol='SPXW260319C06600000' AND b.timeframe='1m'
  AND b.ts >= 1773947700 AND b.ts <= 1773950400
ORDER BY b.ts;
```

SPX gave back 27 of its 61 points. C6600 faded from $33.82 to $6.61. Closed at $6.61 — still +94% from its $3.40 open.

---

## Final Scorecard

### Signals That Fired (7 total)

| # | Time | RSI | Direction | Entry | Exit | P&L | Bug? |
|---|------|-----|-----------|-------|------|-----|------|
| 1 | 09:50 | 85.7 | Put | P6570@$5.60 | $2.50 stop | **-55%** | No bug, bad signal |
| 2 | 11:30 | 19.3 | Put (WRONG) | P6600@$3.20 | $2.55 stop | **-20%** | Call→Put parsing bug |
| 3 | 12:56 | 17.0 | Put (WRONG) | P6595@$22.90 | $20.59 TP | **-10%** | Call→Put + TP bug |
| 4 | 13:14 | 19.4 | Put (WRONG) | P6575@$17.30 | $15.20 TP | **-12%** | Call→Put + TP bug |
| 5 | 13:27 | 89.5 | Put | P6570@$6.00 | $3.90 stop | **-35%** | No bug, whipsaw signal |
| 6 | 14:34 | 8.4 | Put (WRONG) | P6585@$10.90 | $13.30 TP | **+22%** | Call→Put (accidentally won) |
| 7 | 14:57 | 82.2 | Put | P6570@$2.40 | $0.35 stop | **-85%** | No bug, wrong regime |

**Total: 1 winner, 6 losers. Net P&L: -$991**

### Signals That Were Missed (9 total)

| # | Time | RSI | Why Missed | Potential Trade |
|---|------|-----|-----------|----------------|
| A | 09:35 | — | No RSI yet | HMA5 turn → long |
| B | 10:30 | — | RSI offline (pipeline reset) | SPX bottom 6571 |
| C | 11:07 | 70.1 | Below 80 threshold | Put at day high |
| D | 11:37 | 25.6 | Cooldown from 11:30 | C6600 at $6.90 |
| E | 12:08 | 75.2 | Below 80 threshold | Put at local top |
| F | 12:17 | 24.9 | Above 20 threshold | C6600 $7.30→$9.40 (+29%) |
| G | 14:07 | 23.3 | Cooldown from 13:27 | C6600 $1.65→$5.10 (+209%) |
| H | 14:15 | 79.0 | 1 point below 80 | Put before 20pt drop |
| I | 15:30 | 20.6 | Cooldown from 14:57 | C6600 $12→$15 (+27%) |

### Judge Scorecard (4-Moment Replay)

| Judge | 11:30 | 13:14 | 14:34 | 15:07 | Record | Best Trade |
|-------|-------|-------|-------|-------|--------|-----------|
| **Haiku** | ✅ Wait | ❌ No entry | ✅ **+2,718%** | ❌ No entry | 2/4 | C6600 home run |
| **Sonnet** | ✅ Wait | ❌ Waited | ❌ No entry | ✅ +62% | 2/4 | Cautious, missed big one |
| **Opus** | ✅ Wait | ✅ +54% | ✅ +2,122% | ✅ +69% | **4/4** | Most consistent |
| **Kimi** | ❌ -0% | ✅ +54% | ✅ +1,374% | ❌ No entry | 2/4 | Good at oversold |
| **GLM** | ✅ Wait | ✅ +48% | ❌ No entry | ✅ +62% | 3/4 | Picked C6600 but no entry |
| **MiniMax** | ❌ Timeout | ❌ Timeout | ❌ Timeout | ❌ Timeout | **0/4** | Never responded |

---

## Critical Bugs Found

### Bug #1 — CRITICAL: All Calls Entered as Puts
```typescript
isCall = sym.includes('C0') || sym.toLowerCase().includes('call')
```
Judge returns `SPXW260319C6585`. Contains `C6`, not `C0`. **isCall = false for every trade.** Every oversold signal entered puts instead of calls.

### Bug #2 — TP Below Entry
Judge sometimes returns SPX underlying price as stop/TP instead of option price. No sanity check existed.

### Bug #3 — Indicator Pipeline Resets
5 resets during the day create 40+ minutes of RSI blindness. Raw bar data exists but computed indicators reset to null.

### Bug #4 — 6 Parallel Judge Calls Serialize
`Promise.allSettled` with 6 `query()` calls through Claude Agent SDK serialize internally. Last call waits for 5 others → timeout cascade.

---

## Hypothesis Review: Price-Action-First Redesign

All 6 judges reviewed the proposal to replace RSI with price-action triggers.

### Consensus Rating: 6.3/10

| Judge | Rating | Verdict |
|-------|--------|---------|
| Haiku | 5/10 | "Right problem, wrong solution — use price action to QUALIFY RSI, not replace it" |
| Sonnet | 7/10 | "Correct direction, add VIX regime classifier as mandatory gate" |
| Opus | 7/10 | "Signal confluence (2-of-5) + time-of-day regime filter required" |
| Kimi | 7/10 | "Build 2-state regime classifier BEFORE any signal evaluation" |
| GLM | 7/10 | "No regime detection is the biggest gap" |
| MiniMax | 5/10 | "Replaces slow noise with fast noise — need regime classifier" |

### Universal Agreement (6/6 judges)
Every model agreed: **Add a REGIME CLASSIFIER as the first gate before any signal fires.**

### Proposed Regime Framework (consensus)

```
MORNING MOMENTUM (09:30-10:00):
  → Suppress ALL counter-trend signals
  → RSI overbought = continuation, NOT reversal
  → Would have blocked: Signal #1 (09:50 PUT into rally)

MEAN REVERSION (10:00-14:00):
  → RSI extremes + support/resistance valid
  → Require 2+ signal confluence
  → Best window for fade setups

EXPIRATION/GAMMA (14:00-15:30):
  → Follow breakouts, don't fade them
  → Would have blocked: Signal #7 (14:57 PUT into gamma squeeze)

CLOSE (15:30-16:00):
  → No new entries
```

### Full Judge Responses
See: `/home/ubuntu/SPXer/logs/hypothesis-review.log`

### Key Unique Insights

**Haiku**: "RSI=82 + price breaking above resistance + volume spike = ACCEPT BUY. RSI=82 + price at support + downtrend intact = REJECT." Alignment between price structure and RSI.

**Sonnet**: VIX gate — `VIX<15: suppress breakouts` / `VIX 15-25: all active` / `VIX>25: suppress V-reversals`.

**Opus**: RSI as VETO not trigger — if RSI>80 AND price-action says breakout continuation, flag as HIGH-CONVICTION MOMENTUM instead of fading.

**Kimi**: Key level map at open (prior day close/high/low, round numbers, overnight range). Signals AT levels get 2x weight.

**GLM**: Simplest regime filter — `price > SMA-20 AND RSI>70 = continuation` / `price < SMA-20 AND RSI>70 = reversal`.

**MiniMax**: Dealer gamma awareness — C6600 at 14:57 was a gamma wall. System entered puts against it. Add volatility-surface inputs (VIX term structure, dealer gamma strikes).

---

## Best Possible Day (Perfect Hindsight)

| Trade | Entry | Exit | Return | Notional |
|-------|-------|------|--------|----------|
| 13:14 C6575 | $5.30 | $15.50 (13:28) | +192% | +$2,040 |
| 14:34 C6600 | $1.62 | $33.82 (15:07) | +1,986% | +$6,440 |
| 15:07 P6620 | $8.80 | $18.00 (15:30) | +105% | +$920 |

**Best-case P&L: +$9,400** vs actual **-$991**
