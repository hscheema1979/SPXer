#!/usr/bin/env python3
"""
User's idea: when the market dumps in the morning, sell a 0DTE ITM bear call credit spread.
Structure: short (ATM-10) call [ITM], long (ATM) call. Width 10. Entry 10:30. TP 50% credit. Stop-less. EOD.
Bearish + short-vol + defined risk: profits if SPX falls/stays, capped loss if it rallies back.

Test 3 variants, real 1-min option fills, 291 days:
  ALL      : enter every day at 10:30 (directional baseline)
  DUMP     : enter only when 10:30 is >=8pt BELOW 09:35 (confirmed morning downmove)
  RALLY-chk: enter only on UP mornings (sanity: should be bad for a bear spread)
Compare expectancy/win to the neutral harvest (~$22/day) and inspect big-down vs reversal days.
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
    spot=C[idx['10:30']]; mom=spot-C[0]; eod=C[-1]
    day_move=eod-spot   # move from entry to close
    atm=round(spot/5)*5
    calls=con.execute(f"""SELECT CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 strike,
        strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol LIKE 'SPXW{yymmdd}C%' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '10:30'::TIME AND '15:55'::TIME""").fetchall()
    Cc=defaultdict(dict)
    for k,t,c in calls: Cc[k][t]=c
    sc=Cc.get(float(atm-10),{}); lc=Cc.get(float(atm),{})   # short ITM, long ATM
    if '10:30' not in sc or '10:30' not in lc or not sc['10:30'] or not lc['10:30']: continue
    credit=sc['10:30']-lc['10:30']
    if credit<=0.1: continue
    tpV=0.5*credit; ex=None
    for t in et[idx['10:30']+1:]:
        if t in sc and t in lc and sc[t] is not None and lc[t] is not None:
            V=sc[t]-lc[t]
            if V<=tpV: ex=tpV; break
    if ex is None:
        lt=et[-1]; V=(sc.get(lt,0) or 0)-(lc.get(lt,0) or 0); ex=min(max(V,0),10)
    pnl=(credit-ex)*100
    rows.append(dict(date=date,mom=mom,move=day_move,credit=credit,pnl=pnl))

def stats(name, sub):
    if not sub: print(f"{name}: no days"); return
    p=[r['pnl'] for r in sub]; n=len(p); tot=sum(p); avg=tot/n
    win=100*sum(1 for x in p if x>0)/n; sd=st.pstdev(p); worst=min(p)
    print(f"{name:28} n={n:>3}  tot ${tot:>7,.0f}  ${avg:>5.0f}/day  win {win:4.0f}%  std ${sd:>4.0f}  worst ${worst:>6,.0f}")

alld=rows
dump=[r for r in rows if r['mom']<=-DUMP]
rally=[r for r in rows if r['mom']>=DUMP]
flat=[r for r in rows if abs(r['mom'])<DUMP]
print("ITM BEAR CALL CREDIT SPREAD (short ATM-10 / long ATM), 10:30 entry, TP50%, stop-less\n")
stats("ALL days", alld)
stats("DUMP mornings (<=-8pt)", dump)
stats("FLAT mornings", flat)
stats("RALLY mornings (>=+8pt)", rally)
print(f"\n(neutral bull-put harvest baseline was ~$22/day, 75% win)\n")

print("On DUMP mornings — did the day keep falling or reverse?")
cont=[r for r in dump if r['move']<0]; rev=[r for r in dump if r['move']>=0]
print(f"  kept falling after 10:30: {len(cont)}/{len(dump)} ({100*len(cont)/len(dump):.0f}%)  -> these are wins for the spread")
print(f"  reversed UP after 10:30:  {len(rev)}/{len(dump)} ({100*len(rev)/len(dump):.0f}%)  -> spread loses")
stats("   dump & kept falling", cont)
stats("   dump & reversed up", rev)

print("\nBiggest DUMP days (entry->close move) and the spread P&L:")
for r in sorted(dump,key=lambda r:r['move'])[:8]:
    print(f"  {r['date']}  entry->close {r['move']:+6.0f}pt  credit ${r['credit']*100:>4.0f}  pnl ${r['pnl']:>5.0f}")

print("\n=== ROBUSTNESS: DUMP-morning bear call, monthly + excl April-2025 ===")
bym=defaultdict(lambda:[0.0,0])
for r in dump: bym[r['date'][:7]][0]+=r['pnl']; bym[r['date'][:7]][1]+=1
for m in sorted(bym): print(f"  {m}: ${bym[m][0]:>6,.0f}  ({bym[m][1]} dump days)")
pos=sum(1 for m in bym if bym[m][0]>0)
ex=[r for r in dump if not r['date'].startswith('2025-04')]
exn=len(ex); ext=sum(r['pnl'] for r in ex)
print(f"positive months: {pos}/{len(bym)}")
print(f"EXCL April-2025: n={exn}  tot ${ext:,.0f}  ${ext/exn:.0f}/day  (vs all-dump $144/day)")
top5=sum(r['pnl'] for r in sorted(dump,key=lambda r:r['pnl'],reverse=True)[:5])
print(f"top-5 dump days = ${top5:,.0f} = {100*top5/sum(r['pnl'] for r in dump):.0f}% of dump total (concentration)")
