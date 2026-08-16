/* Cloudflare Pages Function: GET /quotes[?symbols=AAPL,MSFT,...]
   Batch quote proxy for the ticker strip and live-pill rows.
   Response shape: { quotes: [{ symbol, price, changePct }] }. */
const DEFAULT_SYMBOLS = "AAPL,MSFT,GOOGL,AMZN,META,NVDA,QCOM,DELL,HPQ,NFLX";

async function one(symbol) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 45, cacheEverything: true } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    const price = res && res.meta && res.meta.regularMarketPrice;
    const closes = ((res && res.indicators && res.indicators.quote &&
      res.indicators.quote[0] && res.indicators.quote[0].close) || []).filter(c => c != null);
    const prev = closes.length >= 2 ? closes[closes.length - 2]
      : res && res.meta && (res.meta.chartPreviousClose || res.meta.previousClose);
    if (!price || !prev) return null;
    return { symbol, price, changePct: (price - prev) / prev * 100 };
  } catch (_) { return null; }
}

export async function onRequest({ request }) {
  const raw = new URL(request.url).searchParams.get("symbols") || DEFAULT_SYMBOLS;
  const symbols = raw.split(",").map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z0-9^.\-]{1,10}$/.test(s)).slice(0, 16);
  const quotes = (await Promise.all(symbols.map(one))).filter(Boolean);
  return new Response(JSON.stringify({ quotes }), {
    status: quotes.length ? 200 : 502,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=45" },
  });
}
