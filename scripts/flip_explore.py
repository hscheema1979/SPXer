#!/usr/bin/env python3
"""
EXPLORATORY: characterize the option-tape vs SPX relationship around big intraday moves.

For each day: find the largest sustained directional run after 10:00 ET (start->end).
For the biggest-move days, dump the minute tape around the LAUNCH point:
  SPX, fixed-ATM call, fixed-ATM put, straddle(call+put), put/call ratio,
  and 3-min deltas of each — so we can SEE if/when the option relationship flips.
"""
import duckdb, glob, os
from collections import defaultdict

DATA="/home/ubuntu/SPXer/data/parquet/bars/spx-0dte"
con=duckdb.connect()
def tm(s): h,m=s.split(':'); return int(h)*60+int(m)

days=[]
for path in sorted(glob.glob(f"{DATA}/*.parquet")):
    date=os.path.basename(path).replace('.parquet','')
    spx=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        AND strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M')::TIME
            BETWEEN '10:00'::TIME AND '16:00'::TIME ORDER BY ts""").fetchall()
    if len(spx)<120: continue
    ts_=[(t,c) for t,c in spx]
    # largest run: track min and max running, find biggest up-run and down-run
    # simple: for each t, biggest forward move within 90 min
    best=(0,None,None,None)  # absmove, start, end, dir
    closes=ts_
    n=len(closes)
    # running: find max(close[j]-close[i]) and min over i<j within 90 bars
    for i in range(n):
        lo=hi=closes[i][1]; loj=hij=i
        for j in range(i+1, min(i+91,n)):
            c=closes[j][1]
            up=c-closes[i][1]; dn=closes[i][1]-c
            if abs(up)>best[0] and up>0: best=(up,closes[i][0],closes[j][0],'UP')
            if abs(dn)>best[0] and dn>0: best=(dn,closes[i][0],closes[j][0],'DOWN')
    days.append((best[0],date,best[1],best[2],best[3]))

days.sort(reverse=True)
print("TOP 12 BIG-MOVE DAYS (largest sustained run after 10:00, within 90 min)")
print(f"{'date':12}{'move':>7} {'dir':>5} {'launch':>8} {'end':>7}")
for mv,date,s,e,d in days[:12]:
    print(f"{date:12}{mv:>7.1f} {d:>5} {s:>8} {e:>7}")

# dump tape around launch for top 4
def dump(date, launch, direction):
    path=f"{DATA}/{date}.parquet"; yymmdd=date[2:4]+date[5:7]+date[8:10]
    spx=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
        FROM read_parquet('{path}') WHERE symbol='SPX' AND timeframe='1m'
        ORDER BY ts""").fetchall()
    bym={t:c for t,c in spx}
    spot=bym[launch]; atm=round(spot/5)*5
    csym=f"SPXW{yymmdd}C{int(atm*1000):08d}"; psym=f"SPXW{yymmdd}P{int(atm*1000):08d}"
    def series(sym):
        r=con.execute(f"""SELECT strftime(to_timestamp(ts) AT TIME ZONE 'America/New_York','%H:%M') et, close
            FROM read_parquet('{path}') WHERE symbol='{sym}' AND timeframe='1m' ORDER BY ts""").fetchall()
        return {t:c for t,c in r}
    cc=series(csym); pp=series(psym)
    print("\n"+"="*92)
    print(f"{date}  {direction} move, launch~{launch}, ATM={atm}   (fixed ATM call/put through the turn)")
    print("="*92)
    print(f"{'et':>6}{'SPX':>9}{'dSPX':>6} | {'call':>7}{'dC':>6} | {'put':>7}{'dP':>6} | {'strad':>7}{'dStr':>6} | {'P/C':>6}")
    lo=tm(launch)-15; hi=tm(launch)+12
    times=sorted([t for t in bym if lo<=tm(t)<=hi], key=tm)
    prev=None
    for t in times:
        s=bym.get(t); c=cc.get(t); p=pp.get(t)
        if s is None or c is None or p is None: continue
        strad=c+p; pc=p/c if c else 0
        if prev:
            ds=s-prev[0]; dc=c-prev[1]; dp=p-prev[2]; dstr=strad-prev[3]
        else:
            ds=dc=dp=dstr=0
        mark=' <-launch' if t==launch else ''
        print(f"{t:>6}{s:>9.1f}{ds:>6.1f} | {c:>7.2f}{dc:>6.2f} | {p:>7.2f}{dp:>6.2f} | {strad:>7.2f}{dstr:>6.2f} | {pc:>6.2f}{mark}")
        prev=(s,c,p,strad)

for mv,date,s,e,d in days[:4]:
    dump(date,s,d)
