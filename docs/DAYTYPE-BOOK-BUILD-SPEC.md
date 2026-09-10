# Day-Type Book — Build-Out Spec

**Status**: Layer 1 (engine) COMPLETE and verified. Layers 2–4 specified below.
**Branch**: `daytype-book` (worktree `/home/ubuntu/worktrees/SPXer/daytype-book`)
**Origin**: Research session 2026-08-19/20 (all numbers below are from verified
runs pasted in that session; independent python pipeline + this engine agree).

---

## 0. Background (what this is)

A four-strategy SPX 0DTE credit-spread "book" that partitions trading days by
type (measured vs PRIOR CLOSE — deliberately matching Option Alpha filter
semantics so OA can be used for cross-validation). Each day at most one or two
strategies fire. All trades: hold to 16:00 ET settle, one entry, no TP/SL
(TP-based exits are banned in this repo's history — phantom-fill artifacts).

### The four strategies (THE spec — do not improvise)

| key | day type | side | entry | VIX | Change% (vs prev close) | Open Chg% (gap) |
|---|---|---|---|---|---|---|
| RED | red day | sell CALL 0.30Δ, $10-wide | 12:00pm | 16–22 | −0.75 .. −0.10 | (off) |
| FLAT | flat day | sell CALL 0.30Δ, $10-wide | 1:50pm | 14–25 | −0.50 .. +0.10 | −0.30 .. +0.30 |
| DRIFT | mildly green | sell PUT 0.30Δ, $10-wide | 1:30pm | (off) | +0.15 .. +0.50 | ≥ −0.30 (one-sided) |
| STRONG | strong green | sell CALL 0.30Δ, $10-wide | 3:20pm | 16–25 | +0.40 .. +0.80 | (off) |

Optional refinements (validated but OFF in the engine baseline):
- DRIFT + SMA(10) daily Above → 1-yr 97.6→100% WR, n 60→53.
- Gap tightening: RED −0.15..+0.50, FLAT −0.05..+0.25, STRONG −0.15..+0.55 →
  all ~100% 1-yr WR but n halves (overfit risk flagged in session memory).
- Bounce trigger (OptionX-only, 5th strategy): SMA25min×UP SMA75min cross AND
  price > daily SMA(10) → sell put, ~88.9% test WR. SMA only — EMA/DEMA tested
  and REJECTED (75%/flat; DEMA at any speed fails).
- Rollover trigger (OptionX-only): SMA25min cross-DOWN SMA75min, fresh cross,
  11:30–14:30 → sell call, 91.2% test WR, $122/trade, no filters needed.

### Verified performance (engine output, 343 days, +$20/contract extra friction)

- Book: 177 traded days (51.6%), 219 trades, day-WR 89.3%, $21,018 total,
  maxDD $1,409, worst day −$920. Test-half 95% WR. Last-1-yr 93% / $18,090.
- Per strategy 1-yr WR: RED 95.2%, FLAT 92.0%, DRIFT 97.5%, STRONG 92.9%.
- Losing months: 1 of 18 (2025-06).
- Compounding at 40%/trade is FICTION past ~$200k (fill ceiling ~50–100
  contracts on 0DTE $10-wides; 3-loss streak probability ~16%/214 trades →
  −75% at 40%). Sane sizing 10–15%.

---

## 1. Layer 1 — engine (DONE)

`scripts/diag/daytype-book.ts` in this branch. Self-contained:
- Features: gap (open vs prev close), move-vs-open at entry, Change% = derived
  (1+gap)(1+move)−1, VIX daily (cached `data/cache/vix-daily.csv`, fetched
  from Yahoo chart API when absent — free, no key).
- Pricing: identical path to `delta-condor-slot.ts` (loadDay 1m chain → optPx
  at entryTs−1 → IV-inverted BS delta targeting → nearest-strike wing →
  structure-scaled friction + `DTB_EXTRA_FRICTION`).
- Env knobs: `DTB_SHORT_DELTA` (0.30), `DTB_WING` (10), `DTB_EXTRA_FRICTION`
  (20), `DTB_VIX_CSV`.
- Output: `output/daytype-book.json` — schema:
  `{ config, strategies[{key,label,side,slot,vixLo,vixHi,chgLo,chgHi,gapLo,gapHi,stats,test,yr1}], trades[219 rows incl. strikes/credit/spot/settle/exit/pnl/vix/gap_pct/chg_pct], daily[{date,pnl,trades}], book{stats+test+yr1+tradedDays+totalDays+days2Fired} }`
- Run: `npx tsx scripts/diag/daytype-book.ts --symbol SPX` (worktree has
  node_modules + data symlinked to primary).
- Verified: `tsc --noEmit` CLEAN; output reconciles with independent python
  pipeline (177d/$21,018 vs 175d/$20,966 — one new day of data).

## 2. Layer 2 — backtest-server endpoint (:3700)

backtest-server = `scripts/autoresearch/backtest-server.ts` (single bundled
file, port 3700, pm2 name `backtest-studio`, currently STOPPED).

- `GET /api/daytype-book` → serve `output/daytype-book.json` (fs read; 404
  with hint if absent).
- `POST /api/daytype-book/run` → spawn child (SAME pattern as the existing
  `/api/long-sweep/run`: detached, own process group, stdout drained, wall-
  clock timeout — see FR-001 notes in CLAUDE.md; the sweep-process wrapper
  `scripts/diag/sweep-process.ts` already exists, REUSE it) with env passthrough
  `dtbShortDelta|dtbWing|dtbExtraFriction|symbol` (validate: numbers, clamp
  delta 0.05–0.90, wing 5–50, friction 0–200). Return `{ jobId }`; job status
  via existing pattern; on completion serve new JSON.
- Restart: `pm2 restart backtest-studio` (verify `pm2 list` shows online;
  3700 was answering 000 = stopped at spec time).

## 3. Layer 3 — spxer-studio page (:3800)

Repo `~/spxer-studio` (Next.js, online, `/spxer/studio/dashboard/spreads`
exists). Add `/spxer/studio/dashboard/daytype-book`:

- **MUST use shadcn/ui + Tailwind components only** (user's global rule — no
  custom .card/.btn CSS).
- Fetch `http://localhost:3700/api/daytype-book` (server-side, same data-flow
  as the spreads page: flat JSON from backtest-server).
- Sections:
  1. Stats tiles (Card): total P&L, day-WR, max DD, traded days / total,
     worst day, losing months count.
  2. Equity curve (cumulative daily pnl) — reuse whatever chart lib the
     spreads page uses; follow the repo dataviz conventions.
  3. Four strategy cards: spec line (slot/side/Δ/wing/filters) + n/WR/$ for
     full/test/1yr + a take-live button per strategy.
  4. Trade log table: date, strategy, side, strikes, credit, spot, settle,
     exit, P&L, vix, gap, chg — sortable, filterable by strategy.
  5. Parameter panel: Δ, wing, extra friction → POST /run → refresh (disable
     controls while running — user prefers disabled-over-race-guard).
  6. Monthly P&L bars.
- Do NOT purge/blank the page while a re-run is in flight (user rule: never
  blank live dashboard data mid-run; overwrite in place when JSON lands).
- (Later, optional) chat panel: model call with book JSON as context +
  tool-invocation of /run. Keys already in SPXer `.env`; agent plumbing in
  `src/agent/`. Out of scope for first cut.

## 4. Layer 4 — OptionX configs

`~/optionx/configs/` per existing convention (`spx-dtb-red-1200.json` etc.).
Each config: clock entry at the strategy slot, credit-spread 0.30Δ short /
$10-wide long, filters computable in OptionX session helpers (gap + change vs
prev close + VIX from feed), hold-to-settle (no TP/SL). take-live flow: studio
button → POST backtest-server `/api/take-live` variant that emits these
configs + returns PM2 command. NOTE: `take-live` currently emits
signal-config JSONs for HMA strategies — extend, don't replace.

## 5. Acceptance criteria

1. Engine: re-run reproduces book (177±2 days, $21,018±500, WR 89.3±1) —
   `tsc --noEmit` clean; `npm run build` + `npm run test` stay green in the
   worktree before merge (currently 684 passing).
2. Endpoint: GET returns JSON; POST re-run with dtbWing=25 completes and
   changes output (spot-check one number by hand against a direct tsx run
   with DTB_WING=25).
3. Studio: page renders tiles/curve/table from live :3700 data; param re-run
   round-trips; no blank-page during re-run; Playwright check like
   `scripts/diag/test-backtest-page.ts`.
4. OptionX: config validates, dry-run/paper entry fires at the right clock
   with filters (verify one day manually against OA's numbers for the same
   day).

## 6. Workflow gotchas (hard-won, this machine)

- SPXer primary checkout is hook-guarded (wtguard): ALL code work in the
  `daytype-book` worktree; symlink `node_modules` + `data`; land via the
  dirty-primary snapshot-commit+merge procedure (see project memory
  `project_spxer_dirty_primary_landing_workflow`).
- Evidence harness: read-before-write, verify-before-claim (paste outputs),
  never claim untested success.
- PM2: `backtest-studio` stopped; `spxer-studio` online. Never propagate PORT
  env when restarting spxer-studio (stale-env incident in memory).
- OA CHANGE%/Open Chg% are vs PREVIOUS CLOSE. Since-open variants exist and
  are stronger (94%) but OA cannot express them — keep OA-parity semantics in
  the engine defaults; since-open is an OptionX-only upgrade.
- Friction: engine adds +$20/contract round-turn by default on top of
  structure-scaled model. OA's $0.02 slippage will print better; expected.
- Memory file `project_scs_top3rd_1345_edge.md` holds the full research
  record incl. dead ends (EMA/DEMA triggers, trendline breaks, put side
  unconditioned, VIX-close-change look-ahead, TP exits).

## 7. Recommended build order

Layer 2 (endpoint + pm2 restart) → Layer 3 (studio page) → verify both →
Layer 4 (OptionX configs + take-live) → optional chat panel. Each layer
independently shippable; commit per layer on this branch.
