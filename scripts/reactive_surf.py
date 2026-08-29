#!/usr/bin/env python3
"""
REACTIVE (not predictive) regime adaptation: per-minute rolling efficiency ratio decides mode.
  rolling ER over window W = |C[i]-C[i-W]| / path(last W)
  ER >= thr -> currently TRENDING -> ride breaks (Donchian K)
  ER <  thr -> currently CHOPPY   -> fade breaks
Always-in after 10:00, stop & reverse, flat 15:55. SPX pts net of cost. Sweep W,thr,K.
"""
import duckdb, glob, os
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
COST=0.75

days=[]
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    bars=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        high,low,close FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
    if len(bars)<200: continue
    et=[b[0] for b in bars]; H=[b[1] for b in bars]; L=[b[2] for b in bars]; C=[b[3] for b in bars]
    net=abs(C[-1]-C[0]); rng=max(C)-min(C); nr=net/rng if rng else 0
    regime='TREND' if nr>=0.6 else ('CHOP' if nr<0.4 else 'MID')
    start_i=max(i for i,t in enumerate(et) if tm(t)<=tm('10:00'))
    days.append((et,H,L,C,regime,start_i))

def sim(et,H,L,C,start_i,K,W,thr):
    pos=0; entry=0.0; pnl=0.0; nt=0
    for i in range(len(C)):
        if i<max(K,W,start_i): continue
        upper=max(H[i-K:i]); lower=min(L[i-K:i])
        path=sum(abs(C[j]-C[j-1]) for j in range(i-W+1,i+1)) or 1
        er=abs(C[i]-C[i-W])/path
        mode_ride = er>=thr
        bu=C[i]>upper; bd=C[i]<lower
        want_long = bu if mode_ride else bd
        want_short= bd if mode_ride else bu
        if pos<=0 and want_long:
            if pos<0: pnl+=entry-C[i]; nt+=1
            pos=1; entry=C[i]
        elif pos>=0 and want_short:
            if pos>0: pnl+=C[i]-entry; nt+=1
            pos=-1; entry=C[i]
    if pos>0: pnl+=C[-1]-entry; nt+=1
    elif pos<0: pnl+=entry-C[-1]; nt+=1
    return pnl-COST*nt

n=len(days)
print(f"REACTIVE rolling-ER surf  (net {COST}pt/flip, {n} days)\n")
print(f"{'K':>3} {'W':>3} {'thr':>4} {'pnl/day':>8} {'total':>8} | {'TREND/d':>8} {'CHOP/d':>8} {'MID/d':>7}")
print("-"*68)
best=None
for K in [20,30]:
  for W in [20,30,45]:
    for thr in [0.25,0.35,0.45]:
        tot=0.0; byreg={'TREND':[0.0,0],'CHOP':[0.0,0],'MID':[0.0,0]}
        for et,H,L,C,regime,si in days:
            p=sim(et,H,L,C,si,K,W,thr); tot+=p
            byreg[regime][0]+=p; byreg[regime][1]+=1
        pd=tot/n
        tr=byreg['TREND'][0]/byreg['TREND'][1]; ch=byreg['CHOP'][0]/byreg['CHOP'][1]; md=byreg['MID'][0]/byreg['MID'][1]
        print(f"{K:>3} {W:>3} {thr:>4} {pd:>8.2f} {tot:>8.0f} | {tr:>8.2f} {ch:>8.2f} {md:>7.2f}")
        if best is None or pd>best[0]: best=(pd,K,W,thr)
print(f"\nBest: pnl/day {best[0]:+.2f}  K={best[1]} W={best[2]} thr={best[3]}")
