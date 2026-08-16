/* Cloudflare Pages Function: GET /quote/history?symbol=AAPL&range=1mo
   Daily adjusted closes used by Story Mode to extend the baked price series
   past the last build. Response shape: { points: [{ date, close }] }. */
const RANGES = new Set(["5d", "1mo", "3mo", "6mo", "1y"]);

export async function onRequest({ request }) {
  const u = new URL(request.url);
  const symbol = (u.searchParams.get("symbol") || "AAPL")
    .toUpperCase().replace(/[^A-Z0-9^.\-]/g, "");
  const range = RANGES.has(u.searchParams.get("range")) ? u.searchParams.get("range") : "1mo";
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}&includeAdjustedClose=true`,
      { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) throw new Error(`yahoo ${r.status}`);
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    const ts = (res && res.timestamp) || [];
    const adj = (res && res.indicators && res.indicators.adjclose &&
      res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || [];
    const points = ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: adj[i] != null ? Math.round(adj[i] * 100) / 100 : null,
    })).filter(p => p.close != null);
    if (!points.length) throw new Error("no points");
    return new Response(JSON.stringify({ points }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}
