/* Cloudflare Pages Function: GET /filings/xbrl
   Latest quarterly figures synthesized from SEC XBRL companyconcept facts
   (that API is not CORS-open, so the browser can't do this itself).
   Shape: { recentQuarters: [{fy, fp, end, revenue, netIncome, epsDiluted}],
            latestQuarter, synthetic: true }. Q4 = FY total − Q1..Q3. */
const UA = { "User-Agent": "AppleThroughTheYears dashboard (github pages function)" };

// Apple fiscal quarter from a period-end date (FY ends late September)
function fq(end) {
  const y = +end.slice(0, 4), m = +end.slice(5, 7);
  if (m >= 10) return { fy: y + 1, fp: "Q1" };
  if (m <= 1) return { fy: y, fp: "Q1" };
  if (m <= 4) return { fy: y, fp: "Q2" };
  if (m <= 7) return { fy: y, fp: "Q3" };
  return { fy: y, fp: "Q4" };
}

async function quarterly(concept, unit) {
  const r = await fetch(
    `https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/${concept}.json`,
    { headers: UA, cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error(`edgar ${r.status}`);
  const data = await r.json();
  const q = {}, annual = {};
  for (const f of (data.units || {})[unit] || []) {
    if (!f.start || !f.end) continue;
    const days = (new Date(f.end) - new Date(f.start)) / 864e5;
    if (days > 60 && days < 100) {
      const k = fq(f.end);
      q[k.fy + k.fp] = { ...k, end: f.end, val: f.val };
    } else if (days > 330 && days < 400) {
      const k = fq(f.end);
      annual[k.fy] = { fy: k.fy, end: f.end, val: f.val };
    }
  }
  if (unit === "USD") {
    for (const a of Object.values(annual)) {
      const qs = ["Q1", "Q2", "Q3"].map(p => q[a.fy + p]);
      if (qs.every(Boolean) && !q[a.fy + "Q4"])
        q[a.fy + "Q4"] = { fy: a.fy, fp: "Q4", end: a.end,
                           val: a.val - qs.reduce((t, x) => t + x.val, 0) };
    }
  }
  return q;
}

export async function onRequest() {
  try {
    const [rev, ni, eps] = await Promise.all([
      quarterly("RevenueFromContractWithCustomerExcludingAssessedTax", "USD"),
      quarterly("NetIncomeLoss", "USD"),
      quarterly("EarningsPerShareDiluted", "USD/shares"),
    ]);
    let rows = Object.values(rev).sort((a, b) => (a.end < b.end ? -1 : 1)).slice(-5)
      .map(r => ({ fy: r.fy, fp: r.fp, end: r.end, revenue: r.val,
                   netIncome: (ni[r.fy + r.fp] || {}).val ?? null,
                   epsDiluted: (eps[r.fy + r.fp] || {}).val ?? null }));
    const last = rows[rows.length - 1];
    const ya = last && rev[(last.fy - 1) + last.fp];
    if (ya && !rows.some(r => r.fy === last.fy - 1 && r.fp === last.fp))
      rows.unshift({ fy: ya.fy, fp: ya.fp, end: ya.end, revenue: ya.val,
                     netIncome: (ni[(last.fy - 1) + last.fp] || {}).val ?? null,
                     epsDiluted: (eps[(last.fy - 1) + last.fp] || {}).val ?? null });
    return new Response(JSON.stringify({ recentQuarters: rows,
      latestQuarter: rows[rows.length - 1] || null, synthetic: true }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}
