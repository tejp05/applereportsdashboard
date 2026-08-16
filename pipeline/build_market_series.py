#!/usr/bin/env python3
"""Derive every market data series the dashboard needs from raw Yahoo data.

Inputs (pipeline/data/):
  aapl_daily_yahoo_raw.json   AAPL daily OHLCV + adjclose, 1980-12-12 →
  aapl_events_yahoo.json      AAPL splits + dividends (split-adjusted amounts)
  hist_GSPC_daily.json        ^GSPC daily close, 1980-01-02 →
  hist_SP500TR_monthly.json   ^SP500TR monthly, 1988-01 →
  hist_XLK_monthly.json       XLK monthly adjclose, 1998-12 →

Output: pipeline/data/market_series.json
  dailyAdj        [["YYYY-MM-DD", adjClose], ...]        (Story Mode file source)
  monthlyPriceQ   {"YYYY-MM": rawClose} Jan/Apr/Jul/Oct  (macro.aaplMonthlyPrice)
  totalReturnPct  {year: %} calendar-year, adj close     (macro.aaplTotalReturn)
  dividendYieldPct{year: %} divs paid / year-end price   (macro.aaplDividendYield)
  beta5yr         {year: b} 60-mo OLS vs ^GSPC           (macro.aaplBeta5yr)
  avgDailyVolM    {year: M shares}                       (macro.aaplAvgDailyVolume)
  splitAdjYearEnd {year: $} split-only-adjusted close    (EV_PRICE calculator)
  fyEndRawClose   {fy: $} raw close, last Sep trading day (financials.stockPrice)
  fyEndDate       {fy: "YYYY-MM-DD"}
  monthlyAdjClose {"YYYY-MM": adj} full monthly           (maPerformance input)
  sp500TRMonthly  {"YYYY-MM": level}
  xlkMonthlyAdj   {"YYYY-MM": adj}
  aaplQuarterlyAdj{"YYYY-MM-DD(q-end)": adj} 2021-12-31 → (competitors TR chart)
  bigMoves        [{date, pct}] |move| >= 4%, 2024-01 →
  high52/low52/ath: current stats from raw closes
"""
import json
import os
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def load(name):
    return json.load(open(os.path.join(DATA, name)))


def chart_series(raw, want_adj=True):
    r = raw["chart"]["result"][0]
    ts = r["timestamp"]
    quote = r["indicators"]["quote"][0]
    closes = quote["close"]
    vols = quote.get("volume") or [None] * len(ts)
    adjs = r["indicators"].get("adjclose", [{}])[0].get("adjclose", closes)
    rows = []
    for i, t in enumerate(ts):
        d = datetime.fromtimestamp(t, tz=timezone.utc).date()
        rows.append((d, closes[i], adjs[i] if want_adj else closes[i], vols[i]))
    return [r for r in rows if r[1] is not None and r[2] is not None]


def main():
    aapl = chart_series(load("aapl_daily_yahoo_raw.json"))
    gspc = chart_series(load("hist_GSPC_daily.json"), want_adj=False)
    sptr_m = chart_series(load("hist_SP500TR_monthly.json"), want_adj=False)
    xlk_m = chart_series(load("hist_XLK_monthly.json"))
    events = load("aapl_events_yahoo.json")["chart"]["result"][0].get("events", {})

    out = {}

    # ---- daily adjusted (story mode) ----
    out["dailyAdj"] = [[d.isoformat(), round(adj, 4 if adj < 5 else 2)]
                       for d, _c, adj, _v in aapl]

    # ---- split factors: cumulative future-split multiple per date ----
    splits = sorted(
        ((datetime.fromtimestamp(int(k), tz=timezone.utc).date(),
          v["numerator"] / v["denominator"])
         for k, v in events.get("splits", {}).items()),
        key=lambda x: x[0])

    def split_factor(d):
        f = 1.0
        for sd, ratio in splits:
            if d < sd:
                f *= ratio
        return f

    # ---- monthly tables ----
    monthly_raw_first = {}   # first trading day's raw close per month
    monthly_adj_last = {}    # last trading day's adjusted close per month
    for d, close, adj, _v in aapl:
        key = f"{d.year}-{d.month:02d}"
        monthly_raw_first.setdefault(key, close)
        monthly_adj_last[key] = adj
    out["monthlyAdjClose"] = {k: round(v, 4) for k, v in monthly_adj_last.items()}
    out["monthlyPriceQ"] = {k: round(v, 2) for k, v in monthly_raw_first.items()
                            if int(k[5:7]) in (1, 4, 7, 10)}

    # ---- calendar-year total return (adjusted close) ----
    yearend_adj, yearend_raw, yearend_date = {}, {}, {}
    for d, close, adj, _v in aapl:
        yearend_adj[d.year] = adj
        yearend_raw[d.year] = close
        yearend_date[d.year] = d
    years = sorted(yearend_adj)
    tr = {}
    for y in years[1:]:
        if y - 1 in yearend_adj:
            tr[str(y)] = round((yearend_adj[y] / yearend_adj[y - 1] - 1) * 100, 2)
    out["totalReturnPct"] = tr

    # ---- dividend yield: split-adjusted divs in year / split-adjusted year-end close ----
    divs_by_year = {}
    for v in events.get("dividends", {}).values():
        d = datetime.fromtimestamp(int(v["date"]), tz=timezone.utc).date()
        divs_by_year[d.year] = divs_by_year.get(d.year, 0.0) + v["amount"]
    dy = {}
    for y in years:
        # yearend_raw is Yahoo's close = already split-adjusted, same basis as divs
        dy[str(y)] = round(divs_by_year.get(y, 0.0) / yearend_raw[y] * 100, 2)
    out["dividendYieldPct"] = dy

    # ---- 5-yr monthly beta vs ^GSPC ----
    gspc_monthly = {}
    for d, close, _a, _v in gspc:
        gspc_monthly[f"{d.year}-{d.month:02d}"] = close
    months = sorted(set(monthly_adj_last) & set(gspc_monthly))
    rets = []  # (month, aapl_ret, gspc_ret)
    for i in range(1, len(months)):
        m0, m1 = months[i - 1], months[i]
        rets.append((m1,
                     monthly_adj_last[m1] / monthly_adj_last[m0] - 1,
                     gspc_monthly[m1] / gspc_monthly[m0] - 1))
    beta = {}
    for y in range(1986, years[-1] + 1):
        window = [r for r in rets if r[0] <= f"{y}-12"][-60:]
        if len(window) < 60:
            continue
        xs = [r[2] for r in window]
        ys = [r[1] for r in window]
        mx, my = sum(xs) / 60, sum(ys) / 60
        cov = sum((x - mx) * (yy - my) for x, yy in zip(xs, ys))
        var = sum((x - mx) ** 2 for x in xs)
        beta[str(y)] = round(cov / var, 2)
    out["beta5yr"] = beta

    # ---- avg daily volume (M shares, Yahoo current-split basis) ----
    volsum, volcnt = {}, {}
    for d, _c, _a, v in aapl:
        if v:
            volsum[d.year] = volsum.get(d.year, 0) + v
            volcnt[d.year] = volcnt.get(d.year, 0) + 1
    out["avgDailyVolM"] = {str(y): round(volsum[y] / volcnt[y] / 1e6, 1)
                           for y in sorted(volsum)}

    # ---- split-adjusted year-end closes (investment calculator) ----
    # Yahoo's close field is already split-adjusted — use directly
    out["splitAdjYearEnd"] = {
        str(y): round(yearend_raw[y], 4 if yearend_raw[y] < 5 else 2)
        for y in years}

    # ---- fiscal-year-end (last Sep trading day) closes ----
    # split-adjusted basis (Yahoo close) for financials.stockPrice charting,
    # raw as-traded basis (x future-split factor) for marketCap = price x shares
    fy_close, fy_date, fy_dateobj = {}, {}, {}
    for d, close, _a, _v in aapl:
        if d.month == 9:
            fy_close[d.year] = close
            fy_date[d.year] = d.isoformat()
            fy_dateobj[d.year] = d
    out["fyEndSplitAdjClose"] = {str(y): round(v, 4 if v < 5 else 2)
                                 for y, v in fy_close.items()}
    out["fyEndRawTradedClose"] = {
        str(y): round(v * split_factor(fy_dateobj[y]), 2)
        for y, v in fy_close.items()}
    out["fyEndDate"] = fy_date
    # per-share split-adjustment factor per fiscal year: divide any figure
    # as reported in FY y's own 10-K by this to get today's share basis
    out["fySplitDivisor"] = {
        str(y): split_factor(fy_dateobj[y]) for y in fy_close}

    # ---- benchmarks monthly ----
    out["sp500TRMonthly"] = {f"{d.year}-{d.month:02d}": round(c, 2)
                             for d, c, _a, _v in sptr_m}
    out["xlkMonthlyAdj"] = {f"{d.year}-{d.month:02d}": round(a, 4)
                            for d, _c, a, _v in xlk_m}

    # ---- quarterly adjusted closes since 2021-12-31 (competitors chart) ----
    qends = {}
    for d, _c, adj, _v in aapl:
        if d >= datetime(2021, 12, 1, tzinfo=timezone.utc).date() and d.month in (3, 6, 9, 12):
            qends[f"{d.year}-{d.month:02d}"] = (d.isoformat(), round(adj, 2))
    out["aaplQuarterlyAdj"] = {v[0]: v[1] for v in qends.values()}
    # latest close as the "current" point
    last = aapl[-1]
    out["latest"] = {"date": last[0].isoformat(), "close": round(last[1], 2),
                     "adjClose": round(last[2], 2)}
    prev = aapl[-2]
    out["latest"]["prevClose"] = round(prev[1], 2)

    # ---- big single-day moves 2024+ ----
    big = []
    for i in range(1, len(aapl)):
        d, _c, adj, _v = aapl[i]
        if d.year >= 2024:
            pct = (adj / aapl[i - 1][2] - 1) * 100
            if abs(pct) >= 4:
                big.append({"date": d.isoformat(), "pct": round(pct, 1)})
    out["bigMoves"] = big

    # ---- 52-week + ATH from raw closes ----
    cutoff = aapl[-1][0].toordinal() - 365
    win = [(d, c) for d, c, _a, _v in aapl if d.toordinal() >= cutoff]
    out["high52"] = round(max(c for _d, c in win), 2)
    out["low52"] = round(min(c for _d, c in win), 2)
    ath_d, ath_c = max(((d, c) for d, c, _a, _v in aapl), key=lambda x: x[1])
    out["ath"] = {"price": round(ath_c, 2), "date": ath_d.isoformat()}

    # ---- 1-year price return (raw close basis, like LIVE.stockReturn1Y) ----
    base = win[0]
    out["return1YPct"] = round((aapl[-1][1] / base[1] - 1) * 100, 2)
    out["return1YBaseDate"] = base[0].isoformat()

    path = os.path.join(DATA, "market_series.json")
    json.dump(out, open(path, "w"))
    print("wrote", path)
    print("daily points:", len(out["dailyAdj"]), out["dailyAdj"][0][0], "→", out["dailyAdj"][-1][0])
    print("TR sample:", {k: tr[k] for k in list(tr)[:3]}, "… 2025:", tr.get("2025"))
    print("divYield 1990/2015/2025:", dy.get("1990"), dy.get("2015"), dy.get("2025"))
    print("beta 1995/2010/2025:", beta.get("1995"), beta.get("2010"), beta.get("2025"))
    print("splitAdj year-end 1985/2000/2025:", out["splitAdjYearEnd"].get("1985"),
          out["splitAdjYearEnd"].get("2000"), out["splitAdjYearEnd"].get("2025"))
    print("FY-end adj close 1981/2000/2025:", out["fyEndSplitAdjClose"].get("1981"),
          out["fyEndSplitAdjClose"].get("2000"), out["fyEndSplitAdjClose"].get("2025"))
    print("FY-end raw traded 1981/2013/2025:", out["fyEndRawTradedClose"].get("1981"),
          out["fyEndRawTradedClose"].get("2013"), out["fyEndRawTradedClose"].get("2025"))
    print("fySplitDivisor 1986/1987/2013/2014:", out["fySplitDivisor"].get("1986"),
          out["fySplitDivisor"].get("1987"), out["fySplitDivisor"].get("2013"),
          out["fySplitDivisor"].get("2014"))
    print("latest:", out["latest"], "52wk:", out["low52"], "-", out["high52"],
          "ath:", out["ath"], "1Y:", out["return1YPct"])
    print("bigMoves 2024+:", len(big), big[:6])


if __name__ == "__main__":
    main()
