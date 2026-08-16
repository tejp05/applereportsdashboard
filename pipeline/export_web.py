#!/usr/bin/env python3
"""Assemble window.AAPL_DATA and write ../data.js.

Inputs (pipeline/data/):
  sec_annual.json                      XBRL as-reported annuals (FY2006–FY2025)
  research_financials_partial.json     10-K / prospectus rows (FY1977–2007)
  research_financials_1986_1993.json   (optional) crisis-era rows when research lands
  employees_services.json              employees FY2008–25, Services rev FY2013–25
  shares_outstanding_1981_2008.json    period-end shares, as reported
  market_series.json                   everything derived from Yahoo data
  segments_categories.json             (optional) researched category table incl. FY2025
  ma_deals.json                        (optional) researched deal list
  ma_performance.json                  (optional) computed deal windows
  ../../annualreportsdashboard/data.js macro block reused (company-agnostic series)

Rules: never estimate — a year/metric without a source stays null. Per-share
figures are converted to the CURRENT split-adjusted basis (divide as-reported
by market_series.fySplitDivisor), matching how Apple restates prior years.
Market cap = as-reported period-end shares x as-traded FY-end close (same
contemporaneous basis on both sides — no split adjustment needed).
"""
import json
import os
import re
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
ROOT = os.path.dirname(HERE)
IBM_DATAJS = os.path.join(os.path.dirname(ROOT), "annualreportsdashboard", "data.js")

def load(name, optional=False):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        if optional:
            print(f"  (optional {name} not present — skipping)")
            return None
        raise SystemExit(f"missing required input: {p}")
    return json.load(open(p))

def r2(v):
    return None if v is None else round(v, 2)

FIN_FIELDS = ["revenue", "netIncome", "epsDiluted", "epsBasic", "dividendsPerShare",
              "totalAssets", "stockholdersEquity", "rdExpense", "employees",
              "marketCap", "pretaxIncome", "incomeTaxes", "freeCashFlow",
              "operatingCashFlow", "capitalExpenditure", "totalDebt",
              "servicesRevenue", "sharesOutstandingM", "stockPrice"]

def main():
    sec = load("sec_annual.json")
    research = load("research_financials_partial.json")
    crisis = load("research_financials_1986_1993.json", optional=True)
    es = load("employees_services.json")
    shares_hist = {r["fy"]: r["sharesM"] for r in
                   load("shares_outstanding_1981_2008.json")["sharesOutstanding"]}
    ms = load("market_series.json")
    seg_extra = load("segments_categories.json", optional=True)
    ma_deals = load("ma_deals.json", optional=True)
    ma_perf = load("ma_performance.json", optional=True)
    quarterly = load("quarterly_aapl.json", optional=True)
    valuation = load("valuation_peers.json", optional=True)
    fred = load("fred_macro.json", optional=True)

    divisor = {int(k): v for k, v in ms["fySplitDivisor"].items()}
    fy_adj_close = {int(k): v for k, v in ms["fyEndSplitAdjClose"].items()}
    fy_raw_close = {int(k): v for k, v in ms["fyEndRawTradedClose"].items()}
    employees = {e["year"]: e["count"] for e in es["employees"]}
    services = {s["year"]: s["revenueM"] for s in es["services"]}

    # ---------------- financials ----------------
    rows = {}
    def base_row(y):
        return {"year": y, **{f: None for f in FIN_FIELDS},
                "freeCashFlowVerified": False, "operatingCashFlowVerified": False,
                "capitalExpenditureVerified": False, "freeCashFlowNote": None}

    research_rows = []
    for key in ("fin_1977_1985", "fin_1986_1993", "fin_1994_2000", "fin_2001_2007"):
        if key in research and research[key]:
            research_rows += research[key]["rows"]
    if crisis:
        research_rows += crisis["rows"]

    for rr in research_rows:
        y = rr["year"]
        if y >= 2008:
            continue
        row = rows.setdefault(y, base_row(y))
        for f in ("revenue", "netIncome", "totalAssets", "stockholdersEquity",
                  "rdExpense", "employees", "operatingCashFlow",
                  "capitalExpenditure", "totalDebt", "pretaxIncome", "incomeTaxes",
                  "sharesOutstandingM"):
            if rr.get(f) is not None:
                row[f] = rr[f]
        d = divisor.get(y, 1)
        for f in ("epsBasic", "epsDiluted", "dividendsPerShare"):
            if rr.get(f) is not None:
                row[f] = round(rr[f] / d, 4)
        if rr.get("operatingCashFlow") is not None:
            row["operatingCashFlowVerified"] = True
        if rr.get("capitalExpenditure") is not None:
            row["capitalExpenditureVerified"] = True

    for fy_s, sr in sec.items():
        y = int(fy_s)
        if y < 2008:
            continue
        row = rows.setdefault(y, base_row(y))
        for f in ("revenue", "netIncome", "totalAssets", "stockholdersEquity",
                  "rdExpense", "operatingCashFlow", "capitalExpenditure",
                  "totalDebt", "pretaxIncome", "incomeTaxes", "sharesOutstandingM"):
            if sr.get(f) is not None:
                row[f] = sr[f]
        d = divisor.get(y, 1)
        for f in ("epsBasic", "epsDiluted", "dividendsPerShare"):
            if sr.get(f) is not None:
                row[f] = round(sr[f] / d, 4)
        row["operatingCashFlowVerified"] = sr.get("operatingCashFlow") is not None
        row["capitalExpenditureVerified"] = sr.get("capitalExpenditure") is not None

    for y, row in rows.items():
        if row["employees"] is None and y in employees:
            row["employees"] = employees[y]
        if y in services:
            row["servicesRevenue"] = services[y]
        if row["operatingCashFlow"] is not None and row["capitalExpenditure"] is not None:
            row["freeCashFlow"] = round(row["operatingCashFlow"] - row["capitalExpenditure"], 1)
            row["freeCashFlowVerified"] = (row["operatingCashFlowVerified"]
                                           and row["capitalExpenditureVerified"])
            row["freeCashFlowNote"] = ("Derived: operating cash flow − capital expenditure "
                                       "(Apple states no headline FCF; both inputs from the "
                                       "audited cash-flow statement)")
        row["stockPrice"] = fy_adj_close.get(y)
        # market cap: as-reported period-end shares x as-traded FY-end close
        sh = None
        if 1981 <= y <= 2008:
            sh = shares_hist.get(y)
        elif y >= 2009:
            sh = sec.get(str(y), {}).get("periodEndShares")
        if sh is not None and y in fy_raw_close:
            row["marketCap"] = round(sh * fy_raw_close[y])

    years = sorted(rows)
    financials = [rows[y] for y in years]
    missing_ni = [y for y in years if rows[y]["netIncome"] is None]
    gap_years = [y for y in range(1977, 2026) if y not in rows]
    if gap_years:
        print(f"  WARNING: missing years entirely: {gap_years}")
    if missing_ni:
        print(f"  WARNING: netIncome null in {missing_ni} (story ridge needs it)")

    # ---------------- segments ----------------
    WEAR = "Wearables, Home and Accessories"
    # FY2021–FY2024 category tables, validated below by summing to the audited
    # net-sales total from the XBRL layer (a real cross-check, not decoration).
    categories = {
        2021: {"iPhone": 191973, "Mac": 35190, "iPad": 31862, WEAR: 38367, "Services": 68425},
        2022: {"iPhone": 205489, "Mac": 40177, "iPad": 29292, WEAR: 41241, "Services": 78129},
        2023: {"iPhone": 200583, "Mac": 29357, "iPad": 28300, WEAR: 39845, "Services": 85200},
        2024: {"iPhone": 201183, "Mac": 29984, "iPad": 26694, WEAR: 37005, "Services": 96169},
    }
    sources = {y: f"FY{y} 10-K, net sales by category (Item 7 MD&A)" for y in categories}
    gross_margin = None
    if seg_extra:
        for row in seg_extra.get("categories", []):
            y = row["year"]
            categories[y] = {k: row[k] for k in ("iPhone", "Mac", "iPad", WEAR, "Services")}
            sources[y] = row.get("source", sources.get(y, f"FY{y} 10-K"))
        gm = seg_extra.get("grossMargin")
        if gm:
            gross_margin = {"Products": gm["products"]["2025"], "Services": gm["services"]["2025"]}
    seg_years = []
    for y in sorted(categories):
        segs = categories[y]
        total = sum(segs.values())
        audited = rows.get(y, {}).get("revenue")
        if audited is not None and abs(total - audited) > 1:
            raise SystemExit(f"segment sum mismatch FY{y}: {total} vs audited {audited}")
        seg_years.append({"year": y, "basis": "current 5-category basis",
                          "source": sources[y], "segments": segs, "total": total})
    segments = {
        "_comment": ("Apple reportable product categories (net sales), as filed. "
                     "Category basis is the post-FY2019 definition (ASC 606, "
                     "Wearables regrouping)."),
        "currency": "USD_millions",
        "segmentsCurrent": ["iPhone", "Mac", "iPad", WEAR, "Services"],
        "years": seg_years,
        "note_history": ("Apple has reported category-level net sales since FY2013 "
                         "('iTunes, Software and Services' before FY2015); the "
                         "current five-category basis dates from FY2019."),
        "segmentGrossMargin2025": gross_margin or {},
        "_gm_note": ("Apple discloses gross margin for Products and Services only "
                     "(10-K Item 7); category-level margins are not disclosed."),
    }

    # ---------------- metadata ----------------
    metadata = {
        "_comment": "Curated from the public record; dates verified against filings/press.",
        "company": {"1977-2007": "Apple Computer, Inc.",
                    "2007-present": "Apple Inc. (renamed January 9, 2007)"},
        "leadership": [
            {"name": "Michael Scott", "role": "CEO", "from": 1977, "to": 1981},
            {"name": "Mike Markkula", "role": "CEO", "from": 1981, "to": 1983},
            {"name": "John Sculley", "role": "CEO", "from": 1983, "to": 1993},
            {"name": "Michael Spindler", "role": "CEO", "from": 1993, "to": 1996},
            {"name": "Gil Amelio", "role": "CEO", "from": 1996, "to": 1997},
            {"name": "Steve Jobs", "role": "CEO (interim 1997, titled 2000)", "from": 1997, "to": 2011},
            {"name": "Tim Cook", "role": "CEO", "from": 2011, "to": None},
        ],
        "cfoLeadership": [
            {"name": "Joseph Graziano", "role": "CFO (first tenure)", "from": 1981, "to": 1985},
            {"name": "David Barram", "role": "CFO", "from": 1985, "to": 1987},
            {"name": "Debi Coleman", "role": "CFO", "from": 1987, "to": 1989},
            {"name": "Joseph Graziano", "role": "CFO (second tenure)", "from": 1989, "to": 1995},
            {"name": "Fred Anderson", "role": "CFO", "from": 1996, "to": 2004},
            {"name": "Peter Oppenheimer", "role": "CFO", "from": 2004, "to": 2014},
            {"name": "Luca Maestri", "role": "CFO", "from": 2014, "to": 2024},
            {"name": "Kevan Parekh", "role": "CFO", "from": 2025, "to": None},
        ],
        "_cfo_note": ("CFO tenures curated from the public record (proxy statements, "
                      "contemporaneous reporting). 1977-1980 finance leadership predates "
                      "a formal CFO title and is omitted. Mid-1980s handoff dates "
                      "(Barram/Coleman) are as commonly documented."),
        "eras": [
            {"label": "Apple II era", "from": 1977, "to": 1983},
            {"label": "Macintosh & Sculley", "from": 1984, "to": 1990},
            {"label": "Decline & crisis", "from": 1991, "to": 1996},
            {"label": "Jobs returns: iMac & iPod", "from": 1997, "to": 2006},
            {"label": "iPhone revolution", "from": 2007, "to": 2011},
            {"label": "Cook: services & wearables", "from": 2012, "to": 2019},
            {"label": "Apple Silicon & AI", "from": 2020, "to": 2025},
        ],
        "milestones": [
            {"year": 1977, "event": "Apple II debuts (April) — the machine that builds the company"},
            {"year": 1980, "event": "IPO Dec 12 at $22/share — biggest US offering since Ford in 1956"},
            {"year": 1984, "event": "Macintosh launches Jan 24 with the \"1984\" Super Bowl ad"},
            {"year": 1985, "event": "Jobs resigns Sep 17 after power struggle with Sculley; founds NeXT"},
            {"year": 1987, "event": "First dividend and first stock split (2:1)"},
            {"year": 1997, "event": "Jobs returns via the NeXT deal; Microsoft invests $150M Aug 6"},
            {"year": 1998, "event": "iMac G3 unveiled May 6 — the design-led turnaround"},
            {"year": 2001, "event": "iPod launches Oct 23; first Apple Stores open May 19"},
            {"year": 2003, "event": "iTunes Music Store opens Apr 28 — 1M songs sold in week one"},
            {"year": 2007, "event": "iPhone unveiled Jan 9; renamed Apple Inc. the same day"},
            {"year": 2008, "event": "App Store opens Jul 10 with 500 apps — the app economy begins"},
            {"year": 2010, "event": "iPad ships Apr 3, creating the tablet market"},
            {"year": 2011, "event": "Tim Cook becomes CEO Aug 24; Steve Jobs dies Oct 5"},
            {"year": 2015, "event": "Apple Watch ships Apr 24"},
            {"year": 2018, "event": "First US company worth $1 trillion (Aug 2)"},
            {"year": 2020, "event": "M1 — first Apple Silicon Macs (Nov 10); 4:1 split Aug 31"},
            {"year": 2024, "event": "Vision Pro ships Feb 2; Apple Intelligence unveiled at WWDC"},
        ],
    }

    # ---------------- macro ----------------
    ibm_src = open(IBM_DATAJS).read()
    ibm_json = ibm_src[ibm_src.find("{"):ibm_src.rfind("};") + 1]
    ibm = json.loads(ibm_json)
    im = ibm["macro"]
    REUSE = ["sp500TotalReturn", "treasuryCurve", "treasuryTenorLabels", "bondYieldNote",
             "gdpBillionsUSD", "cpiIndex", "sp500YearEnd", "techYearEnd", "nasdaqYearEnd",
             "recessions", "djiaYearEnd", "gdpGrowthPct", "treasury10yr", "stockSeriesNote"]
    macro = {k: im[k] for k in REUSE if k in im}

    macro["aaplMonthlyPrice"] = {k: v for k, v in ms["monthlyPriceQ"].items()
                                 if k >= "1981-01"}
    macro["aaplTotalReturn"] = ms["totalReturnPct"]
    macro["aaplDividendYield"] = ms["dividendYieldPct"]
    macro["aaplBeta5yr"] = ms["beta5yr"]
    macro["aaplAvgDailyVolume"] = ms["avgDailyVolM"]
    # debt series from the XBRL layer (Apple's bond program starts 2013)
    lt, st, ie, cod = {}, {}, {}, {}
    for fy_s, sr in sec.items():
        y = int(fy_s)
        ltd = (sr.get("longTermDebtNoncurrent") or 0) + (sr.get("longTermDebtCurrent") or 0)
        if sr.get("longTermDebtNoncurrent") is not None and ltd:
            lt[str(y)] = round(ltd, 1)
        if sr.get("commercialPaper"):
            st[str(y)] = sr["commercialPaper"]
        if sr.get("interestExpense") is not None:
            ie[str(y)] = sr["interestExpense"]
    for y in sorted(int(k) for k in ie):
        d0 = (sec.get(str(y - 1), {}).get("totalDebt") or 0)
        d1 = (sec.get(str(y), {}).get("totalDebt") or 0)
        avg = (d0 + d1) / 2
        if avg > 0:
            cod[str(y)] = round(ie[str(y)] / avg * 100, 2)
    macro["aaplLongTermDebt"] = lt
    macro["aaplShortTermDebt"] = st
    macro["aaplInterestExpense"] = ie
    macro["aaplCostOfDebt"] = cod
    # FRED series the dashboard previously had as PENDING — these are what the
    # Fed-funds and unemployment cards were waiting on, plus the corporate-bond
    # curves for the Apple-vs-market cost-of-borrowing comparison.
    if fred:
        for k, v in fred["series"].items():
            macro[k] = v

    macro["sources"] = {
        "aaplMonthlyPrice": "Yahoo Finance AAPL, first-trading-day-of-month close (Jan/Apr/Jul/Oct), split-adjusted",
        "aaplTotalReturn": "Yahoo Finance AAPL adjusted close (dividends + splits), calendar-year change",
        "aaplDividendYield": "Yahoo Finance dividend events / year-end close, split-adjusted basis",
        "aaplBeta5yr": "60-month rolling OLS of AAPL monthly returns vs ^GSPC, Yahoo Finance",
        "aaplAvgDailyVolume": "Yahoo Finance daily volume, calendar-year mean, current split basis",
        "aaplCostOfDebt": "SEC XBRL us-gaap:InterestExpense / average total debt (10-K balance sheets); Apple stopped disclosing interest expense separately after FY2022",
        "aaplDebt": "SEC XBRL: CommercialPaper + LongTermDebtCurrent + LongTermDebtNoncurrent, as reported",
        "macroSeries": "Inherited from the shared macro dataset: FRED (GDPA, CPIAUCSL), Yahoo Finance (^GSPC, ^IXIC, ^DJI, XLK, ^SP500TR, treasury tickers), NBER recession chronology",
        **(fred["sources"] if fred else {}),
    }

    # ---------------- M&A ----------------
    if ma_deals:
        deals = ma_deals["deals"]
        summary = {"total": len(deals),
                   "acquisitions": sum(1 for d in deals if d["type"] == "acquisition"),
                   "divestitures": sum(1 for d in deals if d["type"] == "divestiture"),
                   "withValue": sum(1 for d in deals if d.get("valueMillions") is not None)}
        ma = {"_comment": "Apple deal record from filings + public record; values only where disclosed.",
              "summary": summary, "deals": deals}
    else:
        ma = {"_comment": "RESEARCH PENDING — placeholder empty deal list",
              "summary": {"total": 0, "acquisitions": 0, "divestitures": 0, "withValue": 0},
              "deals": []}
        print("  WARNING: ma_deals.json missing — M&A tab will be empty")

    ma_performance = ma_perf or {"generated": None, "note": "RESEARCH PENDING", "deals": []}

    # ---------------- maBenchmark ----------------
    sptr_ye, xlk_ye = {}, {}
    for k, v in ms["sp500TRMonthly"].items():
        y, m = k.split("-")
        if m == "12":
            sptr_ye[y] = v
    for k, v in ms["xlkMonthlyAdj"].items():
        y, m = k.split("-")
        if m == "12":
            xlk_ye[y] = v
    ma_benchmark = {
        "generated": date.today().isoformat(),
        "xlkAdjYearEnd": xlk_ye,
        "source": "Yahoo Finance XLK monthly adjusted close (dividends reinvested), December value per year; fund inception Dec 1998",
        "note": "Dividend-adjusted era benchmarks for the M&A tab only — separate from macro.techYearEnd / macro.sp500YearEnd (raw closes).",
        "aaplRecentOverride": [],
        "aaplRecentOverrideSource": "not needed — the daily file is current through the last build",
        "sp500TRYearEnd": sptr_ye,
        "sp500TRSource": "Yahoo Finance ^SP500TR monthly close, December value per year (index inception Jan 1988 — covers every Apple M&A era)",
        "sp500TRNote": "Total-return index: dividends reinvested; like-for-like with the dividend-adjusted AAPL daily series.",
    }

    out = {
        "generated": date.today().isoformat(),
        "currency": "USD_millions",
        "source": ("Apple Computer / Apple Inc. annual reports, IPO prospectus (Dec 1980), "
                   "Form 10-K filings (SEC EDGAR, CIK 0000320193) and SEC XBRL company "
                   "facts, fiscal 1977-2025; market data from Yahoo Finance"),
        "financials": financials,
        "segments": segments,
        "metadata": metadata,
        "macro": macro,
        "ma": ma,
        "maPerformance": ma_performance,
        "maBenchmark": ma_benchmark,
        "quarterly": quarterly or {"quarters": []},
        "valuation": valuation or {"peers": []},
    }

    js = ("/* AUTO-GENERATED by pipeline/export_web.py -- do not edit by hand. */\n"
          "window.AAPL_DATA = " + json.dumps(out, indent=1) + ";\n")
    open(os.path.join(ROOT, "data.js"), "w").write(js)
    print(f"wrote data.js: {len(financials)} years {years[0]}–{years[-1]}, "
          f"{len(ma['deals'])} deals, {len(seg_years)} segment years")
    for y in (1977, 1985, 1997, 2007, 2013, 2020, 2025):
        if y in rows:
            r = rows[y]
            print(f"  FY{y}: rev={r['revenue']} ni={r['netIncome']} epsD={r['epsDiluted']} "
                  f"dps={r['dividendsPerShare']} mcap={r['marketCap']} px={r['stockPrice']} "
                  f"emp={r['employees']} svc={r['servicesRevenue']}")

if __name__ == "__main__":
    main()
