#!/usr/bin/env python3
"""
A) Always-in Donchian breakout-flip (stop & reverse): ride breaks, auto-flip when they fail.
   Measure SPX-point capture across 290 days, sweep lookback K, split by regime, net of cost.
B) Early-regime prediction: does first-hour (9:35-10:35) net/range predict the FULL-day
   trend-vs-chop regime? If yes we know by 10:35 whether to ride or fade.
"""
import duckdb, glob, os
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)

KS=[10,20,30,45]
COST=0.75   # SPX pts charged per flip (round-trip slippage/spread proxy)

dayrows=[]
flip_by_K=defaultdict(lambda: defaultdict(lambda: dict(pnl=0.0,nt=0)))  # K -> regime -> agg

for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet','')
    bars=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        high, low, close FROM read_parquet('{path}')
        WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
    if len(bars)<200: continue
    et=[b[0] for b in bars]; H=[b[1] for b in bars]; L=[b[2] for b in bars]; C=[b[3] for b in bars]
    net=abs(C[-1]-C[0]); rng=max(C)-min(C); nr=net/rng if rng else 0
    regime='TREND' if nr>=0.6 else ('CHOP' if nr<0.4 else 'MID')

    # first-hour features (9:35-10:35)
    fh=[i for i,t in enumerate(et) if tm(t)<=tm('10:35')]
    fhC=[C[i] for i in fh]
    fh_net=abs(fhC[-1]-fhC[0]); fh_rng=max(fhC)-min(fhC); fh_nr=fh_net/fh_rng if fh_rng else 0
    dayrows.append(dict(date=date,nr=nr,regime=regime,fh_nr=fh_nr,fh_rng=fh_rng,prize=None))

    # A) Donchian breakout-flip per K
    for K in KS:
        pos=0; entry=0.0; pnl=0.0; nt=0
        for i in range(len(C)):
            if i<K: continue
            upper=max(H[i-K:i]); lower=min(L[i-K:i]); c=C[i]
            if pos<=0 and c>upper:
                if pos<0: pnl+=entry-c; nt+=1
                pos=1; entry=c
            elif pos>=0 and c<lower:
                if pos>0: pnl+=c-entry; nt+=1
                pos=-1; entry=c
        if pos>0: pnl+=C[-1]-entry; nt+=1
        elif pos<0: pnl+=entry-C[-1]; nt+=1
        a=flip_by_K[K][regime]; a['pnl']+=pnl-COST*nt; a['nt']+=nt
        flip_by_K[K]['ALL']['pnl']=flip_by_K[K]['ALL'].get('pnl',0)+pnl-COST*nt
        flip_by_K[K]['ALL']['nt']=flip_by_K[K]['ALL'].get('nt',0)+nt

n=len(dayrows)
print("="*84)
print("A) ALWAYS-IN DONCHIAN BREAKOUT-FLIP  (SPX points, net of %.2fpt/flip cost, %d days)"%(COST,n))
print("="*84)
print(f"{'K(min)':>7} {'totPnl':>9} {'pnl/day':>8} {'flips/day':>10} | {'TREND/d':>8} {'CHOP/d':>8} {'MID/d':>7}")
print("-"*84)
nt_reg={r:sum(1 for d in dayrows if d['regime']==r) for r in ['TREND','CHOP','MID']}
for K in KS:
    allp=flip_by_K[K]['ALL']['pnl']; allnt=flip_by_K[K]['ALL']['nt']
    tr=flip_by_K[K]['TREND']; ch=flip_by_K[K]['CHOP']; md=flip_by_K[K]['MID']
    trd=tr['pnl']/nt_reg['TREND'] if nt_reg['TREND'] else 0
    chd=ch['pnl']/nt_reg['CHOP'] if nt_reg['CHOP'] else 0
    mdd=md['pnl']/nt_reg['MID'] if nt_reg['MID'] else 0
    print(f"{K:>7} {allp:>9.0f} {allp/n:>8.1f} {allnt/n:>10.1f} | {trd:>8.1f} {chd:>8.1f} {mdd:>7.1f}")
print("\n(TREND/d = avg pts/day on trend days, etc. Shows the chop 'whipsaw tax'.)")

print("\n"+"="*84)
print("B) EARLY-REGIME PREDICTION: does first-hour net/range predict full-day regime?")
print("="*84)
base_trend=100*sum(1 for d in dayrows if d['regime']=='TREND')/n
base_chop=100*sum(1 for d in dayrows if d['regime']=='CHOP')/n
print(f"Base rate: TREND {base_trend:.0f}%  CHOP {base_chop:.0f}%  (n={n})\n")
print(f"{'first-hr net/range':>20} {'days':>5} {'->TREND%':>9} {'->CHOP%':>8} {'avg full nr':>12}")
print("-"*60)
for lo,hi in [(0,0.2),(0.2,0.4),(0.4,0.6),(0.6,0.8),(0.8,1.01)]:
    sub=[d for d in dayrows if lo<=d['fh_nr']<hi]
    if not sub: continue
    dd=len(sub)
    t=100*sum(1 for d in sub if d['regime']=='TREND')/dd
    c=100*sum(1 for d in sub if d['regime']=='CHOP')/dd
    avgnr=sum(d['nr'] for d in sub)/dd
    print(f"{lo:.1f}-{hi:<5.2f}{'':>8} {dd:>5} {t:>9.0f} {c:>8.0f} {avgnr:>12.2f}")
# simple corr
import statistics as st
xs=[d['fh_nr'] for d in dayrows]; ys=[d['nr'] for d in dayrows]
mx=st.mean(xs); my=st.mean(ys)
cov=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/n
corr=cov/(st.pstdev(xs)*st.pstdev(ys))
print(f"\nPearson corr(first-hour nr, full-day nr) = {corr:.3f}")
