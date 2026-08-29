#!/usr/bin/env python3
"""
Parameter sweep for the 10:30 OR-rejection credit spread, real 1-min option P&L.

Grid:
  short_depth (pts ITM of short leg): -5(OTM), 0(ATM), 5, 10
  width       (wing width $):          5, 10, 15, 20
  tp          (fraction of credit captured): 0.40, 0.50, 0.60, 0.75
  sl          rule: 'or' (opposite OR boundary) | '1x' (lose 1x credit) |
                    '2x' (lose 2x credit) | 'none' (ride to EOD)

Bearish (HIGH rejected) -> bear call spread: short (ATM-short_depth) call, long (short+width) call
Bullish (LOW  rejected) -> bull put  spread: short (ATM+short_depth) put,  long (short-width) put
Entry 10:30 ET, 0DTE, SPX x100, 1 contract.
"""
import duckdb, glob, os
from collections import defaultdict

DATA = "/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con = duckdb.connect()

SHORT_DEPTHS = [-5, 0, 5, 10]
WIDTHS       = [5, 10, 15, 20]
TPS          = [0.40, 0.50, 0.60, 0.75]
SLS          = ['or', '1x', '2x', 'none']

def to_min(hhmm): h,m=hhmm.split(':'); return int(h)*60+int(m)

agg = defaultdict(lambda: dict(n=0, w=0, pnl=0.0, win_sum=0.0, loss_sum=0.0, nloss=0))
perday = defaultdict(list)   # combo -> [(date, or_width, outcome, pnl)]

for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date = os.path.basename(path).replace('.parquet','')
    yymmdd = date[2:4]+date[5:7]+date[8:10]

    spx = con.execute(f"""
        SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, high, low, close
        FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
          AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
              BETWEEN '09:30'::TIME AND '16:00'::TIME
        ORDER BY ts""").fetchall()
    bym = {r[0]:(r[1],r[2],r[3]) for r in spx}
    or_bars = [bym[t] for t in bym if to_min('09:30')<=to_min(t)<to_min('10:30')]
    if len(or_bars) < 45 or '10:30' not in bym:
        continue
    or_high=max(b[0] for b in or_bars); or_low=min(b[1] for b in or_bars)
    or_mid=(or_high+or_low)/2; or_width=or_high-or_low
    spot=bym['10:30'][2]; bearish = spot < or_mid; atm=round(spot/5)*5

    post=sorted([(t,bym[t]) for t in bym if to_min(t)>=to_min('10:30')], key=lambda x:to_min(x[0]))
    # first minute SPX breaks opposite OR boundary
    sl_or_t=None
    for t,(h,l,c) in post:
        if t=='10:30': continue
        if (bearish and h>=or_high) or ((not bearish) and l<=or_low):
            sl_or_t=t; break

    # load all option 1m bars in strike range for the day, one query
    lo,hi = atm-30, atm+30
    opts = con.execute(f"""
        SELECT symbol, strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}')
        WHERE timeframe='1m' AND symbol LIKE 'SPXW{yymmdd}%'
          AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
              BETWEEN '10:30'::TIME AND '16:00'::TIME
          AND CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 BETWEEN {lo} AND {hi}
        ORDER BY ts""").fetchall()
    chain=defaultdict(dict)   # (cp,strike) -> {et:close}
    for sym,t,c in opts:
        cp=sym[10]; strike=int(sym[11:19])/1000.0
        chain[(cp,strike)][t]=c

    cp = 'C' if bearish else 'P'
    for sd in SHORT_DEPTHS:
        short_strike = (atm - sd) if bearish else (atm + sd)
        for w in WIDTHS:
            long_strike = (short_strike + w) if bearish else (short_strike - w)
            sc = chain.get((cp, float(short_strike))); lc = chain.get((cp, float(long_strike)))
            if not sc or not lc or '10:30' not in sc or '10:30' not in lc: continue
            if sc['10:30'] is None or lc['10:30'] is None: continue
            credit = sc['10:30'] - lc['10:30']
            if credit <= 0.10: continue
            # V timeline (post-entry, both legs present)
            Vser=[]
            for t,_ in post:
                if t=='10:30': continue
                if t in sc and t in lc and sc[t] is not None and lc[t] is not None:
                    Vser.append((t, sc[t]-lc[t]))
            if not Vser: continue
            for tp in TPS:
                tp_V=(1-tp)*credit
                for sl in SLS:
                    outcome=None; vexit=None
                    sl1x=2*credit; sl2x=3*credit
                    for t,V in Vser:
                        if V<=tp_V: outcome,vexit='WIN',tp_V; break
                        if sl=='or' and sl_or_t is not None and to_min(t)>=to_min(sl_or_t):
                            outcome,vexit='LOSS',min(V,float(w)); break
                        if sl=='1x' and V>=sl1x: outcome,vexit='LOSS',min(V,float(w)); break
                        if sl=='2x' and V>=sl2x: outcome,vexit='LOSS',min(V,float(w)); break
                    if outcome is None:
                        vexit=min(Vser[-1][1], float(w)); outcome='WIN' if vexit<credit else 'LOSS'
                    pnl=(credit-vexit)*100
                    key=(sd,w,tp,sl)
                    a=agg[key]; a['n']+=1; a['pnl']+=pnl
                    if outcome=='WIN': a['w']+=1; a['win_sum']+=pnl
                    else: a['nloss']+=1; a['loss_sum']+=pnl
                    perday[key].append((date,or_width,outcome,pnl))

# ---- rank combos ----
rows=[]
for key,a in agg.items():
    if a['n']<200: continue   # need full-sample coverage
    sd,w,tp,sl=key
    wr=100*a['w']/a['n']; exp=a['pnl']/a['n']
    aw=a['win_sum']/a['w'] if a['w'] else 0; al=a['loss_sum']/a['nloss'] if a['nloss'] else 0
    rr=abs(aw/al) if al else 99
    rows.append((exp,wr,a['pnl'],a['n'],aw,al,rr,sd,w,tp,sl))
rows.sort(reverse=True)

print("="*100)
print("TOP 20 COMBOS BY EXPECTANCY/TRADE   (1 contract, real option fills, ~290 days)")
print("="*100)
print(f"{'depth':>5} {'wid':>4} {'TP':>5} {'SL':>5} | {'N':>4} {'WR%':>6} {'Exp$':>6} {'Total$':>8} {'AvgWin':>7} {'AvgLoss':>8} {'R:R':>5}")
print("-"*100)
for r in rows[:20]:
    exp,wr,pnl,n,aw,al,rr,sd,w,tp,sl=r
    print(f"{sd:>5} {w:>4} {tp:>5.2f} {sl:>5} | {n:>4} {wr:>6.1f} {exp:>6.0f} {pnl:>8.0f} {aw:>7.0f} {al:>8.0f} {rr:>5.2f}")

print("\n"+"="*100)
print("USER BASELINE  depth=10 width=10 tp=0.50 sl=or   (for reference)")
print("="*100)
b=agg[(10,10,0.50,'or')]
print(f"N={b['n']} WR={100*b['w']/b['n']:.1f}% Exp=${b['pnl']/b['n']:.0f} Total=${b['pnl']:.0f}")

# ---- OR-width no-trade filter on the best combo ----
best=rows[0]; bestkey=(best[7],best[8],best[9],best[10])
print("\n"+"="*100)
print(f"OR-WIDTH FILTER on BEST combo depth={best[7]} width={best[8]} tp={best[9]} sl={best[10]}")
print("="*100)
pd=perday[bestkey]
print(f"{'min_OR':>7} {'N':>4} {'WR%':>6} {'Exp$':>6} {'Total$':>8}")
print("-"*40)
for thr in [0,10,15,20,25,30,40]:
    sub=[x for x in pd if x[1]>=thr]
    if not sub: continue
    n=len(sub); w=sum(1 for x in sub if x[2]=='WIN'); p=sum(x[3] for x in sub)
    print(f"{thr:>7} {n:>4} {100*w/n:>6.1f} {p/n:>6.0f} {p:>8.0f}")

# ---- monthly consistency for a few named configs ----
def monthly(label, key):
    print("\n"+"="*70)
    print(f"MONTHLY CONSISTENCY — {label}  {key}")
    print("="*70)
    bym=defaultdict(list)
    for date,orw,oc,pnl in perday[key]:
        bym[date[:7]].append((oc,pnl))
    print(f"{'Month':9} {'N':>3} {'WR%':>6} {'Total$':>8}")
    pos=0; tot=0
    for m in sorted(bym):
        rs=bym[m]; n=len(rs); w=sum(1 for x in rs if x[0]=='WIN'); p=sum(x[1] for x in rs)
        if p>0: pos+=1
        tot+=1
        print(f"{m:9} {n:>3} {100*w/n:>6.1f} {p:>8.0f}")
    print(f"  -> positive months: {pos}/{tot}")

monthly("Best expectancy",      (10,5,0.50,'none'))
monthly("Best R:R",             (10,5,0.75,'none'))
monthly("User spec, no stop",   (10,10,0.50,'none'))
monthly("User spec, OR stop",   (10,10,0.50,'or'))
