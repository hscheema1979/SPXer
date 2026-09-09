#!/usr/bin/env python3
"""
Characterize the intraday 'surf' and test whether a simple efficiency metric separates
CHOP (fade the edges) from TREND (ride the break).

Per day (09:35-15:55):
  - zigzag swings >= THR pts -> count, avg size, total 'perfect capture' prize
  - Kaufman Efficiency Ratio ER = |close-open| / sum(|minute moves|)  (0=pure chop, 1=pure trend)
  - net move, full range
Then bucket days by ER to see if it cleanly splits trend vs chop, and how much
'surf prize' lives in each bucket.
"""
import duckdb, glob, os
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)
THR=15.0

def zigzag(closes, thr):
    if not closes: return []
    piv=[closes[0]]; dir=0; ext=closes[0]
    for c in closes[1:]:
        if dir>=0 and c>ext: ext=c
        if dir<=0 and c<ext: ext=c
        if dir>=0 and c<=ext-thr: piv.append(ext); ext=c; dir=-1
        elif dir<=0 and c>=ext+thr: piv.append(ext); ext=c; dir=1
        elif dir==0:
            if c>=piv[0]+thr: dir=1; ext=c
            elif c<=piv[0]-thr: dir=-1; ext=c
    piv.append(ext)
    return piv

rows=[]
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet','')
    spx=con.execute(f"""SELECT close FROM read_parquet('{path}')
        WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:35'::TIME AND '15:55'::TIME
        ORDER BY ts""").fetchall()
    cl=[r[0] for r in spx]
    if len(cl)<200: continue
    net=abs(cl[-1]-cl[0]); rng=max(cl)-min(cl)
    path_sum=sum(abs(cl[i]-cl[i-1]) for i in range(1,len(cl)))
    er = net/path_sum if path_sum else 0
    piv=zigzag(cl,THR)
    legs=[abs(piv[i]-piv[i-1]) for i in range(1,len(piv))]
    prize=sum(legs); nsw=len(legs)
    rows.append(dict(date=date, net=net, rng=rng, er=er, nsw=nsw, prize=prize,
                     avgsw=prize/nsw if nsw else 0))

n=len(rows)
print(f"Days: {n}   THR={THR}pt zigzag\n")
print("OVERALL SURF:")
print(f"  avg #swings/day        : {sum(r['nsw'] for r in rows)/n:.1f}")
print(f"  avg swing size         : {sum(r['avgsw'] for r in rows)/n:.1f} pts")
print(f"  avg daily range        : {sum(r['rng'] for r in rows)/n:.1f} pts")
print(f"  avg net move           : {sum(r['net'] for r in rows)/n:.1f} pts")
print(f"  avg 'perfect capture'  : {sum(r['prize'] for r in rows)/n:.1f} pts  <- prize if you caught every swing")
print(f"  avg efficiency ratio   : {sum(r['er'] for r in rows)/n:.3f}")

for r in rows: r['nr']=r['net']/r['rng'] if r['rng'] else 0
print("\nBUCKET BY NET/RANGE  (0=round-trip chop, 1=clean trend):")
print(f"{'net/range':>11} {'days':>5} {'%':>4} {'avgNet':>7} {'avgRange':>9} {'avg#sw':>7} {'avgPrize':>9}")
bands=[(0,0.2),(0.2,0.4),(0.4,0.6),(0.6,0.8),(0.8,1.01)]
for lo,hi in bands:
    sub=[r for r in rows if lo<=r['nr']<hi]
    if not sub: continue
    d=len(sub)
    print(f"{lo:.1f}-{hi:<5.2f} {d:>5} {100*d/n:>3.0f}% {sum(r['net'] for r in sub)/d:>7.1f} "
          f"{sum(r['rng'] for r in sub)/d:>9.1f} {sum(r['nsw'] for r in sub)/d:>7.1f} "
          f"{sum(r['prize'] for r in sub)/d:>9.1f}")

trend=[r for r in rows if r['nr']>=0.6]; chop=[r for r in rows if r['nr']<0.4]
print(f"\nTREND days (net/range>=0.6): {len(trend)} ({100*len(trend)/n:.0f}%)  avg net {sum(r['net'] for r in trend)/max(len(trend),1):.0f}pt  -> RIDE breakouts")
print(f"CHOP  days (net/range<0.4):  {len(chop)} ({100*len(chop)/n:.0f}%)  avg net {sum(r['net'] for r in chop)/max(len(chop),1):.0f}pt, "
      f"range {sum(r['rng'] for r in chop)/max(len(chop),1):.0f}pt, #swings {sum(r['nsw'] for r in chop)/max(len(chop),1):.1f}  -> FADE edges")
print(f"\nThe catch: net/range is only known at CLOSE. The whole game = detect the regime EARLY (intraday).")
