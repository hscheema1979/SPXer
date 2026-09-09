#!/usr/bin/env python3
"""
Combined adaptive surf system:
  By 10:35 compute first-hour net/range (fh_nr).
  fh_nr >= G  -> predict TREND -> trade WITH breaks (Donchian breakout-flip)
  fh_nr <  G  -> predict CHOP  -> trade AGAINST breaks (fade-flip)
  Always-in after 10:35, stop & reverse, force-flat 15:55. SPX points, net of cost.
Compare vs pure-ride baseline, and break out by ACTUAL regime to see if the gate routes right.
"""
import duckdb, glob, os
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
COST=0.75

def run(H,L,C,start_i,K,mode):
    """always-in from first signal after start_i; mode 'ride' trades with breaks, 'fade' against."""
    pos=0; entry=0.0; pnl=0.0; nt=0
    for i in range(len(C)):
        if i<max(K,start_i): continue
        upper=max(H[i-K:i]); lower=min(L[i-K:i]); c=C[i]
        brk_up = c>upper; brk_dn = c<lower
        if mode=='ride':
            want_long=brk_up; want_short=brk_dn
        else: # fade
            want_long=brk_dn; want_short=brk_up
        if pos<=0 and want_long:
            if pos<0: pnl+=entry-c; nt+=1
            pos=1; entry=c
        elif pos>=0 and want_short:
            if pos>0: pnl+=c-entry; nt+=1
            pos=-1; entry=c
    if pos>0: pnl+=C[-1]-entry; nt+=1
    elif pos<0: pnl+=entry-C[-1]; nt+=1
    return pnl-COST*nt, nt

for K in [20,30,45]:
  for G in [0.4,0.5]:
    agg=defaultdict(lambda: dict(pnl=0.0,nd=0)); tot=0.0; nd=0; pure=0.0
    for path in sorted(glob.glob(f"{DATA}/*.parquet")):
        bars=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
            high,low,close FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
            AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
                BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
        if len(bars)<200: continue
        et=[b[0] for b in bars]; Hh=[b[1] for b in bars]; Ll=[b[2] for b in bars]; Cc=[b[3] for b in bars]
        net=abs(Cc[-1]-Cc[0]); rng=max(Cc)-min(Cc); nr=net/rng if rng else 0
        regime='TREND' if nr>=0.6 else ('CHOP' if nr<0.4 else 'MID')
        start_i=max(i for i,t in enumerate(et) if tm(t)<=tm('10:35'))
        fhC=Cc[:start_i+1]; fh_net=abs(fhC[-1]-fhC[0]); fh_rng=max(fhC)-min(fhC); fh_nr=fh_net/fh_rng if fh_rng else 0
        mode='ride' if fh_nr>=G else 'fade'
        pnl,nt=run(Hh,Ll,Cc,start_i,K,mode)
        purepnl,_=run(Hh,Ll,Cc,start_i,K,'ride')
        agg[regime]['pnl']+=pnl; agg[regime]['nd']+=1
        agg[mode]['pnl']=agg[mode].get('pnl',0)+pnl; agg[mode]['nd']=agg[mode].get('nd',0)+1
        tot+=pnl; pure+=purepnl; nd+=1
    print(f"\nK={K} gate G={G}: ADAPTIVE {tot/nd:+.2f} pts/day (tot {tot:+.0f}) | pure-ride {pure/nd:+.2f}/day")
    for r in ['TREND','MID','CHOP']:
        a=agg[r]
        if a['nd']: print(f"   actual {r:5}: {a['pnl']/a['nd']:+6.2f}/day  ({a['nd']} days)")
    rd=agg.get('ride',{'pnl':0,'nd':0}); fd=agg.get('fade',{'pnl':0,'nd':0})
    if rd['nd']: print(f"   -> routed RIDE {rd['nd']}d {rd['pnl']/rd['nd']:+.2f}/day | FADE {fd['nd']}d {fd['pnl']/max(fd['nd'],1):+.2f}/day")
