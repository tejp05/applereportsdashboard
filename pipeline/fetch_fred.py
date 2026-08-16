#!/usr/bin/env python3
"""Fetch the macro series the dashboard was missing, straight from FRED.

fredgraph.csv needs no API key. Daily/monthly observations are collapsed to
calendar-year averages, which is the basis every other annual macro series on
the dashboard already uses.

Series
  FEDFUNDS        effective federal funds rate (monthly, 1954-)
  UNRATE          civilian unemployment rate (monthly, 1948-)
  DGS10           10-year Treasury constant maturity (daily, 1962-)
  AAA             Moody's seasoned Aaa corporate bond yield (monthly, 1919-)
  BAA             Moody's seasoned Baa corporate bond yield (monthly, 1919-)

The Moody's series are the market-yield comparison for Apple's own borrowing:
Moody's rates Apple Aaa, so the Aaa curve is the market's price for exactly
Apple's credit, and Baa marks the investment-grade floor for contrast.
"""
import csv
import io
import json
import os
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "fred_macro.json")

SERIES = {
    "fedFundsRate":   ("FEDFUNDS", "1954-01-01"),
    "unemploymentRate": ("UNRATE", "1948-01-01"),
    "treasury10yrAvg": ("DGS10", "1962-01-01"),
    # Moody's seasoned corporate bond yields: monthly, full history, and Aaa is
    # Apple's own Moody's rating bucket. (ICE BofA daily indices are capped to a
    # ~3-year window by the keyless CSV endpoint, so they can't cover the era.)
    "corpAaaYield":   ("AAA", "1976-01-01"),
    "corpBaaYield":   ("BAA", "1976-01-01"),
}


def fetch(series_id, start):
    url = (f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
           f"&cosd={start}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode()
    buckets = defaultdict(list)
    for row in csv.DictReader(io.StringIO(text)):
        date = row.get("observation_date") or row.get("DATE") or list(row.values())[0]
        raw = list(row.values())[1]
        if raw in (".", "", None):
            continue
        buckets[date[:4]].append(float(raw))
    return {y: round(sum(v) / len(v), 2) for y, v in sorted(buckets.items())}


def main():
    out, meta = {}, {}
    for key, (sid, start) in SERIES.items():
        vals = fetch(sid, start)
        out[key] = vals
        years = sorted(vals)
        meta[key] = f"FRED {sid}, calendar-year average of observations ({years[0]}–{years[-1]})"
        print(f"{key:18} {len(vals):>3} years  {years[0]}–{years[-1]}  "
              f"latest {vals[years[-1]]}")
    json.dump({"series": out, "sources": meta}, open(OUT, "w"), indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
