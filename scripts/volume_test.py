#!/usr/bin/env python3
"""
Does SPX 0DTE total option volume help?
 A) regime prediction: corr(day vol / first-hour vol, full-day net/range) + trend-rate buckets
 B) volume-CONFIRMED breakout-flip: only act on a Donchian break if that minute's option
    volume >= m * trailing-avg volume. Filters false (low-vol) breaks = chop whipsaw?
"""
import duckdb, glob, os, statistics as st
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
COST=0.75

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
    net=abs(C[-1]-C[0]); rng=max(C)-min(C); nr=net/rng if rng else 0
    regime='TREND' if nr>=0.6 else ('CHOP' if nr<0.4 else 'MID')
    fhv=sum(V[i] for i,t in enumerate(et) if tm(t)<=tm('10:35'))
    days.append(dict(et=et,H=H,L=L,C=C,V=V,nr=nr,regime=regime,dayvol=sum(V),fhvol=fhv,
                     start_i=max(i for i,t in enumerate(et) if tm(t)<=tm('10:00'))))

n=len(days)
def corr(xs,ys):
    mx=st.mean(xs); my=st.mean(ys); cov=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/len(xs)
    sx=st.pstdev(xs); sy=st.pstdev(ys); return cov/(sx*sy) if sx and sy else 0
print(f"A) VOLUME AS REGIME PREDICTOR (n={n})")
for f in ['dayvol','fhvol']:
    c=corr([d[f] for d in days],[d['nr'] for d in days])
    s=sorted(days,key=lambda d:d[f]); k=len(s)//3
    lr=100*sum(1 for d in s[:k] if d['nr']>=0.6)/k; hr=100*sum(1 for d in s[-k:] if d['nr']>=0.6)/k
    print(f"   {f:>8}: corr {c:+.3f}   trend-rate lowTertile {lr:.0f}%  highTertile {hr:.0f}%  (base 42%)")

print(f"\nB) VOLUME-CONFIRMED BREAKOUT-FLIP  (Donchian K=45, vol trailing W=30, net {COST}pt/flip)")
print(f"{'volMult':>8} {'pnl/day':>8} {'flips/d':>8} | {'TREND/d':>8} {'CHOP/d':>8} {'MID/d':>7}")
print("-"*62)
K=45; W=30
for m in [1.0,1.25,1.5,2.0,3.0]:
    tot=0.0; tf=0; byreg={'TREND':[0.0,0],'CHOP':[0.0,0],'MID':[0.0,0]}
    for d in days:
        H,L,C,V,si=d['H'],d['L'],d['C'],d['V'],d['start_i']
        pos=0; entry=0.0; pnl=0.0; nt=0
        for i in range(len(C)):
            if i<max(K,W,si): continue
            upper=max(H[i-K:i]); lower=min(L[i-K:i])
            vavg=sum(V[i-W:i])/W if sum(V[i-W:i])>0 else 1
            volok = V[i] >= m*vavg
            bu=C[i]>upper and volok; bd=C[i]<lower and volok
            if pos<=0 and bu:
                if pos<0: pnl+=entry-C[i]; nt+=1
                pos=1; entry=C[i]
            elif pos>=0 and bd:
                if pos>0: pnl+=C[i]-entry; nt+=1
                pos=-1; entry=C[i]
        if pos>0: pnl+=C[-1]-entry; nt+=1
        elif pos<0: pnl+=entry-C[-1]; nt+=1
        pnl-=COST*nt; tot+=pnl; tf+=nt
        byreg[d['regime']][0]+=pnl; byreg[d['regime']][1]+=1
    tr=byreg['TREND'][0]/byreg['TREND'][1]; ch=byreg['CHOP'][0]/byreg['CHOP'][1]; md=byreg['MID'][0]/byreg['MID'][1]
    tag=" (no filter)" if m==1.0 else ""
    print(f"{m:>8} {tot/n:>8.2f} {tf/n:>8.1f} | {tr:>8.2f} {ch:>8.2f} {md:>7.2f}{tag}")
