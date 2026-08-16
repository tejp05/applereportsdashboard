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
