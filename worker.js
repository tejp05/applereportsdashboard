const DEFAULT_SYMBOLS = "AAPL,MSFT,GOOGL,AMZN,META,NVDA,QCOM,DELL,HPQ,NFLX";
const SEC_UA = { "User-Agent": "AppleThroughTheYears dashboard (cloudflare worker)" };

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=30",
      ...extraHeaders,
    },
  });
}

function getNumber(value) {
  return typeof value === "number" ? value : Number(value);
}

function fiscalQuarter(end) {
  const y = Number(String(end).slice(0, 4));
  const m = Number(String(end).slice(5, 7));
  if (m >= 10) return { fy: y + 1, fp: "Q1" };
  if (m <= 1) return { fy: y, fp: "Q1" };
  if (m <= 4) return { fy: y, fp: "Q2" };
  if (m <= 7) return { fy: y, fp: "Q3" };
  return { fy: y, fp: "Q4" };
}

async function fetchYahooChart(symbol, params) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`yahoo ${r.status}`);
  const j = await r.json();
  const result = j.chart && j.chart.result && j.chart.result[0];
  if (!result) throw new Error("no chart result");
  return result;
}

async function pricePrev(symbol) {
  const res = await fetchYahooChart(symbol, { interval: "1d", range: "5d" });
  const price = res && res.meta && res.meta.regularMarketPrice;
  const closes = ((res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || []).filter(c => c != null);
  const prev = closes.length >= 2 ? closes[closes.length - 2] : (res && res.meta && (res.meta.chartPreviousClose || res.meta.previousClose));
  const asOf = res && res.meta && res.meta.regularMarketTime;
  return { symbol, price, prevClose: prev, asOf };
}

async function latestFilings() {
  const r = await fetch("https://data.sec.gov/submissions/CIK0000320193.json", {
    headers: SEC_UA,
  });
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
      form,
      filingDate: rec.filingDate[i],
      reportDate: rec.reportDate[i],
      accessionNumber: acc,
      url: `https://www.sec.gov/Archives/edgar/data/320193/${acc.replace(/-/g, "")}/${rec.primaryDocument[i]}`,
    });
  }
  return { companyName: sub.name, filings: out, latest: out[0] || null };
}

async function quarterlyConcept(concept, unit) {
  const r = await fetch(
    `https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/${concept}.json`,
    { headers: SEC_UA }
  );
  if (!r.ok) throw new Error(`edgar ${r.status}`);
  const data = await r.json();
  const q = {};
  const annual = {};
  for (const f of (data.units || {})[unit] || []) {
    if (!f.start || !f.end) continue;
    const days = (new Date(f.end) - new Date(f.start)) / 864e5;
    if (days > 60 && days < 100) {
      const k = fiscalQuarter(f.end);
      q[`${k.fy}${k.fp}`] = { ...k, end: f.end, val: Number(f.val) };
    } else if (days > 330 && days < 400) {
      const k = fiscalQuarter(f.end);
      annual[k.fy] = { fy: k.fy, end: f.end, val: Number(f.val) };
    }
  }
  if (unit === "USD") {
    for (const a of Object.values(annual)) {
      const qs = ["Q1", "Q2", "Q3"].map(p => q[`${a.fy}${p}`]);
      if (qs.every(Boolean) && !q[`${a.fy}Q4`]) {
        q[`${a.fy}Q4`] = {
          fy: a.fy,
          fp: "Q4",
          end: a.end,
          val: a.val - qs.reduce((sum, x) => sum + x.val, 0),
        };
      }
    }
  }
  return q;
}

async function latestXbrl() {
  const [rev, ni, eps] = await Promise.all([
    quarterlyConcept("RevenueFromContractWithCustomerExcludingAssessedTax", "USD"),
    quarterlyConcept("NetIncomeLoss", "USD"),
    quarterlyConcept("EarningsPerShareDiluted", "USD/shares"),
  ]);
  let rows = Object.values(rev)
    .sort((a, b) => (a.end < b.end ? -1 : 1))
    .slice(-5)
    .map(r => ({
      fy: r.fy,
      fp: r.fp,
      end: r.end,
      revenue: r.val,
      netIncome: (ni[`${r.fy}${r.fp}`] || {}).val ?? null,
      epsDiluted: (eps[`${r.fy}${r.fp}`] || {}).val ?? null,
    }));
  const last = rows[rows.length - 1];
  const prevKey = last ? `${last.fy - 1}${last.fp}` : null;
  const prevAnnual = last && rev[prevKey];
  if (prevAnnual && !rows.some(r => r.fy === last.fy - 1 && r.fp === last.fp)) {
    rows.unshift({
      fy: prevAnnual.fy,
      fp: prevAnnual.fp,
      end: prevAnnual.end,
      revenue: prevAnnual.val,
      netIncome: (ni[prevKey] || {}).val ?? null,
      epsDiluted: (eps[prevKey] || {}).val ?? null,
    });
  }
  return {
    recentQuarters: rows,
    latestQuarter: rows[rows.length - 1] || null,
    synthetic: true,
  };
}


/* ---- POST /chat — OpenAI broker -------------------------------------------
   The browser owns the tool loop (the tools drive the DOM), so this endpoint
   is deliberately stateless: it forwards {messages, tools} to OpenAI and
   returns the assistant message verbatim. The API key stays here — it is a
   Worker secret and is never sent to the browser.                          */
async function handleChat(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  const key = env.OPENAI_API_KEY;
  if (!key) {
    return jsonResponse({ error: "OPENAI_API_KEY is not set on this Worker. Add it under " +
      "Settings -> Variables and Secrets (type: Secret), then redeploy." }, 503);
  }
  let body;
  try { body = await request.json(); } catch (_) { return jsonResponse({ error: "invalid JSON" }, 400); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : null;
  if (!messages || !messages.length) return jsonResponse({ error: "messages[] required" }, 400);

  const payload = {
    model: env.OPENAI_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.2,
  };
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools;
    payload.tool_choice = "auto";
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text();
    return jsonResponse({ error: `OpenAI ${r.status}`, detail: detail.slice(0, 400) }, 502);
  }
  const data = await r.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;
  if (!message) return jsonResponse({ error: "no message in OpenAI response" }, 502);
  return jsonResponse({ message, usage: data.usage || null }, 200, { "cache-control": "no-store" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/quote") {
        const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase().replace(/[^A-Z0-9^.\-]/g, "");
        const q = await pricePrev(symbol);
        if (!q.price) return jsonResponse({ error: "no price" }, 502);
        const asOf = q.asOf ? new Date(q.asOf * 1000).toISOString().slice(0, 10) : "today";
        return jsonResponse({ symbol, price: q.price, prevClose: q.prevClose, asOf });
      }

      if (url.pathname === "/quotes") {
        const raw = url.searchParams.get("symbols") || DEFAULT_SYMBOLS;
        const symbols = raw.split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9^\.\-]{1,10}$/.test(s)).slice(0, 16);
        const quotes = [];
        for (const symbol of symbols) {
          try {
            const q = await pricePrev(symbol);
            if (q.price && q.prevClose != null) {
              quotes.push({ symbol, price: q.price, changePct: (q.price - q.prevClose) / q.prevClose * 100 });
            }
          } catch (_) {}
        }
        return jsonResponse({ quotes }, quotes.length ? 200 : 502);
      }

      if (url.pathname === "/quote/intraday") {
        const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase().replace(/[^A-Z0-9^.\-]/g, "");
        const res = await fetchYahooChart(symbol, { interval: "5m", range: "1d" });
        const closes = ((res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || []).filter(c => c != null);
        if (closes.length < 2) return jsonResponse({ error: "no bars" }, 502);
        return jsonResponse({
          points: closes.map(price => ({ price })),
          prevClose: res.meta && (res.meta.chartPreviousClose || res.meta.previousClose),
        });
      }

      if (url.pathname === "/quote/history") {
        const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase().replace(/[^A-Z0-9^.\-]/g, "");
        const range = ["5d", "1mo", "3mo", "6mo", "1y"].includes(url.searchParams.get("range") || "1mo") ? url.searchParams.get("range") : "1mo";
        const res = await fetchYahooChart(symbol, { interval: "1d", range, includeAdjustedClose: "true" });
        const timestamps = res.timestamp || [];
        const adj = (res.indicators && res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose) || [];
        const points = timestamps.map((ts, idx) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          close: adj[idx] != null ? Math.round(adj[idx] * 100) / 100 : null,
        })).filter(p => p.close != null);
        return jsonResponse({ symbol, range, points: points.slice(-90) });
      }

      if (url.pathname === "/chat") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/filings/latest") {
        return jsonResponse(await latestFilings());
      }

      if (url.pathname === "/filings/xbrl") {
        return jsonResponse(await latestXbrl());
      }
    } catch (error) {
      return jsonResponse({ error: String(error) }, 502);
    }

    return env.ASSETS.fetch(request);
  },
};
