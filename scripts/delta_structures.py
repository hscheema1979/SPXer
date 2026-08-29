#!/usr/bin/env python3
"""
On confirmed DUMP mornings (10:30 <= -8pt vs 09:35), compare 0DTE BEARISH structures:
  CREDIT  : ITM bear call (short ATM-10 / long ATM), TP50% credit, stop-less, EOD  [short vol]
  DEBIT25 : put debit spread long ~0.25d put / short ~0.10d put, hold EOD          [long vol]
  DEBIT10 : put debit spread long ~0.10d put / short ~0.05d put, hold EOD          [lottery]
  DEBIT25_TP: same as DEBIT25 but take profit if spread reaches 60% of its width
Strikes chosen by CHAIN-IMPLIED delta: |d_put(K)| ~= (P[K+5]-P[K-5])/10.
Real 1-min fills, robustness vs April-2025. Risk shown (debit = max loss for debit spreads).
"""
import duckdb, glob, os, statistics as st
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
DUMP=8.0

rows=[]
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet',''); yymmdd=date[2:4]+date[5:7]+date[8:10]
    spx=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
    if len(spx)<200: continue
    et=[b[0] for b in spx]; C=[b[1] for b in spx]; idx={t:i for i,t in enumerate(et)}
    if '10:30' not in idx: continue
    spot=C[idx['10:30']]; mom=spot-C[0]
    if mom> -DUMP: continue            # dump days only
    eod=C[-1]
    # load chain (calls + puts) closes
    ch=con.execute(f"""SELECT SUBSTR(symbol,11,1) cp, CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 k,
        strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol LIKE 'SPXW{yymmdd}%' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '10:30'::TIME AND '15:55'::TIME""").fetchall()
    P=defaultdict(dict); Cc=defaultdict(dict)
    for cp,k,t,c in ch:
        (P if cp=='P' else Cc)[k][t]=c
    atm=round(spot/5)*5

    # ---- chain-implied put delta at 10:30 ----
    pstrikes=sorted(k for k in P if '10:30' in P[k] and P[k]['10:30'] is not None)
    def pdelta(k):
        a=P.get(k+5,{}).get('10:30'); b=P.get(k-5,{}).get('10:30')
        if a is None or b is None: return None
        return max(0.0,(a-b)/10.0)
    def nearest_delta(target):
        best=None;bd=9
        for k in pstrikes:
            d=pdelta(k)
            if d is None: continue
            if abs(d-target)<bd: bd=abs(d-target); best=k
        return best
    k25=nearest_delta(0.25); k10=nearest_delta(0.10); k05=nearest_delta(0.05)

    def put_val(klong,kshort,t):
        a=P.get(klong,{}).get(t); b=P.get(kshort,{}).get(t)
        if a is None or b is None: return None
        return a-b
    def put_intrinsic(klong,kshort):
        return min(max(0.0,(klong-eod)),(klong-kshort)) - 0  # capped at width
    rec=dict(date=date,mom=mom,move=eod-spot)

    # CREDIT bear call
    sc=Cc.get(atm-10,{}); lc=Cc.get(atm,{})
    if '10:30' in sc and '10:30' in lc and sc['10:30'] and lc['10:30']:
        credit=sc['10:30']-lc['10:30']; tpV=0.5*credit; ex=None
        for t in et[idx['10:30']+1:]:
            v=put_val.__self__ if False else None
            a=sc.get(t); b=lc.get(t)
            if a is not None and b is not None and (a-b)<=tpV: ex=tpV; break
        if ex is None:
            lt=et[-1]; a=sc.get(lt,0) or 0; b=lc.get(lt,0) or 0; ex=min(max(a-b,0),10)
        rec['CREDIT']=(credit-ex)*100

    # DEBIT spreads (hold to EOD)
    def debit_eod(klong,kshort):
        if klong is None or kshort is None or klong<=kshort: return None,None
        d=put_val(klong,kshort,'10:30')
        if d is None or d<=0.05: return None,None
        lt=et[-1]; ve=put_val(klong,kshort,lt)
        if ve is None: ve=min(max(0.0,klong-eod), klong-kshort)
        return (ve-d)*100, d*100
    rec['DEBIT25'],rec['risk25']=debit_eod(k25,k10)
    rec['DEBIT10'],rec['risk10']=debit_eod(k10,k05)
    # DEBIT25 with TP at 60% of width
    if k25 and k10 and k25>k10:
        d=put_val(k25,k10,'10:30')
        if d and d>0.05:
            width=k25-k10; tp=0.6*width; ex=None
            for t in et[idx['10:30']+1:]:
                v=put_val(k25,k10,t)
                if v is not None and v>=tp: ex=tp; break
            if ex is None:
                lt=et[-1]; ve=put_val(k25,k10,lt); ex=ve if ve is not None else min(max(0.0,k25-eod),width)
            rec['DEBIT25_TP']=(ex-d)*100
    rows.append(rec)

def stats(name, key):
    sub=[r for r in rows if r.get(key) is not None]
    if not sub: print(f"{name}: n/a"); return
    p=[r[key] for r in sub]; n=len(p); tot=sum(p); win=100*sum(1 for x in p if x>0)/n
    worst=min(p); sd=st.pstdev(p)
    ex=[r[key] for r in sub if not r['date'].startswith('2025-04')]
    ext=sum(ex); exn=len(ex)
    riskkey={'DEBIT25':'risk25','DEBIT10':'risk10'}.get(key)
    rk=f" avgRisk ${st.mean([r[riskkey] for r in sub if r.get(riskkey)]):.0f}" if riskkey else ""
    print(f"{name:12} n={n:>3} tot ${tot:>7,.0f} ${tot/n:>5.0f}/day win {win:4.0f}% worst ${worst:>6,.0f}"
          f" | exclApr ${ext/exn:>4.0f}/day{rk}")

print(f"DUMP-morning 0DTE BEARISH structures, head-to-head ({len(rows)} dump days)\n")
stats("CREDIT(ITMbc)","CREDIT")
stats("DEBIT 25d","DEBIT25")
stats("DEBIT 10d","DEBIT10")
stats("DEBIT25 +TP","DEBIT25_TP")
print("\n(CREDIT=short vol, wins if stalls; DEBIT=long vol, needs continuation but capped risk=debit)")
print("\nDays the dump KEPT FALLING vs REVERSED — per structure avg:")
for key in ['CREDIT','DEBIT25','DEBIT10']:
    cont=[r[key] for r in rows if r.get(key) is not None and r['move']<0]
    rev=[r[key] for r in rows if r.get(key) is not None and r['move']>=0]
    print(f"  {key:9}: kept-falling avg ${st.mean(cont):>5.0f} ({len(cont)})  reversed avg ${st.mean(rev):>5.0f} ({len(rev)})")
