/* Cloudflare Pages Function: GET /filings/latest
   Latest Apple 10-K / 10-Q / earnings 8-K filings from SEC EDGAR.
   Shape: { companyName, filings: [...], latest }. */
const UA = { "User-Agent": "AppleThroughTheYears dashboard (github pages function)" };

export async function onRequest() {
  try {
    const r = await fetch("https://data.sec.gov/submissions/CIK0000320193.json",
      { headers: UA, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) throw new Error(`edgar ${r.status}`);
    const sub = await r.json();
    const rec = sub.filings.recent;
    const out = [];
    for (let i = 0; i < rec.form.length && out.length < 8; i++) {
      const form = rec.form[i];
      if (!["10-K", "10-Q", "8-K"].includes(form)) continue;
      const items = (rec.items && rec.items[i]) || "";
      if (form === "8-K" && !items.includes("2.02")) continue;
      const acc = rec.accessionNumber[i];
      out.push({
        form, filingDate: rec.filingDate[i], reportDate: rec.reportDate[i],
        accessionNumber: acc,
        url: `https://www.sec.gov/Archives/edgar/data/320193/${acc.replace(/-/g, "")}/${rec.primaryDocument[i]}`,
      });
    }
    return new Response(JSON.stringify({ companyName: sub.name, filings: out, latest: out[0] || null }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}
