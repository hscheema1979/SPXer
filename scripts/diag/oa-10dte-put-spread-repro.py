#!/usr/bin/env python3
"""
Reproduce Option Alpha 'QQQ 10-DTE short put spread' backtest against our data.

OA spec:
  - Entry: 11:00am ET, Mon/Tue/Thu/Fri, exactly 10 market-day DTE
  - Short put: -0.65 delta; Long put: $1.00 below short leg or lower
  - TP: 12.5% of credit; Time exit: 2 days before expiration
  - Position limit 10, 1 contract each

Data:
  - Option trade prints: SPXer flatfile-cache/{QQQ,NDXP}/YYYY/MM/date.json.gz
      {occ_symbol: [[ts,o,h,l,c,vol],...]}  (1m trade OHLCV, sparse)
  - Underlying 1m: SPXer data/parquet/bars/{qqq-1dte,ndx-0dte} symbol==UNDERLYING

Pricing model:
  - Per entry: fit IV smile (quadratic in log-moneyness) to fresh put prints
    of the target expiry near 11:00, spot from underlying bars.
  - Strike selection by BS delta on fitted smile (short: |delta| closest to
    0.65; long: first strike <= short - $1 with a listed contract).
  - Entry credit: BOTH from fitted model (robust) and from raw last prints
    (freshness-tagged) for comparison.
  - Exit: walk forward day by day; TP when model/mark value <= 0.875*credit
    (checked on real spread prints when both legs fresh, else daily model
    value at 15:45); forced close 2 trading days before expiry at model value.
  - Settlement fallback: intrinsic at expiry close (shouldn't happen given
    time exit).
Friction: configurable half-spread per leg charged on entry and exit.
"""
import gzip, json, math, os, sys, bisect
from datetime import datetime, timedelta, timezone
import numpy as np
import pyarrow.parquet as pq

ROOT = '/home/ubuntu/SPXer/data'
ET_OFFSET_CACHE = {}

def et_ts(date, hh, mm):
    """Unix ts for date at hh:mm ET (handles DST via zoneinfo)."""
    from zoneinfo import ZoneInfo
    dt = datetime(int(date[:4]), int(date[5:7]), int(date[8:10]), hh, mm,
                  tzinfo=ZoneInfo('America/New_York'))
    return int(dt.timestamp())

def load_chain(prefix, date):
    p = f"{ROOT}/flatfile-cache/{prefix}/{date[:4]}/{date[5:7]}/{date}.json.gz"
    if not os.path.exists(p): return None
    with gzip.open(p, 'rt') as f:
        return json.load(f)

def parse_occ(sym, prefix):
    body = sym[len(prefix):]
    exp = '20' + body[0:2] + '-' + body[2:4] + '-' + body[4:6]
    right = body[6]
    strike = int(body[7:]) / 1000.0
    return exp, right, strike

def underlying_series(profile, undersym, date):
    p = f"{ROOT}/parquet/bars/{profile}/{date}.parquet"
    if not os.path.exists(p): return None
    df = pq.read_table(p, columns=['symbol','ts','close']).to_pandas()
    u = df[df.symbol == undersym].sort_values('ts')
    if not len(u): return None
    return u.ts.values, u.close.values

def spot_at(series, ts):
    tss, px = series
    i = np.searchsorted(tss, ts, side='right') - 1
    if i < 0: return None
    return float(px[i])

# ── Black-Scholes ────────────────────────────────────────────────────────────
def _phi(x): return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))
def bs_put(S, K, T, iv, r=0.04, q=0.006):
    if T <= 0: return max(0.0, K - S)
    d1 = (math.log(S/K) + (r - q + iv*iv/2)*T) / (iv*math.sqrt(T))
    d2 = d1 - iv*math.sqrt(T)
    return K*math.exp(-r*T)*_phi(-d2) - S*math.exp(-q*T)*_phi(-d1)
def bs_put_delta(S, K, T, iv, r=0.04, q=0.006):
    if T <= 0: return -1.0 if K > S else 0.0
    d1 = (math.log(S/K) + (r - q + iv*iv/2)*T) / (iv*math.sqrt(T))
    return -math.exp(-q*T) * _phi(-d1)
def implied_vol_put(price, S, K, T, r=0.04, q=0.006):
    intrinsic = max(0.0, K*math.exp(-r*T) - S*math.exp(-q*T))
    if price <= intrinsic + 1e-6: return None
    lo, hi = 0.01, 3.0
    for _ in range(60):
        mid = (lo+hi)/2
        if bs_put(S, K, T, mid, r, q) > price: hi = mid
        else: lo = mid
    iv = (lo+hi)/2
    if iv <= 0.011 or iv >= 2.99: return None
    return iv

def last_print(bars, ts, max_age=None):
    """bars: [[ts,o,h,l,c,v],...] sorted. Return (close, age_sec) of last bar <= ts."""
    lo, hi = 0, len(bars)
    while lo < hi:
        mid = (lo+hi)//2
        if bars[mid][0] <= ts: lo = mid+1
        else: hi = mid
    if lo == 0: return None, None
    b = bars[lo-1]
    age = ts - b[0]
    if max_age is not None and age > max_age: return None, age
    return b[4], age

def trading_days(dates_sorted, d0, n):
    """n trading days after d0 within dates list; None if beyond."""
    i = dates_sorted.index(d0)
    if i + n >= len(dates_sorted): return None
    return dates_sorted[i+n]

def fit_smile(chain, prefix, expiry, S, ts, T, fresh_sec=1800):
    """Fit IV(k) quadratic in log-moneyness from fresh put prints of expiry."""
    pts = []
    for sym, bars in chain.items():
        if not sym.startswith(prefix): continue
        exp, right, K = parse_occ(sym, prefix)
        if exp != expiry or right != 'P': continue
        if not (0.88*S <= K <= 1.12*S): continue
        px, age = last_print(bars, ts, fresh_sec)
        if px is None: continue
        iv = implied_vol_put(px, S, K, T)
        if iv is None: continue
        pts.append((math.log(K/S), iv, 1.0/(1.0+age/60.0)))
    if len(pts) < 5: return None, len(pts)
    x = np.array([p[0] for p in pts]); y = np.array([p[1] for p in pts]); w = np.array([p[2] for p in pts])
    # robust-ish: fit, drop >2.5 sigma residuals, refit
    for _ in range(2):
        c = np.polyfit(x, y, 2, w=w)
        resid = y - np.polyval(c, x)
        s = resid.std() or 1e-9
        keep = np.abs(resid) < 2.5*s
        if keep.all() or keep.sum() < 5: break
        x, y, w = x[keep], y[keep], w[keep]
    return (lambda k: float(np.clip(np.polyval(c, np.clip(k, x.min(), x.max())), 0.05, 1.5))), len(x)

def run(prefix, profile, undersym, target_delta=0.65, tp_frac=0.125,
        exit_days_before=2, max_pos=10, entry_days=(0,1,3,4),
        long_gap=1.0, half_spread=0.05, dte=10, fixed_width=None,
        entry_hh=11, entry_mm=0, tp_mode='prints', verbose=False):
    ffdir = f"{ROOT}/flatfile-cache/{prefix}"
    dates = sorted(f[:10] for y in os.listdir(ffdir) for m in os.listdir(f"{ffdir}/{y}")
                   for f in os.listdir(f"{ffdir}/{y}/{m}") if f.endswith('.json.gz'))
    open_pos = []   # dicts
    closed = []
    filtered = {'no_expiry':0, 'pos_limit':0, 'no_spot':0, 'no_smile':0, 'weekday':0, 'no_strike':0}
    chain_cache = {}
    def chain_for(d):
        if d not in chain_cache:
            if len(chain_cache) > 3: chain_cache.pop(next(iter(chain_cache)))
            chain_cache[d] = load_chain(prefix, d)
        return chain_cache[d]

    for d in dates:
        ts_entry = et_ts(d, entry_hh, entry_mm)
        chain = chain_for(d)
        if chain is None: continue
        under = underlying_series(profile, undersym, d)

        # ── manage open positions (daily walk) ─────────────────────────────
        still = []
        for p in open_pos:
            if d < p['entry_date']: still.append(p); continue
            entry_day = (d == p['entry_date'])
            S_ser = under
            # model value at 15:45 using today's smile for p's expiry
            close_reason = None; exit_px = None; exit_ts = None
            Texp = None
            # intraday TP check on real spread prints (both legs fresh same minute)
            sb = chain.get(p['short_sym']); lb = chain.get(p['long_sym'])
            tpV = (1 - tp_frac) * p['credit']
            if tp_mode == 'model' and under is not None:
                # OA-style: check model value at hourly checkpoints (mid fills)
                for (hh, mm) in ((10,0),(11,0),(12,0),(13,0),(14,0),(15,0),(15,45)):
                    ts_c = et_ts(d, hh, mm)
                    if entry_day and ts_c <= et_ts(d, entry_hh, entry_mm): continue
                    S = spot_at(under, ts_c)
                    if S is None: continue
                    Tc = max(0.25, (p['exp_ts'] - ts_c) / 86400.0) / 365.0
                    sm, _ = fit_smile(chain, prefix, p['expiry'], S, ts_c, Tc)
                    if sm is None: continue
                    V = bs_put(S, p['short_K'], Tc, sm(math.log(p['short_K']/S))) \
                        - bs_put(S, p['long_K'], Tc, sm(math.log(p['long_K']/S)))
                    if V <= tpV:
                        close_reason = 'TP'; exit_px = tpV + 2*half_spread; exit_ts = ts_c
                        break
            elif sb and lb:
                # build co-fresh spread prints
                t0 = et_ts(d, entry_hh, entry_mm) if entry_day else 0
                lb_by_ts = {b[0]: b[4] for b in lb}
                for b in sb:
                    if b[0] <= t0: continue
                    if b[0] in lb_by_ts:
                        V = b[4] - lb_by_ts[b[0]]
                        if V <= tpV:
                            close_reason = 'TP'; exit_px = tpV + 2*half_spread; exit_ts = b[0]
                            break
            # forced time exit?
            if close_reason is None and d >= p['force_exit_date'] and not entry_day:
                ts_x = et_ts(d, 15, 45)
                S = spot_at(S_ser, ts_x) if S_ser else None
                if S:
                    Texp = max(0.5, (p['exp_ts'] - ts_x) / 86400.0) / 365.0
                    sm, npts = fit_smile(chain, prefix, p['expiry'], S, ts_x, Texp)
                    if sm:
                        vs = bs_put(S, p['short_K'], Texp, sm(math.log(p['short_K']/S)))
                        vl = bs_put(S, p['long_K'], Texp, sm(math.log(p['long_K']/S)))
                        exit_px = max(0.0, vs - vl) + 2*half_spread
                    else:
                        # fall back to prints
                        ps,_ = last_print(sb or [], ts_x); pl,_ = last_print(lb or [], ts_x)
                        exit_px = max(0.0, (ps or 0) - (pl or 0)) + 2*half_spread
                    close_reason = 'time'; exit_ts = ts_x
            if close_reason:
                pnl = (p['credit'] - exit_px) * p['mult']
                closed.append({**p, 'exit_date': d, 'exit_reason': close_reason,
                               'exit_px': round(exit_px,3), 'pnl': round(pnl,2)})
            else:
                still.append(p)
        open_pos = still

        # ── entry ───────────────────────────────────────────────────────────
        wd = datetime.strptime(d, '%Y-%m-%d').weekday()
        if wd not in entry_days: filtered['weekday'] += 1; continue
        exp = trading_days(dates, d, dte)
        if exp is None: continue   # end of data
        # does this expiry exist in today's chain?
        expiries = set()
        for sym in chain:
            if sym.startswith(prefix):
                e = '20'+sym[len(prefix):len(prefix)+2]+'-'+sym[len(prefix)+2:len(prefix)+4]+'-'+sym[len(prefix)+4:len(prefix)+6]
                expiries.add(e)
        if exp not in expiries:
            filtered['no_expiry'] += 1; continue
        if len(open_pos) >= max_pos:
            filtered['pos_limit'] += 1; continue
        if under is None: filtered['no_spot'] += 1; continue
        S = spot_at(under, ts_entry)
        if S is None: filtered['no_spot'] += 1; continue
        exp_ts = et_ts(exp, 16, 0)
        T = (exp_ts - ts_entry) / 86400.0 / 365.0
        sm, npts = fit_smile(chain, prefix, exp, S, ts_entry, T)
        if sm is None:
            filtered['no_smile'] += 1; continue
        # candidate strikes = listed strikes for this expiry
        strikes = sorted({parse_occ(s, prefix)[2] for s in chain
                          if s.startswith(prefix) and parse_occ(s, prefix)[0]==exp
                          and parse_occ(s, prefix)[1]=='P'})
        # short: delta closest to -target
        best, bestd = None, 9e9
        for K in strikes:
            if not (0.9*S <= K <= 1.15*S): continue
            dlt = abs(bs_put_delta(S, K, T, sm(math.log(K/S))))
            if abs(dlt - target_delta) < bestd: bestd, best = abs(dlt-target_delta), K
        if best is None: filtered['no_strike'] += 1; continue
        shortK = best
        if fixed_width:
            # long = closest listed strike to short-fixed_width
            cands = [K for K in strikes if K <= shortK - fixed_width + 1e-9]
        else:
            cands = [K for K in strikes if K <= shortK - long_gap + 1e-9]
        if not cands: filtered['no_strike'] += 1; continue
        longK = max(cands)
        ivs = sm(math.log(shortK/S)); ivl = sm(math.log(longK/S))
        vs = bs_put(S, shortK, T, ivs); vl = bs_put(S, longK, T, ivl)
        credit_model = vs - vl - 2*half_spread
        # print-based credit for comparison
        ssym = f"{prefix}{exp[2:4]}{exp[5:7]}{exp[8:10]}P{int(round(shortK*1000)):08d}"
        lsym = f"{prefix}{exp[2:4]}{exp[5:7]}{exp[8:10]}P{int(round(longK*1000)):08d}"
        ps, age_s = last_print(chain.get(ssym, []), ts_entry)
        plg, age_l = last_print(chain.get(lsym, []), ts_entry)
        credit_print = (ps - plg) if (ps is not None and plg is not None) else None
        if credit_model <= 0.02: filtered['no_strike'] += 1; continue
        fx = trading_days(dates, exp, -exit_days_before) if exit_days_before else exp
        # force_exit_date = expiry - exit_days_before trading days
        i_exp = dates.index(exp) if exp in dates else None
        if i_exp is not None and i_exp - exit_days_before >= 0:
            fxd = dates[i_exp - exit_days_before]
        else:
            fxd = exp
        newp = dict(entry_date=d, expiry=exp, exp_ts=exp_ts,
            short_K=shortK, long_K=longK, short_sym=ssym, long_sym=lsym,
            credit=credit_model, credit_print=credit_print,
            print_ages=(age_s, age_l), width=shortK-longK,
            short_delta=round(bs_put_delta(S,shortK,T,ivs),3),
            spot=round(S,2), iv=round(ivs,4), mult=100,
            force_exit_date=fxd)
        # same-day TP scan (remainder of entry day)
        tpV0 = (1 - tp_frac) * credit_model
        closed_same = False
        if tp_mode == 'model':
            for (hh, mm) in ((12,0),(13,0),(14,0),(15,0),(15,45)):
                ts_c = et_ts(d, hh, mm)
                if ts_c <= ts_entry: continue
                Sx = spot_at(under, ts_c)
                if Sx is None: continue
                Tc = max(0.25, (exp_ts - ts_c)/86400.0)/365.0
                smx, _ = fit_smile(chain, prefix, exp, Sx, ts_c, Tc)
                if smx is None: continue
                V = bs_put(Sx, shortK, Tc, smx(math.log(shortK/Sx))) \
                    - bs_put(Sx, longK, Tc, smx(math.log(longK/Sx)))
                if V <= tpV0:
                    pnl = (credit_model - (tpV0 + 2*half_spread)) * 100
                    closed.append({**newp, 'exit_date': d, 'exit_reason': 'TP',
                                   'exit_px': round(tpV0+2*half_spread,3), 'pnl': round(pnl,2)})
                    closed_same = True
                    break
        else:
            sb = chain.get(ssym, []); lb = chain.get(lsym, [])
            lb_by_ts = {b[0]: b[4] for b in lb}
            for b in sb:
                if b[0] <= ts_entry: continue
                if b[0] in lb_by_ts and (b[4] - lb_by_ts[b[0]]) <= tpV0:
                    pnl = (credit_model - (tpV0 + 2*half_spread)) * 100
                    closed.append({**newp, 'exit_date': d, 'exit_reason': 'TP',
                                   'exit_px': round(tpV0+2*half_spread,3), 'pnl': round(pnl,2)})
                    closed_same = True
                    break
        if not closed_same:
            open_pos.append(newp)
    # expire whatever remains open at data end (mark at last day model) — report as open
    return closed, open_pos, filtered, dates

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--prefix', default='QQQ')
    ap.add_argument('--profile', default='qqq-1dte')
    ap.add_argument('--under', default='QQQ')
    ap.add_argument('--delta', type=float, default=0.65)
    ap.add_argument('--tp', type=float, default=0.125)
    ap.add_argument('--half-spread', type=float, default=0.05)
    ap.add_argument('--width', type=float, default=None, help='fixed width override')
    ap.add_argument('--dte', type=int, default=10)
    ap.add_argument('--out', default=None)
    ap.add_argument('--tp-mode', default='prints', choices=['prints','model'])
    a = ap.parse_args()
    closed, openp, filt, dates = run(a.prefix, a.profile, a.under,
        target_delta=a.delta, tp_frac=a.tp, half_spread=a.half_spread,
        fixed_width=a.width, dte=a.dte, tp_mode=a.tp_mode)
    pnl = sum(t['pnl'] for t in closed)
    wins = sum(1 for t in closed if t['pnl'] > 0)
    eq=0; peak=0; dd=0
    for t in sorted(closed, key=lambda t:t['exit_date']):
        eq += t['pnl']; peak=max(peak,eq); dd=max(dd,peak-eq)
    print(f"dates {dates[0]}..{dates[-1]}  closed={len(closed)} open_at_end={len(openp)}")
    print(f"filtered: {filt}")
    if closed:
        aw = [t['pnl'] for t in closed if t['pnl']>0]; al=[t['pnl'] for t in closed if t['pnl']<=0]
        print(f"P/L ${pnl:.0f}  WR {wins}/{len(closed)} = {wins/len(closed)*100:.1f}%  maxDD ${dd:.0f}")
        print(f"avg win ${np.mean(aw):.0f}  avg loss ${np.mean(al) if al else 0:.0f}  "
              f"avg credit ${np.mean([t['credit'] for t in closed])*100:.0f}  "
              f"avg width {np.mean([t['width'] for t in closed]):.2f}")
        import collections
        print('exits:', collections.Counter(t['exit_reason'] for t in closed))
    if a.out:
        json.dump({'closed':closed,'open':[{k:v for k,v in p.items()} for p in openp],
                   'filtered':filt}, open(a.out,'w'), indent=1, default=str)
        print('wrote', a.out)
