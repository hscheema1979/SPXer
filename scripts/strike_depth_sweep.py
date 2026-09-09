#!/usr/bin/env python3
"""
Bear-call CREDIT spread on DUMP mornings, sweep SHORT-LEG DEPTH (ITM/OTM offset from ATM),
fixed narrow wing. SPX ($5 wing, $5 strikes) and NDX ($10 wing, $10 strikes).
depth>0 = short leg ITM (deep ITM ~ debit-like, low prob/big payoff);
depth<=0 = short ATM/OTM (true credit harvest, high prob).
Entry 10:30 on dump (<= -0.11% vs 09:35). TP 50% credit, stop-less, EOD. Real fills.
"""
import duckdb, glob, os, statistics as st
from collections import defaultdict
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
DUMP_PCT=0.0011

def run_instrument(dirn, root, optpx, step, wing, depths):
    DATA=f"/home/ubuntu/SPXer/data/parquet/bars/{dirn}"
    days=[]
    for path in sorted(glob.glob(f"{DATA}/*.parquet")):
        date=os.path.basename(path).replace('.parquet',''); yymmdd=date[2:4]+date[5:7]+date[8:10]
        u=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
            FROM read_parquet('{path}') WHERE symbol='{root}' AND timeframe='1m'
            AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
                BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
        if len(u)<200: continue
        et=[r[0] for r in u]; C=[r[1] for r in u]; idx={t:i for i,t in enumerate(et)}
        if '10:30' not in idx: continue
        spot=C[idx['10:30']]
        if (spot-C[0])/C[0] > -DUMP_PCT: continue
        eod=C[-1]
        calls=con.execute(f"""SELECT CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 k,
            strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
            FROM read_parquet('{path}') WHERE symbol LIKE '{optpx}{yymmdd}C%' AND timeframe='1m'
            AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
                BETWEEN '10:30'::TIME AND '15:55'::TIME""").fetchall()
        CC=defaultdict(dict)
        for k,t,c in calls: CC[k][t]=c
        days.append((date,et,idx,eod,spot,CC))
    res={}
    for depth in depths:
        out=[]
        for date,et,idx,eod,spot,CC in days:
            atm=round(spot/step)*step
            Ks=atm-depth; Kl=Ks+wing
            sc=CC.get(float(Ks),{}); lc=CC.get(float(Kl),{})
            if '10:30' not in sc or '10:30' not in lc or not sc['10:30'] or not lc['10:30']: continue
            credit=sc['10:30']-lc['10:30']
            if credit<=0.05: continue
            tpV=0.5*credit; ex=None
            for t in et[idx['10:30']+1:]:
                a=sc.get(t); b=lc.get(t)
                if a is not None and b is not None and (a-b)<=tpV: ex=tpV; break
            if ex is None:
                lt=et[-1]; a=sc.get(lt,0) or 0; b=lc.get(lt,0) or 0; ex=min(max(a-b,0),wing)
            out.append((date,(credit-ex)*100,credit))
        res[depth]=out
    return res,len(days)

def report(title, res, ndays, wing):
    print(f"\n{'='*86}\n{title}   ({ndays} dump days, ${wing} wing)\n{'='*86}")
    print(f"{'depth':>6} {'n':>4} {'$/day':>7} {'win%':>6} {'worst':>7} {'exclApr':>8} {'avgCred':>8} {'maxLoss':>8} {'ret/risk':>8}")
    print("-"*86)
    for depth in sorted(res):
        o=res[depth]
        if not o: print(f"{depth:>6}  (no fills)"); continue
        p=[x[1] for x in o]; n=len(p); tot=sum(p); win=100*sum(1 for x in p if x>0)/n
        worst=min(p); cred=st.mean([x[2] for x in o])*100; maxloss=wing*100-cred
        ex=[x[1] for x in o if not x[0].startswith('2025-04')]; exd=sum(ex)/len(ex) if ex else 0
        rr=(tot/n)/maxloss if maxloss>0 else 0
        print(f"{depth:>6} {n:>4} {tot/n:>7.0f} {win:>6.0f} {worst:>7.0f} {exd:>8.0f} {cred:>8.0f} {maxloss:>8.0f} {rr:>8.2f}")

spx,nspx=run_instrument("spx-0dte","SPX","SPXW",5,5,[-30,-20,-10,-5,0,5,10,20,30])
report("SPX bear-call credit, depth sweep", spx, nspx, 5)
ndx,nndx=run_instrument("ndx-0dte","NDX","NDXP",10,10,[-120,-80,-40,-20,0,20,40,80,120])
report("NDX bear-call credit, depth sweep", ndx, nndx, 10)
