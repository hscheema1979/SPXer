#!/usr/bin/env python3
"""
RELIABILITY STRESS TEST of the dump bear-call credit spread (SPX, short ATM-10 / long ATM, $10 wing).
 1) SLIPPAGE: subtract realistic per-trade fill cost (you sell at bid, buy back at ask).
 2) DUMP-THRESHOLD robustness: does the edge persist across thresholds or only at -8pt?
 3) Reports excl-April for every cell (overfit guard).
"""
import duckdb, glob, os, statistics as st
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
from collections import defaultdict

# precompute per-day trade (credit, TP exit, EOD exit) independent of threshold/slippage
trades=[]
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
    atm=round(spot/5)*5
    cc=con.execute(f"""SELECT CAST(SUBSTR(symbol,12,8) AS BIGINT)/1000.0 k,
        strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol LIKE 'SPXW{yymmdd}C%' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '10:30'::TIME AND '15:55'::TIME""").fetchall()
    Cc=defaultdict(dict)
    for k,t,c in cc: Cc[k][t]=c
    sc=Cc.get(float(atm-10),{}); lc=Cc.get(float(atm),{})
    if '10:30' not in sc or '10:30' not in lc or not sc['10:30'] or not lc['10:30']: continue
    credit=sc['10:30']-lc['10:30']
    if credit<=0.1: continue
    tpV=0.5*credit; ex=None
    for t in et[idx['10:30']+1:]:
        a=sc.get(t); b=lc.get(t)
        if a is not None and b is not None and (a-b)<=tpV: ex=tpV; break
    if ex is None:
        lt=et[-1]; a=sc.get(lt,0) or 0; b=lc.get(lt,0) or 0; ex=min(max(a-b,0),10)
    trades.append(dict(date=date,mom=mom,credit=credit,exitV=ex))

def pnl(tr, slip):
    # slip = $ per spread per side; sell to open (receive less), buy to close (pay more)
    return (tr['credit']-tr['exitV'])*100 - 2*slip

print("1) SLIPPAGE STRESS  (dump <= -8pt; slip = $/spread/side)")
print(f"{'slip/side':>10} {'$/day':>7} {'win%':>6} {'$/day exclApr':>14}")
dump=[t for t in trades if t['mom']<=-8]
for slip in [0,5,10,15,20,30]:
    p=[pnl(t,slip) for t in dump]; ex=[pnl(t,slip) for t in dump if not t['date'].startswith('2025-04')]
    print(f"{slip:>10} {sum(p)/len(p):>7.0f} {100*sum(1 for x in p if x>0)/len(p):>6.0f} {sum(ex)/len(ex):>14.0f}")

print("\n2) DUMP-THRESHOLD ROBUSTNESS  (at realistic slip=$15/side)")
print(f"{'threshold':>10} {'Ndays':>6} {'$/day':>7} {'win%':>6} {'$/day exclApr':>14}")
for thr in [-3,-5,-8,-10,-12,-15,-20]:
    sub=[t for t in trades if t['mom']<=thr]
    if not sub: continue
    p=[pnl(t,15) for t in sub]; ex=[pnl(t,15) for t in sub if not t['date'].startswith('2025-04')]
    print(f"{thr:>10} {len(sub):>6} {sum(p)/len(p):>7.0f} {100*sum(1 for x in p if x>0)/len(p):>6.0f} {sum(ex)/len(ex) if ex else 0:>14.0f}")

print("\n3) For reference: ALL days (no dump filter) at slip=$15 — is the dump filter actually adding edge?")
p=[pnl(t,15) for t in trades]; ex=[pnl(t,15) for t in trades if not t['date'].startswith('2025-04')]
print(f"   all days: {sum(p)/len(p):.0f}/day  win {100*sum(1 for x in p if x>0)/len(p):.0f}%  exclApr {sum(ex)/len(ex):.0f}/day  (n={len(trades)})")
