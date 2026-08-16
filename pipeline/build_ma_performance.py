#!/usr/bin/env python3
"""Precompute per-deal stock-performance windows for the M&A tab.

For every deal in pipeline/data/ma_deals.json with a close date from July 1988
onward (six months of ^SP500TR history must exist before the window opens):
  window = T-6 months .. T+18 months around the close month
  aaplSeries  = AAPL monthly adjusted close (dividends+splits), indexed to 100 at T-6
  benchSeries = XLK adjusted close when the window starts Jan 1999+ (fund
                inception Dec 1998), else ^SP500TR — both dividend-inclusive,
                like-for-like with the adjusted AAPL series
  aaplReturn / benchReturn = % change over the window; alpha = difference (pp)

Output: pipeline/data/ma_performance.json  (consumed by export_web.py)
"""
import json
import os
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def month_add(ym, delta):
    y, m = int(ym[:4]), int(ym[5:7])
    t = y * 12 + (m - 1) + delta
    return f"{t // 12}-{t % 12 + 1:02d}"


def month_range(a, b):
    out, cur = [], a
    while cur <= b:
        out.append(cur)
        cur = month_add(cur, 1)
    return out


def main():
    ms = json.load(open(os.path.join(DATA, "market_series.json")))
    deals = json.load(open(os.path.join(DATA, "ma_deals.json")))["deals"]
    aapl = ms["monthlyAdjClose"]
    xlk = ms["xlkMonthlyAdj"]
    sptr = ms["sp500TRMonthly"]
    latest = max(aapl)

    out = []
    skipped = []
    for d in deals:
        close = d.get("closeDate") or f"{d['year']}-06"
        if len(close) < 7:            # bare year, e.g. "1988"
            close = f"{close[:4]}-06"
        cm = close[:7]
        t0, t1 = month_add(cm, -6), month_add(cm, 18)
        if t0 < "1988-01":
            skipped.append((d["name"], "pre-benchmark"))
            continue
        use_xlk = t0 >= "1999-01"
        bench = xlk if use_xlk else sptr
        months = month_range(t0, min(t1, latest))
        a_pts = [(m, aapl.get(m)) for m in months]
        b_pts = [(m, bench.get(m)) for m in months]
        a_pts = [(m, v) for m, v in a_pts if v is not None]
        b_pts = [(m, v) for m, v in b_pts if v is not None]
        if len(a_pts) < 8 or len(b_pts) < 8:
            skipped.append((d["name"], "insufficient data"))
            continue
        a0, b0 = a_pts[0][1], b_pts[0][1]
        rec = {
            "name": d["name"],
            "closeDate": close,
            "tMinus6": t0 + "-01",
            "tPlus18": t1 + "-01",
            "benchmark": "XLK" if use_xlk else "S&P 500 (TR)",
            "aaplBasePrice": round(a0, 4),
            "aaplEndPrice": round(a_pts[-1][1], 4),
            "aaplBaseMonth": a_pts[0][0],
            "aaplEndMonth": a_pts[-1][0],
            "aaplReturn": round((a_pts[-1][1] / a0 - 1) * 100, 1),
            "benchReturn": round((b_pts[-1][1] / b0 - 1) * 100, 1),
            "aaplSeries": [{"month": m, "price": round(v / a0 * 100, 2)} for m, v in a_pts],
            "benchSeries": [{"month": m, "price": round(v / b0 * 100, 2)} for m, v in b_pts],
        }
        rec["alpha"] = round(rec["aaplReturn"] - rec["benchReturn"], 1)
        if t1 > latest:
            rec["windowStatus"] = (f"open — 2-year window completes {t1}; "
                                   "figures run through the latest data")
        out.append(rec)

    result = {
        "generated": date.today().isoformat(),
        "note": ("Per-deal windows: AAPL monthly adjusted close (dividends + splits, "
                 "Yahoo Finance) indexed to 100 six months before the close month, "
                 "through 18 months after. Benchmark: XLK adjusted close for windows "
                 "starting Jan 1999+, ^SP500TR before that — both dividend-inclusive. "
                 "alpha = AAPL % return minus benchmark % return over the window."),
        "deals": out,
    }
    path = os.path.join(DATA, "ma_performance.json")
    json.dump(result, open(path, "w"))
    print(f"wrote {path}: {len(out)} windows, {len(skipped)} skipped")
    for name, why in skipped[:10]:
        print("  skipped:", name, "—", why)


if __name__ == "__main__":
    main()
