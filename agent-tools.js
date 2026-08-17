/* ============================================================================
   agent-tools.js — window.APPLE_AGENT: an agent tool layer over the whole dashboard.

   Two halves:
   1. TOOLS — data tools (read window.AAPL_DATA) and page ACTIONS (switch tabs,
      configure the Regression Lab, open M&A era drawers). Any agent that can
      execute JavaScript — CUGA's browser mode, an Orchestrate custom
      extension, or the devtools console — calls:
          await window.APPLE_AGENT.invoke("get_cagr", {metric:"revenue", from_year:2020, to_year:2025})
      Discovery: window.APPLE_AGENT.manifest()  (JSON-schema per tool).
   2. CHAT PANEL — a small "Ask the data" panel (bottom-left) that talks to the
      Python CUGA agent server (agent/server.py, default http://localhost:8787).
      Fully optional: when the server is down the panel says so; the site is
      unaffected. Override the endpoint via window.LIVE_AGENT_URL.
   ========================================================================== */
(function () {
"use strict";

const D = window.AAPL_DATA;
if (!D) return;

const FIN = D.financials;
const byYear = new Map(FIN.map(r => [r.year, r]));

const METRIC_UNITS = {
  revenue: "$M", netIncome: "$M", pretaxIncome: "$M", incomeTaxes: "$M",
  freeCashFlow: "$M", operatingCashFlow: "$M", capitalExpenditure: "$M",
  rdExpense: "$M", totalAssets: "$M", stockholdersEquity: "$M", totalDebt: "$M",
  marketCap: "$M", servicesRevenue: "$M", epsDiluted: "$", epsBasic: "$",
  dividendsPerShare: "$", stockPrice: "$", employees: "count",
};

const series = m => FIN.filter(r => r[m] != null).map(r => [r.year, r[m]]);
const inRange = (pairs, a, b) => pairs.filter(([y]) => y >= a && y <= b);
const badMetric = m => { throw new Error(`unknown metric '${m}' — call list_metrics`); };
const ck = m => { if (!(m in METRIC_UNITS)) badMetric(m); };

function ols(xs, ys) {
  const n = xs.length;
  const xm = xs.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i]-xm, dy = ys[i]-ym; sxx += dx*dx; sxy += dx*dy; syy += dy*dy; }
  if (sxx === 0 || syy === 0) return null;
  const slope = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
  return { slope, intercept: ym - slope * xm, r, r2: r * r, n };
}

/* ── Tool registry ─────────────────────────────────────────────────────────
   Each tool: { desc, params: {name: {type, desc, required?}}, fn(args) }   */
const TOOLS = {

  /* ---- data tools ---- */
  list_metrics: {
    desc: "Every metric key with unit and year coverage. Call first.",
    params: {},
    fn: () => Object.entries(METRIC_UNITS).map(([m, unit]) => {
      const s = series(m);
      return { metric: m, unit, from: s[0]?.[0] ?? null, to: s.at(-1)?.[0] ?? null, n: s.length };
    }),
  },

  get_financials_year: {
    desc: "Full financial record for one fiscal year (1977–2025).",
    params: { year: { type: "integer", desc: "fiscal year", required: true } },
    fn: ({ year }) => {
      const r = byYear.get(+year);
      if (!r) throw new Error(`no data for ${year} (coverage 1977–2025)`);
      return r;
    },
  },

  get_metric_series: {
    desc: "Year-by-year values of one metric over a range.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      from_year: { type: "integer", desc: "default 1977" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ metric, from_year = 1977, to_year = 2025 }) => {
      ck(metric);
      return inRange(series(metric), from_year, to_year)
        .map(([year, value]) => ({ year, value }));
    },
  },

  get_metric_stats: {
    desc: "n / min / max / mean / latest / CAGR for a metric over a range.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      from_year: { type: "integer", desc: "default 1977" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ metric, from_year = 1977, to_year = 2025 }) => {
      ck(metric);
      const s = inRange(series(metric), from_year, to_year);
      if (!s.length) throw new Error("no data in range");
      const vs = s.map(p => p[1]);
      const min = s.reduce((a, b) => (b[1] < a[1] ? b : a));
      const max = s.reduce((a, b) => (b[1] > a[1] ? b : a));
      const yrs = s.at(-1)[0] - s[0][0];
      const cagr = (s[0][1] > 0 && s.at(-1)[1] > 0 && yrs > 0)
        ? +(((s.at(-1)[1] / s[0][1]) ** (1 / yrs) - 1) * 100).toFixed(2) : null;
      return {
        metric, unit: METRIC_UNITS[metric], n: s.length,
        first: { year: s[0][0], value: s[0][1] }, latest: { year: s.at(-1)[0], value: s.at(-1)[1] },
        min: { year: min[0], value: min[1] }, max: { year: max[0], value: max[1] },
        mean: +(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(2),
        cagrPct: cagr,
      };
    },
  },

  get_cagr: {
    desc: "Compound annual growth rate of a metric between two years.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      from_year: { type: "integer", desc: "start year", required: true },
      to_year: { type: "integer", desc: "end year", required: true },
    },
    fn: ({ metric, from_year, to_year }) => {
      ck(metric);
      const a = byYear.get(+from_year)?.[metric], b = byYear.get(+to_year)?.[metric];
      if (a == null || b == null) throw new Error("metric missing for one of those years");
      if (a <= 0) throw new Error("CAGR undefined off a non-positive base");
      return { metric, from_year, to_year,
        cagrPct: +(((b / a) ** (1 / (to_year - from_year)) - 1) * 100).toFixed(2),
        startValue: a, endValue: b };
    },
  },

  compare_years: {
    desc: "Two fiscal years side-by-side across all covered metrics with % change.",
    params: {
      year_a: { type: "integer", desc: "first year", required: true },
      year_b: { type: "integer", desc: "second year", required: true },
    },
    fn: ({ year_a, year_b }) => {
      const ra = byYear.get(+year_a), rb = byYear.get(+year_b);
      if (!ra || !rb) throw new Error("years outside 1977–2025");
      return Object.keys(METRIC_UNITS)
        .filter(m => ra[m] != null || rb[m] != null)
        .map(m => ({ metric: m, [year_a]: ra[m], [year_b]: rb[m],
          changePct: (ra[m] && rb[m] != null) ? +(((rb[m] - ra[m]) / Math.abs(ra[m])) * 100).toFixed(1) : null }));
    },
  },

  get_top_years: {
    desc: "Best or worst n years for a metric.",
    params: {
      metric: { type: "string", desc: "key from list_metrics", required: true },
      n: { type: "integer", desc: "default 5" },
      order: { type: "string", desc: "'best' | 'worst' (default best)" },
    },
    fn: ({ metric, n = 5, order = "best" }) => {
      ck(metric);
      return series(metric)
        .sort((a, b) => order === "worst" ? a[1] - b[1] : b[1] - a[1])
        .slice(0, n).map(([year, value]) => ({ year, value }));
    },
  },

  get_segments: {
    desc: "Segment revenue (2021–2025) for one year, plus FY2025 gross margins.",
    params: { year: { type: "integer", desc: "2021–2025, default 2025" } },
    fn: ({ year = 2025 } = {}) => {
      const row = (D.segments.years || []).find(s => s.year === +year);
      if (!row) throw new Error("segment revenue exists 2021–2025 only");
      return { year: +year, segments: row.segments,
               grossMargin2025: D.segments.segmentGrossMargin2025 || null };
    },
  },

  get_fcf_history: {
    desc: "Free cash flow by year with per-year sourcing notes (stated vs derived).",
    params: {
      from_year: { type: "integer", desc: "default 1995" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ from_year = 1995, to_year = 2025 } = {}) =>
      FIN.filter(r => r.freeCashFlow != null && r.year >= from_year && r.year <= to_year)
        .map(r => ({ year: r.year, freeCashFlow: r.freeCashFlow,
                     source: r.freeCashFlowNote || (r.year >= 2003 ? "Apple-stated" : "derived") })),
  },

  get_ma_deals: {
    desc: "Filter/search the 78 filing-sourced M&A deals.",
    params: {
      deal_type: { type: "string", desc: "'acquisition' | 'divestiture' | 'spinoff' | 'all'" },
      from_year: { type: "integer", desc: "default 1984" },
      to_year: { type: "integer", desc: "default 2025" },
      min_value_millions: { type: "number", desc: "only deals ≥ this value" },
      search: { type: "string", desc: "substring match on name/category" },
    },
    fn: ({ deal_type = "all", from_year = 1984, to_year = 2025, min_value_millions = 0, search = "" } = {}) => {
      const q = search.trim().toLowerCase();
      return (D.ma.deals || []).filter(d =>
        d.year >= from_year && d.year <= to_year &&
        (deal_type === "all" || d.type === deal_type) &&
        (d.valueMillions || 0) >= min_value_millions &&
        (!q || d.name.toLowerCase().includes(q) || (d.category || "").toLowerCase().includes(q)))
        .map(d => ({ year: d.year, name: d.name, type: d.type,
                     valueMillions: d.valueMillions ?? null, category: d.category ?? null }));
    },
  },

  get_ma_era_summary: {
    desc: "Acquisitions, divestitures/spin-offs and disclosed spend per CEO era.",
    params: {},
    fn: () => [["Pre-Gerstner", 1984, 1992], ["Gerstner", 1993, 2002], ["Palmisano", 2003, 2011],
               ["Rometty", 2012, 2019], ["Krishna", 2020, 2025]].map(([era, a, b]) => {
      const deals = (D.ma.deals || []).filter(d => d.year >= a && d.year <= b);
      const acq = deals.filter(d => d.type === "acquisition");
      return { era, from: a, to: b, acquisitions: acq.length,
        divestitures: deals.length - acq.length,
        disclosedSpendMillions: acq.reduce((s, d) => s + (d.valueMillions || 0), 0) };
    }),
  },

  get_milestones: {
    desc: "Company milestones in a year range.",
    params: { from_year: { type: "integer", desc: "default 1977" }, to_year: { type: "integer", desc: "default 2025" } },
    fn: ({ from_year = 1977, to_year = 2025 } = {}) =>
      (D.metadata.milestones || []).filter(m => m.year >= from_year && m.year <= to_year),
  },

  get_leadership: {
    desc: "Apple CEOs — everyone, or who ran Apple in a given year.",
    params: { year: { type: "integer", desc: "optional; omit to list all" } },
    fn: ({ year } = {}) => {
      const L = D.metadata.leadership || [];
      return year ? L.filter(l => l.from <= year && (l.to == null || l.to >= year)) : L;
    },
  },

  get_macro_series: {
    desc: "US macro series by year: gdp, cpi, sp500, nasdaq, aaplBondYield, treasury10yr, recessions.",
    params: {
      series: { type: "string", desc: "series name", required: true },
      from_year: { type: "integer", desc: "default 1929" },
      to_year: { type: "integer", desc: "default 2025" },
    },
    fn: ({ series: name, from_year = 1929, to_year = 2025 }) => {
      if (name === "recessions")
        return (D.macro.recessions || []).filter(r => r.end >= from_year && r.start <= to_year);
      const keymap = { gdp: "gdpBillionsUSD", cpi: "cpiIndex", sp500: "sp500YearEnd",
                       nasdaq: "nasdaqYearEnd", aaplBondYield: "aaplBondYield", treasury10yr: "treasury10yr" };
      const src = D.macro[keymap[name]];
      if (!src) throw new Error(`unknown series '${name}'`);
      return Object.entries(src)
        .filter(([y]) => /^\d+$/.test(y) && +y >= from_year && +y <= to_year)
        .map(([year, value]) => ({ year: +year, value }));
    },
  },

  run_regression: {
    desc: "OLS between two metrics (linear + log-log elasticity), optional X-lead lag.",
    params: {
      x_metric: { type: "string", desc: "predictor key", required: true },
      y_metric: { type: "string", desc: "outcome key", required: true },
      from_year: { type: "integer", desc: "default 1977" },
      to_year: { type: "integer", desc: "default 2025" },
      lag: { type: "integer", desc: "years X leads Y (0–5, default 0)" },
    },
    fn: ({ x_metric, y_metric, from_year = 1977, to_year = 2025, lag = 0 }) => {
      ck(x_metric); ck(y_metric);
      const sy = new Map(series(y_metric));
      const pairs = inRange(series(x_metric), from_year, to_year)
        .filter(([y]) => sy.has(y + lag) && y + lag <= to_year)
        .map(([y, x]) => [x, sy.get(y + lag), y]);
      if (pairs.length < 4) throw new Error(`only ${pairs.length} overlapping observations`);
      const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
      const out = { x: x_metric, y: y_metric, lag, n: pairs.length,
                    years: [pairs[0][2], pairs.at(-1)[2]], linear: ols(xs, ys) };
      if (xs.every(v => v > 0) && ys.every(v => v > 0)) {
        const ll = ols(xs.map(Math.log), ys.map(Math.log));
        if (ll) out.logLog = { elasticity: +ll.slope.toFixed(3), r2: +ll.r2.toFixed(3) };
      }
      out.caution = "annual data — small n and shared time trends can flatter correlations; the Regression Lab tab has full diagnostics";
      return out;
    },
  },

  get_live_quote: {
    desc: "Live Apple quote (via agent server proxy, then Yahoo direct).",
    params: {},
    fn: async () => {
      const tryJSON = async url => {
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      };
      try { return await tryJSON(`${AGENT_URL}/quote?symbol=Apple`); } catch (_) {}
      const j = await tryJSON("https://query1.finance.yahoo.com/v8/finance/chart/Apple?interval=1d&range=5d");
      const res = j.chart.result[0];
      const m = res.meta;
      const closes = (res.indicators?.quote?.[0]?.close || []).filter(c => c != null);
      const prevClose = closes.length >= 2 ? closes[closes.length - 2] : (m.chartPreviousClose || m.previousClose);
      return { symbol: "Apple", price: m.regularMarketPrice, prevClose };
    },
  },

  refresh_live_quote: {
    desc: "Force the Overview tab's live-quote widget (price, change, live market-cap estimate) to re-fetch right now, instead of waiting for its normal 60s auto-refresh.",
    params: {},
    fn: async () => {
      window.selectTab("home");
      if (typeof window.refreshLiveQuote !== "function") throw new Error("live quote widget unavailable");
      await window.refreshLiveQuote();
      return {
        price: document.getElementById("lqPrice")?.textContent,
        change: document.getElementById("lqChange")?.textContent,
        marketCapEstimate: document.getElementById("lqCap")?.textContent,
      };
    },
  },

  /* ---- page actions ---- */
  navigate_to_tab: {
    desc: "Switch the dashboard to a tab: home, story, regression, macro, ma, competitors, about.",
    params: { tab: { type: "string", desc: "tab id", required: true } },
    fn: ({ tab }) => {
      if (!document.getElementById("panel-" + tab)) throw new Error(`no tab '${tab}'`);
      window.selectTab(tab);
      return { navigated: tab };
    },
  },

  set_overview_range: {
    desc: "Set the Overview trend chart's year range.",
    params: {
      from_year: { type: "integer", desc: "start year", required: true },
      to_year: { type: "integer", desc: "end year", required: true },
      label: { type: "string", desc: "optional chip label" },
    },
    fn: ({ from_year, to_year, label }) => {
      window.selectTab("home");
      if (typeof window.setOverviewRange !== "function") throw new Error("overview hook unavailable");
      window.setOverviewRange(+from_year, +to_year, label || `${from_year}–${to_year}`);
      return { range: [+from_year, +to_year] };
    },
  },

  list_regression_metrics: {
    desc: "List the metric keys the Regression Lab accepts for x_metric / y_metric, plus its curated preset scenarios. Call this before configure_regression rather than guessing a key — the Lab's keys are its own and do not all match list_metrics.",
    params: {},
    fn: () => {
      const prev = document.getElementById("panel-regression")?.classList.contains("active");
      if (!prev) window.selectTab("regression");
      const sel = document.getElementById("regX");
      if (!sel) throw new Error("Regression Lab did not initialize");
      const metrics = [...sel.options].map(o => ({ key: o.value, label: o.textContent.trim() }))
        .filter(m => m.key);
      const presets = [...document.querySelectorAll("#panel-regression .reg-preset-btn")]
        .map(b => b.textContent.trim()).filter(Boolean);
      return { metrics, presets,
               note: "Run a preset by passing its exact label to click_control; run an arbitrary pair with configure_regression." };
    },
  },

  configure_regression: {
    desc: "Open the Regression Lab and run a fit (best model auto-picked, always uses every available data point for the chosen metrics — there is no year-range control). Returns the fitted stats panel, so the answer can quote R², the chosen model and the slope. Use list_regression_metrics first for valid keys.",
    params: {
      x_metric: { type: "string", desc: "Regression Lab X key (e.g. rdExpense, gdp, iphonePct)", required: true },
      y_metric: { type: "string", desc: "Regression Lab Y key", required: true },
      lag: { type: "integer", desc: "0–5, default 0" },
    },
    fn: ({ x_metric, y_metric, lag = 0 }) => {
      window.selectTab("regression");
      const $ = id => document.getElementById(id);
      if (!$("regX")) throw new Error("Regression Lab did not initialize");
      const opt = (sel, v) => [...$(sel).options].some(o => o.value === v);
      if (!opt("regX", x_metric)) throw new Error(`no Regression Lab metric '${x_metric}'`);
      if (!opt("regY", y_metric)) throw new Error(`no Regression Lab metric '${y_metric}'`);
      $("regX").value = x_metric; $("regY").value = y_metric;
      $("regLag").value = String(Math.max(0, Math.min(5, lag)));
      $("regRun").click();
      const stats = $("regStatsCard")?.innerText || "";
      return { configured: { x_metric, y_metric, lag }, statsPanel: stats.slice(0, 600) };
    },
  },

  /* ── situational awareness ──────────────────────────────────────────────
     Without this the agent is blind: it can drive the page but cannot read
     back what is on it, so it cannot confirm an action landed or answer
     "what am I looking at". Reports the active tab plus that tab's headline
     figures, read from the live DOM rather than from the dataset. */
  describe_current_view: {
    desc: "Read back what is currently on screen: the active tab and its headline figures. Use to confirm an action landed, or to answer questions about what the user is looking at right now. Reads the rendered page, so it reflects live values.",
    params: {},
    fn: () => {
      const activeBtn = document.querySelector(".tab.active, [role='tab'][aria-selected='true']");
      const panel = document.querySelector(".panel.active");
      const tab = panel ? panel.id.replace(/^panel-/, "") : null;
      const txt = el => (el?.innerText || "").replace(/\s+/g, " ").trim();

      const view = { tab, tabLabel: txt(activeBtn) || null };

      if (tab === "macro") {
        const kpi = id => txt(document.getElementById(id));
        view.heroKpis = {
          marketCap: kpi("hkpiMarketCap"), totalDebt: kpi("hkpiDebt"),
          revenue: kpi("hkpiRevenue"), stockReturn: kpi("hkpiReturn"),
          creditRating: kpi("hkpiRating"),
        };
        view.sectionAKpis = ["spKpiPrice","spKpiYTD","spKpiDiv","spKpiBeta","spKpiVol","spKpiOutperf"]
          .map(id => txt(document.getElementById(id))).filter(Boolean);
        view.returnChart = {
          window: document.querySelector("#spReturnWindow .sp-tab-btn.active")?.dataset.win || null,
          cumulative: !!document.getElementById("spReturnCumToggle")?.checked,
        };
        view.bondChartTenor = txt(document.querySelector("#bondYieldRoot .sp-tab-btn.active")) || null;
      } else if (tab === "regression") {
        view.regression = {
          x: document.getElementById("regX")?.value || null,
          y: document.getElementById("regY")?.value || null,
          lag: document.getElementById("regLag")?.value || null,
          stats: txt(document.getElementById("regStatsCard")).slice(0, 400),
        };
      } else if (tab === "ma") {
        view.insightView = document.querySelector(".ma-ins-tab.active")?.dataset.ins || null;
      } else if (tab === "competitors") {
        view.segment = document.querySelector("#segmentSelector .reg-preset-btn.active")?.dataset.seg || null;
      }
      // Always include the live ticker if it is up — it is on every tab.
      const lq = window.__liveQuote;
      if (lq && lq.price != null) view.livePrice = lq.price;
      return view;
    },
  },

  /* ── Macro tab: Apple vs Market total-return chart ───────────────────────── */
  configure_return_chart: {
    desc: "Configure the Macro tab's 'Apple vs Market — Total Return & Outperformance' chart: the time window, which series are shown, and annual-bars vs cumulative-growth mode.",
    params: {
      window: { type: "string", desc: "'all' | '20' | '10' | '5' (years)" },
      series: { type: "array", desc: "Which to show, any of: aapl, sp500. Omit to leave unchanged" },
      cumulative: { type: "boolean", desc: "true = cumulative growth of $100; false = annual bars" },
    },
    fn: ({ window: win, series, cumulative }) => {
      window.selectTab("macro");
      const applied = {};
      if (win != null) {
        const b = [...document.querySelectorAll("#spReturnWindow .sp-tab-btn")]
          .find(x => x.dataset.win === String(win));
        if (!b) throw new Error(`window must be one of all, 20, 10, 5 — got '${win}'`);
        b.click(); applied.window = String(win);
      }
      if (Array.isArray(series)) {
        const valid = ["aapl", "sp500"];
        const bad = series.filter(s => !valid.includes(s));
        if (bad.length) throw new Error(`unknown series ${bad.join(", ")}; valid: ${valid.join(", ")}`);
        if (!series.length) throw new Error("series cannot be empty — the chart would be blank");
        valid.forEach(k => {
          const btn = [...document.querySelectorAll("#spReturnLegend .sp-leg-btn")]
            .find(x => x.dataset.key === k);
          if (!btn) return;
          const on = btn.getAttribute("aria-pressed") === "true";
          if (on !== series.includes(k)) btn.click();
        });
        applied.series = series;
      }
      if (cumulative != null) {
        const t = document.getElementById("spReturnCumToggle");
        if (t && t.checked !== !!cumulative) { t.checked = !!cumulative; t.dispatchEvent(new Event("change")); }
        applied.cumulative = !!cumulative;
      }
      return { applied, note: (document.getElementById("spReturnNote")?.innerText || "").slice(0, 300) };
    },
  },

  set_bond_yield_tenor: {
    desc: "Set which US Treasury tenor the Macro tab's 'Apple's Cost of Debt vs the Risk-Free Curve' chart compares Apple against.",
    params: { tenor: { type: "string", desc: "'3m' | '5y' | '10y' | '30y' (or a label like '10-yr note')", required: true } },
    fn: ({ tenor }) => {
      window.selectTab("macro");
      const alias = { "3m": "13-week", "5y": "5-yr", "10y": "10-yr", "30y": "30-yr" };
      const needle = (alias[String(tenor).toLowerCase()] || String(tenor)).toLowerCase();
      const btns = [...document.querySelectorAll("#bondYieldRoot .sp-tab-btn")];
      if (!btns.length) throw new Error("cost-of-debt chart is not on the page");
      const b = btns.find(x => x.textContent.toLowerCase().includes(needle));
      if (!b) throw new Error(`no tenor matching '${tenor}'; available: ${btns.map(x=>x.textContent.trim()).join(", ")}`);
      b.click();
      const root = document.getElementById("bondYieldRoot");
      return { tenor: b.textContent.trim(),
               callouts: [...root.querySelectorAll("div[style*='border-left']")]
                 .map(d => d.innerText.replace(/\s+/g, " ").trim()).slice(0, 3) };
    },
  },

  set_hero_chart_layer: {
    desc: "Switch the Macro tab's big Apple Stock Performance hero chart to a different layer.",
    params: { layer: { type: "string", desc: "price | marketCap | dividends | earnings | acquisitions", required: true } },
    fn: ({ layer }) => {
      window.selectTab("macro");
      const b = [...document.querySelectorAll(".mac-hero-layer-btn")].find(x => x.dataset.layer === layer);
      if (!b) throw new Error(`layer must be one of price, marketCap, dividends, earnings, acquisitions — got '${layer}'`);
      b.click();
      return { layer };
    },
  },

  set_ma_insight_view: {
    desc: "Switch the M&A tab's Deal Intelligence panel between its views.",
    params: { view: { type: "string", desc: "bar (Annual Spend) | scatter (Boldness Map) | alpha (Alpha Leaderboard) | catmix (Category Mix)", required: true } },
    fn: ({ view }) => {
      window.selectTab("ma");
      const b = [...document.querySelectorAll(".ma-ins-tab")].find(x => x.dataset.ins === view);
      if (!b) {
        const avail = [...document.querySelectorAll(".ma-ins-tab")].map(x => x.dataset.ins).join(", ");
        throw new Error(`no M&A view '${view}'; available: ${avail}`);
      }
      b.click();
      return { view, label: b.textContent.trim() };
    },
  },

  set_competitor_segment: {
    desc: "Choose which Apple segment the Competitors tab analyses (peer directory, SWOT, Five Forces, BCG, position map all follow this selection).",
    params: { segment: { type: "string", desc: "software | consulting | infrastructure", required: true } },
    fn: ({ segment }) => {
      window.selectTab("competitors");
      const b = [...document.querySelectorAll("#segmentSelector .reg-preset-btn")]
        .find(x => x.dataset.seg === segment);
      if (!b) throw new Error(`segment must be one of software, consulting, infrastructure — got '${segment}'`);
      b.click();
      return { segment, label: b.textContent.trim() };
    },
  },

  open_ma_era: {
    desc: "Open the M&A tab and pop the deal-list drawer for a CEO era.",
    params: { era: { type: "string", desc: "Pre-Gerstner | Gerstner | Palmisano | Rometty | Krishna", required: true } },
    fn: ({ era }) => {
      window.selectTab("ma");
      const card = [...document.querySelectorAll(".ma-era-card")]
        .find(c => c.querySelector(".ma-era-name")?.textContent.trim().toLowerCase() === era.trim().toLowerCase());
      if (!card) throw new Error(`no era card '${era}'`);
      card.click();
      return { opened: era };
    },
  },

  download_metric_csv: {
    desc: "Download a metric's full series as a CSV file.",
    params: { metric: { type: "string", desc: "key from list_metrics", required: true } },
    fn: ({ metric }) => {
      ck(metric);
      const rows = series(metric);
      const blob = new Blob([["year," + metric, ...rows.map(r => r.join(","))].join("\n")],
                            { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `aapl_${metric}_${rows[0][0]}-${rows.at(-1)[0]}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      return { downloaded: a.download, rows: rows.length };
    },
  },

  set_chart_metrics: {
    desc: "Set which metrics are plotted on the Overview trend chart (same-unit metrics only; picking a different-unit metric replaces the selection).",
    params: { metrics: { type: "array", desc: "1+ keys from: revenue, netIncome, totalAssets, stockholdersEquity, marketCap, freeCashFlow, epsDiluted, stockPrice", required: true } },
    fn: ({ metrics }) => {
      window.selectTab("home");
      if (typeof window.setOverviewMetrics !== "function") throw new Error("overview chart hook unavailable");
      const applied = window.setOverviewMetrics(metrics);
      return { metrics: applied };
    },
  },

  set_chart_scale: {
    desc: "Toggle the Overview trend chart between linear and log y-axis scale.",
    params: { scale: { type: "string", desc: "'linear' or 'log'", required: true } },
    fn: ({ scale }) => {
      window.selectTab("home");
      const box = document.getElementById("logToggle");
      if (!box) throw new Error("scale toggle unavailable");
      const wantLog = scale === "log";
      if (box.checked !== wantLog) { box.checked = wantLog; box.dispatchEvent(new Event("change")); }
      return { scale: wantLog ? "log" : "linear" };
    },
  },

  set_agent_note: {
    desc: "Post a floating note banner on the page (visible on every tab) — use this to leave the user a visible comment, summary, or call-out. Text only, no HTML.",
    params: { text: { type: "string", desc: "note text", required: true } },
    fn: ({ text }) => {
      let el = document.getElementById("cugaAgentNote");
      if (!el) {
        el = document.createElement("div");
        el.id = "cugaAgentNote";
        el.innerHTML = '<span class="cuga-note-tag">Agent note</span><span class="cuga-note-text"></span><button class="cuga-note-x" aria-label="Dismiss">×</button>';
        el.querySelector(".cuga-note-x").addEventListener("click", () => el.remove());
        document.body.appendChild(el);
      }
      el.querySelector(".cuga-note-text").textContent = text;
      return { posted: true };
    },
  },

  clear_agent_note: {
    desc: "Remove the on-page agent note banner, if present.",
    params: {},
    fn: () => {
      const el = document.getElementById("cugaAgentNote");
      if (el) el.remove();
      return { cleared: !!el };
    },
  },

  highlight_element: {
    desc: "Scroll to and briefly pulse-highlight the first element on the current tab whose text contains the given substring (case-insensitive). Good for drawing attention to a stat card, chip, or row after navigating there.",
    params: { text: { type: "string", desc: "substring to search for", required: true } },
    fn: ({ text }) => {
      const q = text.trim().toLowerCase();
      const panel = document.querySelector(".panel.active");
      if (!panel) throw new Error("no active tab panel");
      const candidates = panel.querySelectorAll(".snap, .ma-stat, .ma-era-card, .fy-stat, .reg-stat-row, .chip, .mtoggle, td, .gm-row, .callout");
      const hit = [...candidates].find(el => el.textContent.toLowerCase().includes(q));
      if (!hit) throw new Error(`no element on the current tab contains '${text}'`);
      hit.scrollIntoView({ behavior: "smooth", block: "center" });
      hit.classList.add("cuga-highlight");
      setTimeout(() => hit.classList.remove("cuga-highlight"), 2600);
      return { highlighted: hit.textContent.trim().slice(0, 80) };
    },
  },

  click_control: {
    desc: "Click a visible button, tab-style toggle, chip, or checkbox label on the current tab whose text matches a substring — e.g. a Macro-tab benchmark toggle ('S&P 500'), a Regression Lab preset, an M&A era filter, a 'Log scale' checkbox label, a Story Mode series button. Broader than the dedicated tools below: use this for any on-page control that doesn't have its own named tool.",
    params: { text: { type: "string", desc: "substring of the control's visible text", required: true } },
    fn: ({ text }) => {
      const q = text.trim().toLowerCase();
      const panel = document.querySelector(".panel.active") || document;
      const candidates = panel.querySelectorAll(
        "button, label, [role='button'], .chip, .mtoggle, .sp-tab-btn, .sp-leg-btn, .sm-series-btn, .ma-era-card"
      );
      const hit = [...candidates].find(el => el.textContent.trim().toLowerCase().includes(q));
      if (!hit) throw new Error(`no clickable control on the current tab matches '${text}'`);
      hit.scrollIntoView({ behavior: "smooth", block: "center" });
      hit.click();
      return { clicked: hit.textContent.trim().slice(0, 60) };
    },
  },

  set_theme: {
    desc: "Switch the dashboard between dark (default) and light color themes. Persists across reloads.",
    params: { theme: { type: "string", desc: "'dark' or 'light'", required: true } },
    fn: ({ theme }) => {
      if (typeof window.setTheme !== "function") throw new Error("theme hook unavailable");
      return { theme: window.setTheme(theme) };
    },
  },

  jump_to_story_chapter: {
    desc: "Open Story Mode and scroll to a specific chapter/era, optionally switching which series (netIncome, revenue, marketCap, stockPrice) its chart displays.",
    params: {
      chapter: { type: "string", desc: "chapter title substring, era id, or 0-based index (e.g. 'Gerstner', 'hybrid', 3)", required: true },
      series: { type: "string", desc: "optional: netIncome | revenue | marketCap | stockPrice" },
    },
    fn: ({ chapter, series }) => {
      window.selectTab("story");
      if (typeof window.setStoryChapter !== "function") throw new Error("Story Mode did not initialize");
      const idOrIdx = /^\d+$/.test(String(chapter).trim()) ? +chapter : chapter;
      return window.setStoryChapter(idOrIdx, series);
    },
  },

  configure_macro_chart: {
    desc: "Configure the Macro tab's Apple-vs-market indexed-growth chart: which Apple series to plot, which benchmark indexes to overlay, and whether to inflation-adjust (CPI-real).",
    params: {
      aapl_key: { type: "string", desc: "'revenue' or 'marketCap'" },
      benchmarks: { type: "array", desc: "subset of: sp500, tech, nasdaq, djia" },
      real: { type: "boolean", desc: "true = CPI-adjust every series to real dollars" },
    },
    fn: ({ aapl_key, benchmarks, real }) => {
      window.selectTab("macro");
      if (typeof window.setMacroChart !== "function") throw new Error("Macro chart did not initialize");
      return window.setMacroChart({ aapl_key, benchmarks, real });
    },
  },

  celebrate: {
    desc: "Fire a brief on-page confetti burst — a fun visual flourish for a milestone, a big number, or just to celebrate. Purely decorative, clears itself after ~3 seconds.",
    params: {},
    fn: () => {
      const colors = ["#0f62fe", "#a56eff", "#08bdba", "#42be65", "#ff832b", "#fa4d56", "#ffffff"];
      const n = 70;
      for (let i = 0; i < n; i++) {
        const el = document.createElement("div");
        const color = colors[i % colors.length];
        const round = Math.random() < 0.5;
        el.style.cssText = `position:fixed;top:-12px;left:${Math.random() * 100}vw;` +
          `width:${6 + Math.random() * 6}px;height:${6 + Math.random() * 6}px;background:${color};` +
          `z-index:99999;pointer-events:none;border-radius:${round ? "50%" : "2px"};` +
          `box-shadow:0 0 4px ${color};`;
        document.body.appendChild(el);
        const duration = 1800 + Math.random() * 1400;
        const xDrift = (Math.random() - 0.5) * 240;
        const spin = 360 + Math.random() * 720;
        const anim = el.animate(
          [
            { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
            { transform: `translate(${xDrift}px, 100vh) rotate(${spin}deg)`, opacity: 0.9, offset: 0.85 },
            { transform: `translate(${xDrift}px, 100vh) rotate(${spin}deg)`, opacity: 0 },
          ],
          { duration, easing: "cubic-bezier(.25,.46,.45,.94)" }
        );
        anim.onfinish = () => el.remove();
        setTimeout(() => el.remove(), duration + 200);
      }
      return { celebrated: true, particles: n };
    },
  },

  list_chartable_macro_series: {
    desc: "List the year-keyed macro series create_custom_chart can plot alongside financial metrics — GDP, CPI, Treasury yields, Apple's cost of debt, total-return series, and so on. Call this (or list_metrics for company figures) before charting rather than guessing a key.",
    params: {},
    fn: () => {
      const macro = (window.AAPL_DATA || {}).macro || {};
      const out = [];
      for (const key of Object.keys(macro)) {
        const v = macro[key];
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const yrs = Object.keys(v).filter(x => /^\d{4}$/.test(x)).sort();
        if (yrs.length < 3) continue;
        if (!yrs.every(y => typeof v[y] === "number" || v[y] == null)) continue;
        out.push({ key, from: +yrs[0], to: +yrs[yrs.length - 1], n: yrs.length });
      }
      return { series: out.sort((a, b) => a.key.localeCompare(b.key)),
               note: "Pass any of these to create_custom_chart's metrics array, mixed freely with list_metrics keys." };
    },
  },

  create_custom_chart: {
    desc: "Build a brand-new chart from any 1-4 metrics, append it to the bottom of the Overview tab, and take the user there. Accepts BOTH financial-series keys (list_metrics — revenue, rdExpense, netIncome, marketCap...) AND year-keyed macro series (list_chartable_macro_series — gdp, cpi, treasury10yr, aaplCostOfDebt, aaplTotalReturn, sp500TotalReturn...), so you can plot company figures against the economy. Metrics with different units are automatically indexed to 100 so they stay comparable on one axis. Use this for any 'plot X against Y' or 'make me a chart of...' request that isn't just the existing Overview trend chart (see set_chart_metrics for that).",
    params: {
      metrics: { type: "array", desc: "1-4 metric keys, financial or macro, e.g. ['revenue','rdExpense'] or ['aaplCostOfDebt','treasury10yr']", required: true },
      title: { type: "string", desc: "optional chart title" },
      from_year: { type: "integer", desc: "default: earliest year all metrics overlap" },
      to_year: { type: "integer", desc: "default: latest year all metrics overlap" },
      scale: { type: "string", desc: "'linear' (default) or 'log'" },
    },
    fn: ({ metrics, title, from_year, to_year, scale }) => {
      window.selectTab("home");
      if (typeof window.createCustomChart !== "function") throw new Error("custom chart hook unavailable");
      return window.createCustomChart({ metrics, title, fromYear: from_year, toYear: to_year, scale });
    },
  },

  clear_custom_charts: {
    desc: "Remove every agent-built custom chart from the bottom of the Overview tab.",
    params: {},
    fn: () => {
      if (typeof window.clearCustomCharts !== "function") throw new Error("custom chart hook unavailable");
      return window.clearCustomCharts();
    },
  },
};

/* ── Public API ────────────────────────────────────────────────────────────*/
const AGENT_URL = window.LIVE_AGENT_URL || "http://localhost:8787";

window.APPLE_AGENT = {
  manifest: () => Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.desc,
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(t.params)
        .map(([p, s]) => [p, { type: s.type, description: s.desc }])),
      required: Object.entries(t.params).filter(([, s]) => s.required).map(([p]) => p),
    },
  })),
  invoke: async (name, args = {}) => {
    const t = TOOLS[name];
    if (!t) return { ok: false, error: `unknown tool '${name}' — see window.APPLE_AGENT.manifest()` };
    try { return { ok: true, result: await t.fn(args) }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  agentURL: AGENT_URL,
};
/* ── Apple-specific tools (no IBM equivalent) ─────────────────────────────*/
Object.assign(TOOLS, {

  get_quarterly_results: {
    desc: "Reported quarterly revenue, net income and diluted EPS (Q4 FY2021 onward). Use this for anything about the CURRENT fiscal year — the annual series stops at the last completed year, so FY2026 only exists here.",
    params: {
      fiscal_year: { type: "integer", desc: "optional: limit to one fiscal year, e.g. 2026" },
    },
    fn: ({ fiscal_year }) => {
      const qs = ((D.quarterly || {}).quarters) || [];
      if (!qs.length) throw new Error("quarterly data unavailable");
      const rows = fiscal_year ? qs.filter(q => q.fy === +fiscal_year) : qs;
      if (!rows.length) throw new Error(`no quarters for FY${fiscal_year}`);
      return rows.map(q => ({
        fiscalYear: q.fy, quarter: "Q" + q.fq, periodEnd: q.end,
        revenueM: q.revenue, netIncomeM: q.netIncome, epsDiluted: q.epsDiluted ?? null,
      }));
    },
  },

  get_current_year_progress: {
    desc: "The in-progress fiscal year summed from filed quarters (revenue, net income, EPS, dividends per share) plus trailing-twelve-month totals. Never a projection.",
    params: {},
    fn: () => {
      const py = D.partialYear;
      const qs = ((D.quarterly || {}).quarters) || [];
      if (!py) throw new Error("no fiscal year currently in progress in this dataset");
      const ttm = qs.slice(-4);
      return {
        fiscalYear: py.year, quartersReported: py.quartersReported,
        revenueM: py.revenue, netIncomeM: py.netIncome,
        epsDilutedSoFar: py.epsDiluted, epsQuarters: py.epsQuarters,
        dividendsPerShare: py.dividendsPerShare,
        dividendsFinal: py.dividendsComplete,
        ttmRevenueM: +ttm.reduce((t, q) => t + q.revenue, 0).toFixed(1),
        ttmNetIncomeM: +ttm.reduce((t, q) => t + q.netIncome, 0).toFixed(1),
        note: py.note,
      };
    },
  },

  get_valuation_multiples: {
    desc: "Valuation multiples across Apple's peer set (P/E, P/S, P/B, market cap, TTM revenue and net income). Peers with negative book equity report pb as null.",
    params: { ticker: { type: "string", desc: "optional single ticker, e.g. AAPL" } },
    fn: ({ ticker }) => {
      const v = ((D.valuation || {}).peers) || [];
      if (!v.length) throw new Error("valuation data unavailable");
      const rows = ticker ? v.filter(p => p.ticker === String(ticker).toUpperCase()) : v;
      if (!rows.length) throw new Error(`no peer '${ticker}' — have ${v.map(p => p.ticker).join(", ")}`);
      return { asOf: (D.valuation || {}).asOf, peers: rows };
    },
  },

  set_competitor_chart_mode: {
    desc: "Switch the Competitors tab's main chart between its four modes.",
    params: { mode: { type: "string", desc: "totalReturn | evEbitda (net margin) | scatter | valuation", required: true } },
    fn: ({ mode }) => {
      window.selectTab("competitors");
      const ids = { totalReturn: "chartModeTR", evEbitda: "chartModeEV",
                    scatter: "chartModeScatter", valuation: "chartModeVal" };
      const btn = document.getElementById(ids[mode]);
      if (!btn) throw new Error(`mode must be one of ${Object.keys(ids).join(", ")} — got '${mode}'`);
      btn.click();
      return { mode };
    },
  },

  set_valuation_metric: {
    desc: "Choose which multiple the Competitors valuation chart ranks peers by.",
    params: { metric: { type: "string", desc: "pe | ps | pb | marketCap", required: true } },
    fn: ({ metric }) => {
      window.selectTab("competitors");
      const modeBtn = document.getElementById("chartModeVal");
      if (modeBtn) modeBtn.click();
      const b = document.querySelector(`#valuation-toggles .val-metric[data-metric="${metric}"]`);
      if (!b) throw new Error("metric must be pe, ps, pb or marketCap");
      b.click();
      return { metric };
    },
  },

  get_cfo_leadership: {
    desc: "Apple's CFOs with tenures (the CEO list is get_leadership).",
    params: {},
    fn: () => (D.metadata.cfoLeadership || []).map(l => ({
      name: l.name, role: l.role, from: l.from, to: l.to ?? "present",
    })),
  },

  get_bond_yield_comparison: {
    desc: "Apple's effective cost of debt against the Fed funds rate, Treasury tenors and Moody's Aaa/Baa corporate yields, by year.",
    params: { from_year: { type: "integer" }, to_year: { type: "integer" } },
    fn: ({ from_year = 2013, to_year = 2026 }) => {
      const m = D.macro || {};
      const cod = m.aaplCostOfDebt || {};
      const years = Object.keys(cod).map(Number).filter(y => y >= from_year && y <= to_year).sort();
      if (!years.length) throw new Error("no cost-of-debt data in that range");
      return years.map(y => ({
        year: y,
        appleCostOfDebtPct: cod[y] ?? null,
        fedFundsPct: (m.fedFundsRate || {})[y] ?? null,
        treasury10yrPct: ((m.treasuryCurve || {})["10y"] || {})[y] ?? null,
        moodysAaaPct: (m.corpAaaYield || {})[y] ?? null,
        moodysBaaPct: (m.corpBaaYield || {})[y] ?? null,
      }));
    },
  },

  get_sec_filings: {
    desc: "Apple's most recent SEC filings (10-K, 10-Q, earnings 8-K) live from EDGAR, plus the latest reported quarter.",
    params: {},
    fn: async () => {
      const base = window.LIVE_AGENT_URL || "";
      const [f, x] = await Promise.all([
        fetch(base + "/filings/latest").then(r => r.json()).catch(() => null),
        fetch(base + "/filings/xbrl").then(r => r.json()).catch(() => null),
      ]);
      if (!f) throw new Error("EDGAR feed unavailable");
      return { latest: f.latest, recent: (f.filings || []).slice(0, 5),
               latestQuarter: x ? x.latestQuarter : null };
    },
  },
});

/* ── "Ask the data" chat panel ────────────────────────────────────────────
   The tools run HERE, in the page, because most of them touch the DOM
   (switch tabs, configure the Regression Lab, build charts). So the browser
   drives the loop and the server only brokers the model call:

     browser  --POST /chat {messages, tools}-->  worker  --> OpenAI
     browser  <--tool_calls------------------- worker
     browser  executes tools locally, appends results, POSTs again
     ... until the model returns prose instead of tool calls.

   The API key lives only in the Worker (env.OPENAI_API_KEY) and is never
   shipped to the browser. If /chat is unreachable the panel says so and the
   rest of the dashboard is unaffected.                                    */
const AGENT_ENDPOINT = () => (window.LIVE_AGENT_URL || "") + "/chat";

const SYSTEM_PROMPT = [
  "You are the data agent embedded in the 'Apple Through the Years' dashboard —",
  "fifty fiscal years of Apple (FY1977-2025) drawn from the IPO prospectus, Form",
  "10-K filings and SEC XBRL, plus live market and filing data.",
  "",
  "Rules:",
  "- ALWAYS answer from tool results. Never recall figures from memory; if a tool",
  "  did not return it, say so.",
  "- The annual series ends at the last COMPLETED fiscal year. For anything about",
  "  the current year use get_current_year_progress or get_quarterly_results.",
  "- Money is US$ millions unless a tool says otherwise. null means the value was",
  "  never reliably reported — say 'not reported', never guess or interpolate.",
  "- You can drive the page. When a question is naturally visual (a trend, a",
  "  comparison, a regression), call the matching action tool so the user SEES it:",
  "  create_custom_chart, configure_regression, set_hero_chart_layer,",
  "  set_competitor_chart_mode, navigate_to_tab, jump_to_story_chapter.",
  "  Prefer doing it over describing it, then say what you put on screen.",
  "- Be concise and specific. Quote the numbers you used, with years.",
].join("\n");

function buildChatPanel() {
  const wrap = document.createElement("div");
  wrap.id = "agentChat";
  wrap.innerHTML = `
    <button id="agentFab" title="Ask the data agent" aria-label="Ask the data"
            aria-expanded="false" aria-controls="agentPanel">Ask the data</button>
    <div id="agentPanel" hidden role="dialog" aria-label="Apple data agent">
      <div class="agent-head">
        <span>Apple data agent</span>
        <span class="agent-status" id="agentStatus"></span>
        <button id="agentClose" aria-label="Close">&times;</button>
      </div>
      <div class="agent-msgs" id="agentMsgs">
        <div class="agent-msg agent">Ask about any figure in fifty years of Apple filings — or tell me to chart it, run a regression, or open a tab. I answer only from the dashboard's own data.</div>
      </div>
      <form class="agent-inrow" id="agentForm">
        <input id="agentInput" type="text" autocomplete="off"
               placeholder="e.g. chart R&D against net income since 2010" />
        <button type="submit" id="agentSend">Send</button>
      </form>
    </div>`;
  document.body.appendChild(wrap);

  const fab = wrap.querySelector("#agentFab");
  const panel = wrap.querySelector("#agentPanel");
  const msgs = wrap.querySelector("#agentMsgs");
  const form = wrap.querySelector("#agentForm");
  const input = wrap.querySelector("#agentInput");
  const statusEl = wrap.querySelector("#agentStatus");

  const add = (role, text) => {
    const d = document.createElement("div");
    d.className = "agent-msg " + role;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  };

  fab.addEventListener("click", () => {
    const open = panel.hasAttribute("hidden");
    if (open) { panel.removeAttribute("hidden"); input.focus(); }
    else panel.setAttribute("hidden", "");
    fab.setAttribute("aria-expanded", String(open));
  });
  wrap.querySelector("#agentClose").addEventListener("click", () => {
    panel.setAttribute("hidden", ""); fab.setAttribute("aria-expanded", "false");
  });

  const history = [{ role: "system", content: SYSTEM_PROMPT }];

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    add("user", q);
    history.push({ role: "user", content: q });
    const thinking = add("agent", "…");
    statusEl.textContent = "thinking";

    try {
      const tools = window.APPLE_AGENT.manifest().map(t => ({ type: "function", function: t }));
      // Cap the loop: the model gets a bounded number of tool rounds per turn.
      for (let round = 0; round < 6; round++) {
        const r = await fetch(AGENT_ENDPOINT(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: history, tools }),
          signal: AbortSignal.timeout(45000),
        });
        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          throw new Error(detail.error || `chat endpoint returned ${r.status}`);
        }
        const msg = (await r.json()).message;
        history.push(msg);

        const calls = msg.tool_calls || [];
        if (!calls.length) {
          thinking.textContent = msg.content || "(no answer)";
          statusEl.textContent = "";
          return;
        }
        thinking.textContent = "running " + calls.map(c => c.function.name).join(", ") + "…";
        for (const c of calls) {
          let args = {};
          try { args = JSON.parse(c.function.arguments || "{}"); } catch (_) {}
          const out = await window.APPLE_AGENT.invoke(c.function.name, args);
          history.push({
            role: "tool", tool_call_id: c.id,
            content: JSON.stringify(out).slice(0, 12000),   // keep the context bounded
          });
        }
      }
      thinking.textContent = "Stopped after six tool rounds without a final answer — try a narrower question.";
      statusEl.textContent = "";
    } catch (err) {
      thinking.textContent = String(err.message || err).includes("Failed to fetch")
        ? "Agent unreachable. The /chat endpoint needs OPENAI_API_KEY set on the Worker."
        : "Agent error: " + (err.message || err);
      statusEl.textContent = "offline";
    }
  });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", buildChatPanel);
else buildChatPanel();

})();
