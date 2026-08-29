#!/usr/bin/env python3
"""
Regime-predictor bake-off: which early/contextual feature best predicts the full-day
trend-vs-chop regime (full-day net/range)? Rank by |correlation| and trend-rate spread.
Candidates (all knowable by ~11:00 ET or from prior day):
  fh_nr        first-hour (9:35-10:35) net/range
  brk_hold     OR(9:30-10:00) break-and-hold at 11:00: dist beyond OR edge / OR width
  gap_abs      |open - prior-day close|  (pts)
  straddle_pct ATM (call+put) near 10:00 / spot * 100   (expected-move proxy)
  fh_range     first-hour high-low (pts)
  prev_nr      prior day's full net/range (persistence)
"""
import duckdb, glob, os, statistics as st
from collections import defaultdict
DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)

rows=[]; prev_close=None; prev_nr=None
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet',''); yymmdd=date[2:4]+date[5:7]+date[8:10]
    bars=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et,
        high,low,close FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '09:30'::TIME AND '15:55'::TIME ORDER BY ts""").fetchall()
    if len(bars)<200:
        prev_close=None; prev_nr=None; continue
    et=[b[0] for b in bars]; Hh=[b[1] for b in bars]; Ll=[b[2] for b in bars]; Cc=[b[3] for b in bars]
    net=abs(Cc[-1]-Cc[0]); rng=max(Cc)-min(Cc); nr=net/rng if rng else 0

    # OR 9:30-10:00
    ori=[i for i,t in enumerate(et) if tm(t)<tm('10:00')]
    or_h=max(Hh[i] for i in ori); or_l=min(Ll[i] for i in ori); or_w=or_h-or_l if or_h>or_l else 1
    # first hour 9:35-10:35
    fhi=[i for i,t in enumerate(et) if tm(t)<=tm('10:35')]
    fhC=[Cc[i] for i in fhi]; fh_net=abs(fhC[-1]-fhC[0]); fh_rng=max(fhC)-min(fhC)
    fh_nr=fh_net/fh_rng if fh_rng else 0; fh_range=fh_rng
    # break-and-hold at 11:00
    i11=max(i for i,t in enumerate(et) if tm(t)<=tm('11:00')); c11=Cc[i11]
    brk_hold=max(0.0,(c11-or_h),(or_l-c11))/or_w
    # gap
    gap_abs=abs(Cc[0]-prev_close) if prev_close else None
    # straddle near 10:00
    spot10=Cc[i11 if False else max(i for i,t in enumerate(et) if tm(t)<=tm('10:00'))]
    atm=round(spot10/5)*5
    opt=con.execute(f"""SELECT symbol, close FROM read_parquet('{path}') WHERE timeframe='1m'
        AND symbol IN ('SPXW{yymmdd}C{int(atm*1000):08d}','SPXW{yymmdd}P{int(atm*1000):08d}')
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')='10:00'""").fetchall()
    sp={s[10]:c for s,c in opt}
    straddle_pct=(sp['C']+sp['P'])/spot10*100 if 'C' in sp and 'P' in sp else None

    rows.append(dict(date=date,nr=nr,fh_nr=fh_nr,brk_hold=brk_hold,gap_abs=gap_abs,
                     straddle_pct=straddle_pct,fh_range=fh_range,prev_nr=prev_nr))
    prev_close=Cc[-1]; prev_nr=nr

def corr(xs,ys):
    pairs=[(x,y) for x,y in zip(xs,ys) if x is not None and y is not None]
    if len(pairs)<30: return None,0
    xs=[p[0] for p in pairs]; ys=[p[1] for p in pairs]
    mx=st.mean(xs); my=st.mean(ys)
    cov=sum((x-mx)*(y-my) for x,y in zip(xs,ys))/len(xs)
    sx=st.pstdev(xs); sy=st.pstdev(ys)
    return (cov/(sx*sy) if sx and sy else 0), len(pairs)

print(f"Regime-predictor bake-off  (target = full-day net/range, n={len(rows)} days)\n")
print(f"{'feature':>14} {'corr':>7} {'n':>5} | trend-rate: {'lowTertile':>10} {'highTertile':>11}")
print("-"*70)
feats=['fh_nr','brk_hold','gap_abs','straddle_pct','fh_range','prev_nr']
res=[]
for f in feats:
    c,nn=corr([r[f] for r in rows],[r['nr'] for r in rows])
    if c is None: continue
    valid=[r for r in rows if r[f] is not None]
    valid.sort(key=lambda r:r[f])
    k=len(valid)//3
    lowT=valid[:k]; highT=valid[-k:]
    lr=100*sum(1 for r in lowT if r['nr']>=0.6)/len(lowT)
    hr=100*sum(1 for r in highT if r['nr']>=0.6)/len(highT)
    res.append((abs(c),f,c,nn,lr,hr))
res.sort(reverse=True)
for ac,f,c,nn,lr,hr in res:
    print(f"{f:>14} {c:>7.3f} {nn:>5} | {'':12} {lr:>9.0f}% {hr:>10.0f}%")
base=100*sum(1 for r in rows if r['nr']>=0.6)/len(rows)
print(f"\nBase trend rate: {base:.0f}%.  A useful predictor pushes high-tertile trend-rate well above base.")
