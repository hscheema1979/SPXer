#!/usr/bin/env python3
"""
DOWN-DAY CAPTURE: always-armed, short-only momentum.
  Enter SHORT when SPX breaks a K-min LOW (optionally volume-confirmed).
  Ride it; exit flat when SPX breaks a K-min HIGH (trend flip up). Never go long.
  This rides big down days, steps aside on up days, bleeds small in chop.
Validate per month AND excluding April-2025 tariff week (overfit guard).
"""
import duckdb, glob, os
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
COST=0.75; W=30

days=[]
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet','')
    spx=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        high,low,close FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
    if len(spx)<200: continue
    vol=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        SUM(volume) v FROM read_parquet('{path}') WHERE symbol LIKE 'SPXW%' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME GROUP BY et""").fetchall()
    vmap={t:(v or 0) for t,v in vol}
    et=[b[0] for b in spx]; H=[b[1] for b in spx]; L=[b[2] for b in spx]; C=[b[3] for b in spx]
    V=[vmap.get(t,0) for t in et]
    si=max(i for i,t in enumerate(et) if tm(t)<=tm('10:00'))
    days.append((date,et,H,L,C,V,si))

def run(d,K,volm):
    date,et,H,L,C,V,si=d; pos=0; entry=0.0; pnl=0.0; nt=0
    for i in range(len(C)):
        if i<max(K,W,si): continue
        upper=max(H[i-K:i]); lower=min(L[i-K:i])
        vavg=sum(V[i-W:i])/W if sum(V[i-W:i])>0 else 1
        ok = (V[i]>=volm*vavg) if volm>0 else True
        if pos==0 and C[i]<lower and ok:   # breakdown -> short
            pos=-1; entry=C[i]
        elif pos==-1 and C[i]>upper:        # flip up -> exit flat
            pnl+=entry-C[i]; nt+=1; pos=0
    if pos==-1: pnl+=entry-C[-1]; nt+=1
    return pnl-COST*nt

def report(K,volm):
    perday=[(d[0],run(d,K,volm)) for d in days]
    bym=defaultdict(float)
    for date,p in perday: bym[date[:7]]+=p
    tot=sum(p for _,p in perday); n=len(perday)
    pos=sum(1 for m in bym if bym[m]>0)
    ex=sum(p for date,p in perday if not date.startswith('2025-04')); nex=sum(1 for date,_ in perday if not date.startswith('2025-04'))
    top=sorted(perday,key=lambda x:x[1],reverse=True)[:5]
    print(f"\nK={K} volMult={volm}: total {tot:+.0f}pt ({tot/n:+.2f}/day) | EXCL 2025-04: {ex:+.0f}pt ({ex/nex:+.2f}/day) | pos months {pos}/{len(bym)}")
    print(f"   top5 down-capture days: {[(d,round(p)) for d,p in top]}")
    return bym

print("DOWN-ONLY MOMENTUM CAPTURE (short the breakdown, ride, exit on up-flip)")
for K in [30,45]:
    for volm in [0,1.5,3.0]:
        report(K,volm)

# monthly detail for the most promising (decide after seeing)
print("\n--- monthly detail K=45 volMult=1.5 ---")
bym=report(45,1.5)
for m in sorted(bym): print(f"  {m}: {bym[m]:+.0f}")
