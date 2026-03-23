# Autoresearch Sessions

Each session tests ONE dimension while holding all others constant.
Run each in its own tmux pane via the autoresearch skill.

## Sessions

| # | Dimension | File |
|---|-----------|------|
| 1 | Time × OTM contract cost | session-01-time-otm.md |
| 2 | RSI thresholds | session-02-rsi.md |
| 3 | Stop loss | session-03-stoploss.md |
| 4 | TP / exit strategy | session-04-tp-exit.md |
| 5 | Option RSI | session-05-option-rsi.md |
| 6 | Cooldown | session-06-cooldown.md |
| 7 | HMA signals | session-07-hma.md |
| 8 | EMA signals | session-08-ema.md |
| 9 | Prompt framing | session-09-prompts.md |
| 10 | Calendar/macro context | session-10-calendar.md |

## Run Order
Sessions 1-8 are deterministic (no AI calls, fast).
Sessions 9-10 require scanner/judge API calls (slower, costs money).

Run 1-8 first, combine winners, then run 9-10 on top.
