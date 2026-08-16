#!/usr/bin/env python3
"""Extract as-reported annual figures for Apple Inc. from SEC XBRL companyfacts.

Source: pipeline/data/sec_companyfacts_aapl.json
        (https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json)

Output: pipeline/data/sec_annual.json — one object per fiscal year (2008+),
        US$ millions for money, matching the dashboard's financials schema.

Selection rule (mirrors the IBM pipeline's "as originally reported" rule):
for each concept and fiscal year, prefer the value filed in that fiscal
year's OWN 10-K (fp == "FY", form == "10-K", frame year == fiscal year);
later restatements are ignored. Values never estimated — a year/metric with
no XBRL fact stays absent (pre-2008 years are filled by the research layer
from the printed 10-K/annual-report tables, recorded in provenance.json).
"""
import json
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "data", "sec_companyfacts_aapl.json")
OUT = os.path.join(HERE, "data", "sec_annual.json")

MILLIONS = 1e6

# dashboard field -> (taxonomy, [concept fallbacks in priority order], scale)
CONCEPTS = {
    "revenue": ("us-gaap", [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "SalesRevenueNet",
        "Revenues",
    ], MILLIONS),
    "netIncome": ("us-gaap", ["NetIncomeLoss"], MILLIONS),
    "epsBasic": ("us-gaap", ["EarningsPerShareBasic"], 1),
    "epsDiluted": ("us-gaap", ["EarningsPerShareDiluted"], 1),
    "dividendsPerShare": ("us-gaap", [
        "CommonStockDividendsPerShareDeclared",
        "CommonStockDividendsPerShareCashPaid",
    ], 1),
    "totalAssets": ("us-gaap", ["Assets"], MILLIONS),
    "stockholdersEquity": ("us-gaap", ["StockholdersEquity"], MILLIONS),
    "rdExpense": ("us-gaap", ["ResearchAndDevelopmentExpense"], MILLIONS),
    "pretaxIncome": ("us-gaap", [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ], MILLIONS),
    "incomeTaxes": ("us-gaap", ["IncomeTaxExpenseBenefit"], MILLIONS),
    "operatingCashFlow": ("us-gaap", [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ], MILLIONS),
    "capitalExpenditure": ("us-gaap", [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ], MILLIONS),
    "sharesOutstandingM": ("us-gaap", [
        "WeightedAverageNumberOfDilutedSharesOutstanding",
    ], MILLIONS),
    "interestExpense": ("us-gaap", ["InterestExpense", "InterestExpenseNonoperating"], MILLIONS),
    "commercialPaper": ("us-gaap", ["CommercialPaper"], MILLIONS),
    "longTermDebtCurrent": ("us-gaap", ["LongTermDebtCurrent"], MILLIONS),
    "longTermDebtNoncurrent": ("us-gaap", ["LongTermDebtNoncurrent", "LongTermDebt"], MILLIONS),
    "coverSharesOutstanding": ("dei", ["EntityCommonStockSharesOutstanding"], MILLIONS),
    "periodEndShares": ("us-gaap", ["CommonStockSharesOutstanding"], MILLIONS),
}

DURATION_FIELDS = {
    "revenue", "netIncome", "epsBasic", "epsDiluted", "dividendsPerShare",
    "rdExpense", "pretaxIncome", "incomeTaxes", "operatingCashFlow",
    "capitalExpenditure", "sharesOutstandingM", "interestExpense",
}


def pick_annual(facts, duration):
    """fiscal year -> value, preferring the year's own 10-K filing."""
    by_year = {}
    candidates = defaultdict(list)
    for f in facts:
        if f.get("form") != "10-K":
            continue
        end = f.get("end", "")
        if not end:
            continue
        if duration:
            start = f.get("start", "")
            if not start:
                continue
            # annual periods only (Apple FY is 52/53 weeks)
            from datetime import date
            d0 = date(*map(int, start.split("-")))
            d1 = date(*map(int, end.split("-")))
            if not 330 <= (d1 - d0).days <= 400:
                continue
        # Apple's fiscal year N ends late September of calendar year N
        fy = int(end[:4]) if int(end[5:7]) >= 6 else int(end[:4]) - 1
        candidates[fy].append(f)
    for fy, fl in candidates.items():
        # original figure = the one filed in that FY's own 10-K (fy label matches);
        # fall back to the earliest filing that states the period
        own = [f for f in fl if f.get("fy") == fy and f.get("fp") == "FY"]
        pool = own or sorted(fl, key=lambda f: f.get("filed", "9999-99-99"))
        by_year[fy] = pool[0]["val"]
    return by_year


def main():
    src = json.load(open(SRC))
    assert src["entityName"].lower().startswith("apple"), src["entityName"]
    facts = src["facts"]
    out = defaultdict(dict)
    for field, (taxo, names, scale) in CONCEPTS.items():
        merged = {}
        for name in names:  # priority order: earlier wins
            node = facts.get(taxo, {}).get(name)
            if not node:
                continue
            unit_facts = next(iter(node["units"].values()))
            annual = pick_annual(unit_facts, field in DURATION_FIELDS)
            for fy, val in annual.items():
                merged.setdefault(fy, val)
        for fy, val in merged.items():
            v = val / scale if scale != 1 else val
            out[fy][field] = round(v, 4) if scale == 1 else round(v, 1)

    # totalDebt = commercial paper + current LTD + noncurrent LTD (as reported)
    for fy, row in out.items():
        parts = [row.get("commercialPaper"), row.get("longTermDebtCurrent"),
                 row.get("longTermDebtNoncurrent")]
        present = [p for p in parts if p is not None]
        if present and row.get("longTermDebtNoncurrent") is not None:
            row["totalDebt"] = round(sum(present), 1)

    result = {str(fy): out[fy] for fy in sorted(out)}
    json.dump(result, open(OUT, "w"), indent=1)
    print(f"wrote {OUT}: FY{min(out)}–FY{max(out)}")
    for fy in sorted(out):
        r = out[fy]
        print(fy, "rev:", r.get("revenue"), "ni:", r.get("netIncome"),
              "epsD:", r.get("epsDiluted"), "dps:", r.get("dividendsPerShare"),
              "assets:", r.get("totalAssets"), "eq:", r.get("stockholdersEquity"),
              "rd:", r.get("rdExpense"), "ocf:", r.get("operatingCashFlow"),
              "capex:", r.get("capitalExpenditure"), "debt:", r.get("totalDebt"))


if __name__ == "__main__":
    main()
