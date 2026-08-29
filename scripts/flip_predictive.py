#!/usr/bin/env python3
"""
Does the ATM put/call PRICE-RATIO flip predict the forward SPX move? (all 290 days, no cherry-picking)

Each minute 10:00-15:00:
  R(t)   = ATM put / ATM call  (ATM refreshed to nearest strike each minute)
  Mom    = R(t)/R(t-LAG) - 1            (pct accel of the put/call ratio)
  signal = BEAR if Mom>+thr, BULL if Mom<-thr
  fwd    = SPX(t+H) - SPX(t)            (forward move, H min)
Measure, per threshold: #signals, hit-rate (fwd in predicted dir), mean directional move,
and how it compares to the unconditional baseline. If flips are real, hit-rate>>50% and
directional move >> baseline, scaling with threshold.
"""
import duckdb, glob, os
from collections import defaultdict

DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
LAG=3; H=30
THRS=[0.05,0.10,0.20,0.35,0.50]

bucket=defaultdict(lambda: dict(n=0, hit=0, dirmove=0.0, absmove=0.0))
base=dict(n=0,absmove=0.0)

for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet',''); yymmdd=date[2:4]+date[5:7]+date[8:10]
    spx=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:55'::TIME AND '16:00'::TIME ORDER BY ts""").fetchall()
    if len(spx)<150: continue
    sp={t:c for t,c in spx}; times=[t for t,_ in spx]
    spot_ref=sp[times[len(times)//3]]; atmc=round(spot_ref/5)*5
    opts=con.execute(f"""SELECT symbol, strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE timeframe='1m' AND symbol LIKE 'SPXW{yymmdd}%'
        AND CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 BETWEEN {atmc-60} AND {atmc+60}
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:55'::TIME AND '16:00'::TIME ORDER BY ts""").fetchall()
    chain=defaultdict(dict)
    for sym,t,c in opts:
        cp=sym[10]; strike=int(sym[11:19])/1000.0; chain[(cp,strike)][t]=c
    # build R series
    R={}
    for t in times:
        s=sp[t]; atm=round(s/5)*5
        c=chain.get(('C',float(atm)),{}).get(t); p=chain.get(('P',float(atm)),{}).get(t)
        if c and p and c>0.10: R[t]=p/c
    tlist=[t for t in times if t in R]
    for i,t in enumerate(tlist):
        if tm(t)<tm('10:00') or tm(t)>tm('15:00'): continue
        # forward move
        ft=[x for x in times if tm(x)>=tm(t)+H]
        if not ft: continue
        fwd=sp[ft[0]]-sp[t]
        base['n']+=1; base['absmove']+=abs(fwd)
        # lagged R
        prev=[x for x in tlist if tm(x)<=tm(t)-LAG]
        if not prev: continue
        r0=R[prev[-1]]; r1=R[t]
        if r0<=0: continue
        mom=r1/r0-1
        for thr in THRS:
            if mom>thr: d='BEAR'
            elif mom<-thr: d='BULL'
            else: continue
            pred_dir = -1 if d=='BEAR' else 1   # bear predicts fwd<0
            hit = 1 if (fwd*pred_dir>0) else 0
            b=bucket[(thr)]; b['n']+=1; b['hit']+=hit
            b['dirmove']+=fwd*pred_dir; b['absmove']+=abs(fwd)

print(f"Baseline: unconditional mean |fwd {H}min move| = {base['absmove']/base['n']:.2f} pts  (n={base['n']})")
print("\nP/C-RATIO FLIP PREDICTIVE POWER  (LAG=%dmin, forward H=%dmin)"%(LAG,H))
print(f"{'thr':>6} {'Nsig':>7} {'hit%':>6} {'meanDirMove':>12} {'mean|move|':>11}  (dirMove>0 => predicts correctly)")
print("-"*70)
for thr in THRS:
    b=bucket[thr]
    if b['n']==0: print(f"{thr:>6} {0:>7}"); continue
    print(f"{thr:>6} {b['n']:>7} {100*b['hit']/b['n']:>6.1f} {b['dirmove']/b['n']:>12.2f} {b['absmove']/b['n']:>11.2f}")
