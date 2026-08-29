#!/usr/bin/env python3
"""Validate volume-confirmed breakout-flip: monthly consistency + day-concentration (overfit check)."""
import duckdb, glob, os
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
COST=0.75; K=45; W=30

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

def run(d,m):
    date,et,H,L,C,V,si=d; pos=0; entry=0.0; pnl=0.0; nt=0
    for i in range(len(C)):
        if i<max(K,W,si): continue
        upper=max(H[i-K:i]); lower=min(L[i-K:i])
        vavg=sum(V[i-W:i])/W if sum(V[i-W:i])>0 else 1
        ok=V[i]>=m*vavg
        bu=C[i]>upper and ok; bd=C[i]<lower and ok
        if pos<=0 and bu:
            if pos<0: pnl+=entry-C[i]; nt+=1
            pos=1; entry=C[i]
        elif pos>=0 and bd:
            if pos>0: pnl+=C[i]-entry; nt+=1
            pos=-1; entry=C[i]
    if pos>0: pnl+=C[-1]-entry; nt+=1
    elif pos<0: pnl+=entry-C[-1]; nt+=1
    return pnl-COST*nt

for m in [1.5,3.0]:
    perday=[(d[0],run(d,m)) for d in days]
    bym=defaultdict(float); bymn=defaultdict(int)
    for date,p in perday: bym[date[:7]]+=p; bymn[date[:7]]+=1
    tot=sum(p for _,p in perday); n=len(perday)
    pos=sum(1 for mth in bym if bym[mth]>0)
    print(f"\n===== volMult={m}  total {tot:+.0f}pt  ({tot/n:+.2f}/day, {n} days) =====")
    print(f"{'month':9}{'pnl':>8}{'days':>6}")
    for mth in sorted(bym): print(f"{mth:9}{bym[mth]:>8.0f}{bymn[mth]:>6}")
    print(f"positive months: {pos}/{len(bym)}")
    # concentration: top 5 days
    top=sorted(perday,key=lambda x:x[1],reverse=True)[:5]
    bot=sorted(perday,key=lambda x:x[1])[:5]
    print(f"top5 days: {[(d,round(p)) for d,p in top]}")
    print(f"bot5 days: {[(d,round(p)) for d,p in bot]}")
    top5sum=sum(p for _,p in top)
    print(f"top-5 days = {top5sum:.0f}pt = {100*top5sum/tot:.0f}% of total  (concentration check)")
    # excl April 2025 (tariff week)
    ex=sum(p for date,p in perday if not date.startswith('2025-04'))
    nex=sum(1 for date,_ in perday if not date.startswith('2025-04'))
    print(f"excl 2025-04: {ex:+.0f}pt ({ex/nex:+.2f}/day, {nex} days)")
