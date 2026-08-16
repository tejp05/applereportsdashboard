"""Local dev server: static files + the same live-quote proxy endpoints that
Cloudflare Pages Functions provide in production (functions/*.js).

Yahoo Finance blocks browser CORS, so the page can't call it directly — these
tiny server-side proxies are what make the live quote, ticker, sparkline and
Story Mode's live extension light up. SEC EDGAR is CORS-open and needs no
proxy. Stdlib only; no dependencies.
"""
import json
import os
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/"
DEFAULT_SYMBOLS = "AAPL,MSFT,GOOGL,AMZN,META,NVDA,QCOM,DELL,HPQ,NFLX"


def yahoo_chart(symbol, params):
    url = YAHOO + urllib.parse.quote(symbol) + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)["chart"]["result"][0]


def price_prev(symbol):
    res = yahoo_chart(symbol, {"interval": "1d", "range": "5d"})
    price = res["meta"].get("regularMarketPrice")
    closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
    prev = closes[-2] if len(closes) >= 2 else res["meta"].get("chartPreviousClose")
    as_of = res["meta"].get("regularMarketTime")
    return price, prev, as_of



SEC_UA = {"User-Agent": "AppleThroughTheYears dashboard (contact: dev@localhost)"}


def sec_json(url):
    req = urllib.request.Request(url, headers=SEC_UA)
    with urllib.request.urlopen(req, timeout=9) as r:
        return json.load(r)


def apple_fq(end):
    y, m = int(end[:4]), int(end[5:7])
    if m >= 10: return y + 1, "Q1"
    if m <= 1:  return y, "Q1"
    if m <= 4:  return y, "Q2"
    if m <= 7:  return y, "Q3"
    return y, "Q4"


def sec_quarterly(concept, unit):
    data = sec_json("https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/%s.json" % concept)
    q, annual = {}, {}
    from datetime import date as _d
    for f in data.get("units", {}).get(unit, []):
        s_, e_ = f.get("start"), f.get("end")
        if not s_ or not e_:
            continue
        days = (_d(*map(int, e_.split("-"))) - _d(*map(int, s_.split("-")))).days
        if 60 < days < 100:
            fy, fp = apple_fq(e_)
            q[(fy, fp)] = {"fy": fy, "fp": fp, "end": e_, "val": f["val"]}
        elif 330 < days < 400:
            fy, _ = apple_fq(e_)
            annual[fy] = {"fy": fy, "end": e_, "val": f["val"]}
    if unit == "USD":
        for a in annual.values():
            qs = [q.get((a["fy"], p)) for p in ("Q1", "Q2", "Q3")]
            if all(qs) and (a["fy"], "Q4") not in q:
                q[(a["fy"], "Q4")] = {"fy": a["fy"], "fp": "Q4", "end": a["end"],
                                      "val": a["val"] - sum(x["val"] for x in qs)}
    return q


def filings_latest():
    sub = sec_json("https://data.sec.gov/submissions/CIK0000320193.json")
    rec = sub["filings"]["recent"]
    out = []
    for i in range(len(rec["form"])):
        if len(out) >= 8:
            break
        form = rec["form"][i]
        if form not in ("10-K", "10-Q", "8-K"):
            continue
        items = (rec.get("items") or [""] * len(rec["form"]))[i] or ""
        if form == "8-K" and "2.02" not in items:
            continue
        acc = rec["accessionNumber"][i]
        out.append({"form": form, "filingDate": rec["filingDate"][i],
                    "reportDate": rec["reportDate"][i], "accessionNumber": acc,
                    "url": "https://www.sec.gov/Archives/edgar/data/320193/%s/%s"
                           % (acc.replace("-", ""), rec["primaryDocument"][i])})
    return {"companyName": sub["name"], "filings": out, "latest": out[0] if out else None}


def filings_xbrl():
    rev = sec_quarterly("RevenueFromContractWithCustomerExcludingAssessedTax", "USD")
    ni = sec_quarterly("NetIncomeLoss", "USD")
    eps = sec_quarterly("EarningsPerShareDiluted", "USD/shares")
    rows = sorted(rev.values(), key=lambda r: r["end"])[-5:]
    rows = [{"fy": r["fy"], "fp": r["fp"], "end": r["end"], "revenue": r["val"],
             "netIncome": (ni.get((r["fy"], r["fp"])) or {}).get("val"),
             "epsDiluted": (eps.get((r["fy"], r["fp"])) or {}).get("val")} for r in rows]
    if rows:
        last = rows[-1]
        ya = rev.get((last["fy"] - 1, last["fp"]))
        if ya and not any(r["fy"] == last["fy"] - 1 and r["fp"] == last["fp"] for r in rows):
            rows.insert(0, {"fy": ya["fy"], "fp": ya["fp"], "end": ya["end"], "revenue": ya["val"],
                            "netIncome": (ni.get((ya["fy"], ya["fp"])) or {}).get("val"),
                            "epsDiluted": (eps.get((ya["fy"], ya["fp"])) or {}).get("val")})
    return {"recentQuarters": rows, "latestQuarter": rows[-1] if rows else None,
            "synthetic": True}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        symbol = (qs.get("symbol", ["AAPL"])[0]).upper()
        try:
            if parsed.path == "/filings/latest":
                return self.send_json(filings_latest())
            if parsed.path == "/filings/xbrl":
                return self.send_json(filings_xbrl())
            if parsed.path == "/quote":
                price, prev, as_of = price_prev(symbol)
                if not price:
                    return self.send_json({"error": "no price"}, 502)
                label = (datetime.fromtimestamp(as_of, tz=timezone.utc).date().isoformat()
                         if as_of else "today")
                return self.send_json({"symbol": symbol, "price": price,
                                       "prevClose": prev, "asOf": label})
            if parsed.path == "/quotes":
                symbols = [s.strip().upper() for s in
                           qs.get("symbols", [DEFAULT_SYMBOLS])[0].split(",")][:16]
                def one(sym):
                    try:
                        price, prev, _ = price_prev(sym)
                        if price and prev:
                            return {"symbol": sym, "price": price,
                                    "changePct": (price - prev) / prev * 100}
                    except Exception:
                        return None
                with ThreadPoolExecutor(max_workers=8) as ex:
                    quotes = [q for q in ex.map(one, symbols) if q]
                return self.send_json({"quotes": quotes}, 200 if quotes else 502)
            if parsed.path == "/quote/intraday":
                res = yahoo_chart(symbol, {"interval": "5m", "range": "1d"})
                closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
                if len(closes) < 2:
                    return self.send_json({"error": "no bars"}, 502)
                return self.send_json({"points": [{"price": c} for c in closes],
                                       "prevClose": res["meta"].get("chartPreviousClose")})
            if parsed.path == "/quote/history":
                rng = qs.get("range", ["1mo"])[0]
                if rng not in ("5d", "1mo", "3mo", "6mo", "1y"):
                    rng = "1mo"
                res = yahoo_chart(symbol, {"interval": "1d", "range": rng,
                                           "includeAdjustedClose": "true"})
                ts = res.get("timestamp") or []
                adj = res["indicators"].get("adjclose", [{}])[0].get("adjclose") or []
                points = [{"date": datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat(),
                           "close": round(a, 2)}
                          for t, a in zip(ts, adj) if a is not None]
                if not points:
                    return self.send_json({"error": "no points"}, 502)
                return self.send_json({"points": points})
        except Exception as e:  # proxy failure — the page degrades gracefully
            return self.send_json({"error": str(e)}, 502)
        return super().do_GET()


port = int(os.environ.get("PORT", 5500))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f"Serving Apple dashboard at http://localhost:{port}  (Ctrl+C to stop)")
print("Live-quote proxy endpoints: /quote /quotes /quote/intraday /quote/history")
ThreadingHTTPServer(("", port), Handler).serve_forever()
