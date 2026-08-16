/* Cloudflare Pages Function: GET /quote/intraday?symbol=AAPL
   5-minute bars for today's sparkline.
   Response shape: { points: [{ price }], prevClose }. */
export async function onRequest({ request }) {
  const symbol = (new URL(request.url).searchParams.get("symbol") || "AAPL")
    .toUpperCase().replace(/[^A-Z0-9^.\-]/g, "");
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 60, cacheEverything: true } });
    if (!r.ok) throw new Error(`yahoo ${r.status}`);
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    const closes = ((res && res.indicators && res.indicators.quote &&
      res.indicators.quote[0] && res.indicators.quote[0].close) || []).filter(c => c != null);
    const prevClose = res && res.meta && (res.meta.chartPreviousClose || res.meta.previousClose);
    if (closes.length < 2) throw new Error("no bars");
    return new Response(JSON.stringify({ points: closes.map(price => ({ price })), prevClose }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}
