/* Cloudflare Pages Function: GET /quote?symbol=AAPL
   Server-side proxy for Yahoo Finance's chart API (which blocks browser CORS).
   Response shape matches what app.js loadLiveQuote expects from the agent
   tier: { price, prevClose, asOf }. Cached at the edge for 30s. */
export async function onRequest({ request }) {
  const symbol = (new URL(request.url).searchParams.get("symbol") || "AAPL")
    .toUpperCase().replace(/[^A-Z0-9^.\-]/g, "");
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 30, cacheEverything: true } });
    if (!r.ok) throw new Error(`yahoo ${r.status}`);
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    const price = res && res.meta && res.meta.regularMarketPrice;
    const closes = ((res && res.indicators && res.indicators.quote &&
      res.indicators.quote[0] && res.indicators.quote[0].close) || []).filter(c => c != null);
    const prevClose = closes.length >= 2 ? closes[closes.length - 2]
      : res && res.meta && (res.meta.chartPreviousClose || res.meta.previousClose);
    if (!price) throw new Error("no price");
    const asOf = res.meta.regularMarketTime
      ? new Date(res.meta.regularMarketTime * 1000).toISOString().slice(0, 10) : "today";
    return new Response(JSON.stringify({ symbol, price, prevClose, asOf }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}
