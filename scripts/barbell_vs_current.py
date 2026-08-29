#!/usr/bin/env python3
"""
HEAD-TO-HEAD: current (harvest only) vs barbell (harvest + down-capture overlay).
Real 1-min option fills, $ per 1 contract each leg, 290 days.

HARVEST (current, mirrors live creditPut): at 13:00 sell bull-put spread short ATM / long ATM-10,
  TP buy back at 50% of credit, stop-less, EOD settle at intrinsic.
OVERLAY (down-capture): armed after 10:00; on SPX break of 45-min LOW with option-vol >=3x trailing,
  BUY 1 ATM put (real fill); exit (sell) on break of 45-min HIGH (up-flip) or EOD. Re-entry allowed.
"""
import duckdb, glob, os, statistics as st
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
K=45; W=30; VOLM=3.0

rows=[]
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet',''); yymmdd=date[2:4]+date[5:7]+date[8:10]
    spx=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        high,low,close FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
    if len(spx)<200: continue
    et=[b[0] for b in spx]; H=[b[1] for b in spx]; L=[b[2] for b in spx]; C=[b[3] for b in spx]
    vol=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        SUM(volume) v FROM read_parquet('{path}') WHERE symbol LIKE 'SPXW%' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME GROUP BY et""").fetchall()
    vmap={t:(v or 0) for t,v in vol}; V=[vmap.get(t,0) for t in et]
    # all put closes for the day
    puts=con.execute(f"""SELECT CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 strike,
        strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol LIKE 'SPXW{yymmdd}P%' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME""").fetchall()
    P=defaultdict(dict)
    for k,t,c in puts: P[k][t]=c
    idx={t:i for i,t in enumerate(et)}

    # ---- HARVEST ----
    harvest=0.0
    if '13:00' in idx:
        spot=C[idx['13:00']]; atm=round(spot/5)*5
        sp=P.get(float(atm),{}); lp=P.get(float(atm-10),{})
        if '13:00' in sp and '13:00' in lp and sp['13:00'] and lp['13:00']:
            credit=sp['13:00']-lp['13:00']
            if credit>0.1:
                tpV=0.5*credit; ex=None
                for t in et[idx['13:00']+1:]:
                    if t in sp and t in lp and sp[t] is not None and lp[t] is not None:
                        Vv=sp[t]-lp[t]
                        if Vv<=tpV: ex=tpV; break
                if ex is None:
                    lt=et[-1]
                    Vv=(sp.get(lt,0) or 0)-(lp.get(lt,0) or 0); ex=min(max(Vv,0),10)
                harvest=(credit-ex)*100

    # ---- OVERLAY (down-capture, buy ATM put) ----
    overlay=0.0; pos=False; ent=0.0; entk=None
    si=idx.get('10:00',0)
    for i in range(len(C)):
        if i<max(K,W,si): continue
        upper=max(H[i-K:i]); lower=min(L[i-K:i])
        vavg=sum(V[i-W:i])/W if sum(V[i-W:i])>0 else 1
        t=et[i]
        if not pos and C[i]<lower and V[i]>=VOLM*vavg:
            atm=round(C[i]/5)*5; px=P.get(float(atm),{}).get(t)
            if px and px>0.05: pos=True; ent=px; entk=float(atm)
        elif pos and C[i]>upper:
            px=P.get(entk,{}).get(t)
            if px is not None: overlay+=(px-ent)*100; pos=False
    if pos:
        lt=et[-1]; px=P.get(entk,{}).get(lt)
        # settle put at intrinsic if no quote
        if px is None: px=max(0.0, entk-C[-1])
        overlay+=(px-ent)*100

    rows.append(dict(date=date, harvest=harvest, overlay=overlay))

def stats(name, pnls):
    n=len(pnls); tot=sum(pnls); avg=tot/n
    pos=100*sum(1 for p in pnls if p>0)/n
    sd=st.pstdev(pnls)
    worst=min(pnls); worst5=sum(sorted(pnls)[:5])
    # max drawdown on cumulative
    cum=0; peak=0; mdd=0
    for p in pnls:
        cum+=p; peak=max(peak,cum); mdd=min(mdd,cum-peak)
    sharpe=avg/sd*(252**0.5) if sd else 0
    print(f"{name:18} tot ${tot:>8,.0f}  ${avg:>6.0f}/day  win {pos:4.0f}%  std ${sd:>4.0f}  "
          f"worst ${worst:>6,.0f}  worst5 ${worst5:>7,.0f}  maxDD ${mdd:>7,.0f}  ann.Sharpe {sharpe:4.2f}")

H=[r['harvest'] for r in rows]; O=[r['overlay'] for r in rows]
B=[r['harvest']+r['overlay'] for r in rows]
Bhalf=[r['harvest']+0.5*r['overlay'] for r in rows]
n=len(rows)
print(f"HEAD-TO-HEAD  ({n} days, $ per 1 contract/leg)\n")
stats("CURRENT (harvest)", H)
stats("  overlay alone", O)
stats("BARBELL (1x ovl)", B)
stats("BARBELL (0.5x ovl)", Bhalf)

print("\nBIG DOWN DAYS — does the overlay rescue the harvest?")
print(f"{'date':12}{'harvest':>9}{'overlay':>9}{'barbell':>9}")
for r in sorted(rows,key=lambda r:r['harvest'])[:10]:
    print(f"{r['date']:12}{r['harvest']:>9.0f}{r['overlay']:>9.0f}{r['harvest']+r['overlay']:>9.0f}")

print("\nMonthly (harvest vs barbell 1x):")
bm=defaultdict(lambda:[0.0,0.0])
for r in rows: bm[r['date'][:7]][0]+=r['harvest']; bm[r['date'][:7]][1]+=r['harvest']+r['overlay']
ph=sum(1 for m in bm if bm[m][0]>0); pb=sum(1 for m in bm if bm[m][1]>0)
for m in sorted(bm): print(f"  {m}  harvest ${bm[m][0]:>7,.0f}   barbell ${bm[m][1]:>7,.0f}")
print(f"positive months: harvest {ph}/{len(bm)}  barbell {pb}/{len(bm)}")
