#!/usr/bin/env python3
"""
10:30 ET Opening-Range Rejection backtest with REAL 1-min option P&L.

Signal:  At 10:30 ET compute the 1-hr OR (9:30-10:30).
         If 10:30 spot < OR midpoint  -> HIGH was rejected -> BEARISH (buy puts)
         If 10:30 spot >= OR midpoint -> LOW  was rejected -> BULLISH (buy calls)

Structures (entered at 10:30, 0DTE, SPX index options x100):
  A) SINGLE LONG ATM   : bearish=ATM put, bullish=ATM call.
                         TP = +50% of premium ; SL = SPX hits opposite OR boundary ; else EOD.
  B) CREDIT SPREAD $10  : bearish=bear-call (short ATM-10 call / long ATM call)
                         bullish=bull-put  (short ATM+10 put  / long ATM put)
                         credit = short-long at entry ; V(t)=short-long.
                         TP = capture 50% of credit (V <= 0.5*credit)
                         SL = SPX hits opposite OR boundary ; else EOD (V=intrinsic).
"""
import duckdb, glob, os, math
from collections import defaultdict

DATA = "/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con = duckdb.connect()

def et(expr):  # helper: ET HH:MM string
    return f"strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')"

def opt_symbol(date_yymmdd, cp, strike):
    return f"SPXW{date_yymmdd}{cp}{int(round(strike*1000)):08d}"

def load_spx(path):
    rows = con.execute(f"""
        SELECT {et('')} et, ts, high, low, close
        FROM read_parquet('{path}')
        WHERE symbol='SPX' AND timeframe='1m'
          AND {et('')}::TIME BETWEEN '09:30'::TIME AND '16:00'::TIME
        ORDER BY ts
    """).fetchall()
    return rows

def load_opt(path, sym):
    rows = con.execute(f"""
        SELECT {et('')} et, high, low, close
        FROM read_parquet('{path}')
        WHERE symbol='{sym}' AND timeframe='1m'
          AND {et('')}::TIME BETWEEN '10:30'::TIME AND '16:00'::TIME
        ORDER BY ts
    """).fetchall()
    return {r[0]: (r[1], r[2], r[3]) for r in rows}  # et -> (h,l,c)

def to_min(hhmm):
    h, m = hhmm.split(':'); return int(h)*60+int(m)

results_single = []
results_spread = []

paths = sorted(glob.glob(f"{DATA}/*.parquet"))
for path in paths:
    date = os.path.basename(path).replace('.parquet','')          # 2026-06-08
    yymmdd = date[2:4]+date[5:7]+date[8:10]                        # 260608
    spx = load_spx(path)
    if len(spx) < 60:   # need a full morning
        continue
    bym = {r[0]: (r[2], r[3], r[4]) for r in spx}                  # et -> (h,l,c)

    # 1-hr OR 9:30-10:30 (inclusive of bars with ET < 10:30 ; OR closes AT 10:30)
    or_bars = [bym[t] for t in bym if to_min(t) >= to_min('09:30') and to_min(t) < to_min('10:30')]
    if len(or_bars) < 45:
        continue
    or_high = max(b[0] for b in or_bars)
    or_low  = min(b[1] for b in or_bars)
    or_mid  = (or_high + or_low)/2
    width   = or_high - or_low
    if '10:30' not in bym:
        continue
    spot = bym['10:30'][2]

    bearish = spot < or_mid
    atm = round(spot/5)*5

    # ---- timeline of SPX after entry, for SL boundary checks ----
    post = [(t, bym[t]) for t in bym if to_min(t) >= to_min('10:30')]
    post.sort(key=lambda x: to_min(x[0]))

    # ================= A) SINGLE LONG ATM =================
    cp = 'P' if bearish else 'C'
    sym = opt_symbol(yymmdd, cp, atm)
    od = load_opt(path, sym)
    if '10:30' in od and od['10:30'][2] and od['10:30'][2] > 0.05:
        entry = od['10:30'][2]
        tp_px = entry * 1.5
        sl_boundary = or_high if bearish else or_low   # opposite side of the rejected move
        outcome, exit_px, exit_t = None, None, None
        for t, (h, l, c) in post:
            if t == '10:30':
                continue
            # TP: option trades up to +50%
            if t in od and od[t][0] and od[t][0] >= tp_px:
                outcome, exit_px, exit_t = 'WIN', tp_px, t; break
            # SL: SPX breaks back through opposite OR boundary
            sl_hit = (h >= sl_boundary) if bearish else (l <= sl_boundary)
            if sl_hit:
                px = od[t][2] if t in od and od[t][2] else (od.get(t,(None,None,entry))[2] or 0.0)
                outcome, exit_px, exit_t = 'LOSS', px, t; break
        if outcome is None:  # EOD
            last_t = post[-1][0]
            exit_px = od[last_t][2] if last_t in od and od[last_t][2] is not None else 0.0
            outcome = 'WIN' if exit_px > entry else 'LOSS'
            exit_t = last_t
        pnl = (exit_px - entry) * 100
        results_single.append(dict(date=date, dir='BEAR' if bearish else 'BULL',
            atm=atm, entry=entry, exit=exit_px, exit_t=exit_t, outcome=outcome, pnl=pnl))

    # ================= B) CREDIT SPREAD $10 =================
    if bearish:
        short_sym = opt_symbol(yymmdd, 'C', atm-10); long_sym = opt_symbol(yymmdd, 'C', atm)
    else:
        short_sym = opt_symbol(yymmdd, 'P', atm+10); long_sym = opt_symbol(yymmdd, 'P', atm)
    sod = load_opt(path, short_sym); lod = load_opt(path, long_sym)
    if '10:30' in sod and '10:30' in lod and sod['10:30'][2] and lod['10:30'][2]:
        credit = sod['10:30'][2] - lod['10:30'][2]
        if credit > 0.10:
            tp_V = 0.5 * credit
            sl_boundary = or_high if bearish else or_low
            outcome, vexit, exit_t = None, None, None
            for t, (h, l, c) in post:
                if t == '10:30':
                    continue
                if t in sod and t in lod and sod[t][2] is not None and lod[t][2] is not None:
                    V = sod[t][2] - lod[t][2]
                else:
                    V = None
                if V is not None and V <= tp_V:
                    outcome, vexit, exit_t = 'WIN', tp_V, t; break
                sl_hit = (h >= sl_boundary) if bearish else (l <= sl_boundary)
                if sl_hit:
                    outcome, vexit, exit_t = 'LOSS', (V if V is not None else credit), t; break
            if outcome is None:
                last_t = post[-1][0]
                if last_t in sod and last_t in lod and sod[last_t][2] is not None and lod[last_t][2] is not None:
                    vexit = sod[last_t][2] - lod[last_t][2]
                else:
                    vexit = credit
                outcome = 'WIN' if vexit < credit else 'LOSS'
                exit_t = last_t
            pnl = (credit - vexit) * 100
            results_spread.append(dict(date=date, dir='BEAR' if bearish else 'BULL',
                atm=atm, credit=credit, vexit=vexit, exit_t=exit_t, outcome=outcome, pnl=pnl))

def summarize(name, res):
    print("\n" + "="*78)
    print(f"  {name}   (n={len(res)} trading days)")
    print("="*78)
    bym = defaultdict(list)
    for r in res:
        bym[r['date'][:7]].append(r)
    print(f"{'Month':9} {'N':>3} {'Win':>4} {'WR%':>6} {'TotPnL':>9} {'Avg':>7} {'AvgWin':>8} {'AvgLoss':>8}")
    print("-"*78)
    tot_n=tot_w=0; tot_pnl=0.0
    for m in sorted(bym):
        rs = bym[m]; n=len(rs); w=sum(1 for x in rs if x['outcome']=='WIN')
        pnl=sum(x['pnl'] for x in rs)
        wins=[x['pnl'] for x in rs if x['outcome']=='WIN']; losses=[x['pnl'] for x in rs if x['outcome']=='LOSS']
        aw=sum(wins)/len(wins) if wins else 0; al=sum(losses)/len(losses) if losses else 0
        print(f"{m:9} {n:>3} {w:>4} {100*w/n:>6.1f} {pnl:>9.0f} {pnl/n:>7.0f} {aw:>8.0f} {al:>8.0f}")
        tot_n+=n; tot_w+=w; tot_pnl+=pnl
    allwins=[x['pnl'] for x in res if x['outcome']=='WIN']; alllosses=[x['pnl'] for x in res if x['outcome']=='LOSS']
    aw=sum(allwins)/len(allwins) if allwins else 0; al=sum(alllosses)/len(alllosses) if alllosses else 0
    print("-"*78)
    print(f"{'TOTAL':9} {tot_n:>3} {tot_w:>4} {100*tot_w/tot_n:>6.1f} {tot_pnl:>9.0f} {tot_pnl/tot_n:>7.0f} {aw:>8.0f} {al:>8.0f}")
    rr = abs(aw/al) if al else float('inf')
    print(f"\n  Win rate: {100*tot_w/tot_n:.1f}%   Expectancy/trade: ${tot_pnl/tot_n:.0f} (1 contract)   R:R = {rr:.2f}")
    print(f"  Total P&L (1 contract/day): ${tot_pnl:,.0f} over {tot_n} days")

summarize("A) SINGLE LONG ATM  (TP +50% premium, SL=opposite OR boundary)", results_single)
summarize("B) CREDIT SPREAD $10 (short ITM/long ATM, TP 50% credit, SL=opposite OR)", results_spread)
