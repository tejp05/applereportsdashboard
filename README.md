# Apple Through the Years — website

A **zero-build static site** (plain HTML/CSS/JS, no framework, no npm install) that
visualizes fifty years of Apple's annual-report record — fiscal 1977 through 2025 —
drawn from the IPO prospectus, Form 10-K filings on SEC EDGAR, SEC XBRL company
facts, and Yahoo Finance market data. It is intentionally dependency-free so it
keeps running long after the original team has moved on.

> Independent analytics concept built on Apple's public filings.
> Not affiliated with or endorsed by Apple Inc.

## Run it

There is nothing to build:

- **Local dev:** `python3 serve.py` → http://localhost:5500 (no-cache headers, so
  edits show on plain reload).
- **Open directly:** double-click `index.html`. The historical data is baked into
  `data.js`, so everything works straight from disk; Story Mode's "read the
  filing" excerpts need http(s), and live widgets (ticker, quotes) hide
  themselves when no live server is reachable.

## Deploy (Cloudflare Pages)

The site is pure static files — Cloudflare Pages serves it as-is:

1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo. Framework preset: **None**. Build command: *(leave empty)*.
   Build output directory: `/`.
4. Deploy. Done — no functions, no environment variables needed.

(Netlify / GitHub Pages / Vercel static work identically: no build step, publish
the repo root.)

Live features degrade gracefully with no server: the SEC-filings cards fall back
to fetching SEC EDGAR directly (CORS-open), the live quote falls back to the
baked fiscal-year-end figures, and the ticker/peer-quote strips stay hidden. A
live-features server can be added later and pointed at with `?agent=https://host`
(persisted; `?agent=clear` resets).

## Files

| File | Role |
|------|------|
| `index.html` | App shell: top bar, tab nav, the Overview panel, and one `<section>` per tab. |
| `styles.css` | All styling. Design tokens (colors, fonts) are the `:root` variables at the top. Apple-inspired: SF system fonts, apple.com dark grays, product-category accents, frosted glass. |
| `charts.js` | A tiny dependency-free SVG line chart (`window.TrendChart`). Linear/log scale, multi-series, hover, milestone markers. |
| `app.js` | Wires everything: tabs, Overview (scrubber, era filters, trend chart, derived ratios), Story Mode, Macro vs Apple, M&A, Competitors, About. |
| `regression.js` | The Regression Lab: OLS + nonlinear model fitting with era presets, diagnostics, CSV export. |
| `data.js` | **Auto-generated** — `window.AAPL_DATA`. Do not edit by hand. |
| `Story Mode/aapl_daily_prices.js` | **Auto-generated** — `window.AAPL_DAILY_PRICES`, AAPL daily adjusted closes from the Dec 12, 1980 IPO. |
| `letters_raw/` → `pipeline/raw/text/` | Verbatim excerpts from Apple filings, one per Story Mode chapter focus year. |

## The data

`window.AAPL_DATA` (from `data.js`) has:

- `financials` — one object per fiscal year 1977–2025: revenue, net income, EPS,
  dividends, assets, equity, R&D, employees, cash flow, capex, debt, Services
  revenue, market cap, FY-end share price. Money is **US$ millions**; `null`
  means the value was not reliably stated in a source (**never estimated**).
  Per-share figures are on the current split-adjusted basis (all five splits:
  1987, 2000, 2005, 2014, 2020) — exactly as Apple restates prior years in its
  own filings. Market cap needs no adjustment: as-reported fiscal-year-end share
  count × the same day's actual close.
- `segments` — net sales by product category (iPhone / Mac / iPad / Wearables,
  Home and Accessories / Services), validated to sum to the audited total.
- `metadata` — company naming, CEOs, eras, milestones.
- `macro` — US macro series (GDP, CPI, S&P 500, Nasdaq, treasuries, NBER
  recessions) plus AAPL market series (monthly price, total return, dividend
  yield, rolling beta, volume, cost of debt).
- `ma` / `maPerformance` / `maBenchmark` — the acquisition record with per-deal
  2-year stock-performance windows vs dividend-adjusted benchmarks.

**Source of truth is the pipeline, not this folder.** When the source data
changes, regenerate:

```bash
python3 pipeline/extract_sec_facts.py     # SEC XBRL → sec_annual.json
python3 pipeline/build_market_series.py   # Yahoo raw data → market_series.json
python3 pipeline/build_ma_performance.py  # deal windows vs benchmarks
python3 pipeline/export_web.py            # assemble → data.js
```

See `pipeline/` for the raw source JSONs and per-script documentation. Every
number in the dataset traces to a named source; adversarial verification passes
re-checked the pre-EDGAR years and every disclosed deal value.

## Accuracy method

- **Primary sources first.** SEC XBRL company facts (FY2008+, machine-read from
  the audited filings, as originally reported), each year's own Form 10-K
  (FY1994–2007, read from EDGAR), the December 1980 IPO prospectus (FY1977–1980),
  and period annual reports for the years in between.
- **Never estimate.** A value not reliably stated stays `null` and the UI shows
  a gap.
- **Cross-checks everywhere.** Category tables must sum to the audited revenue
  total; market caps were anchored against known values; split-adjusted EPS was
  verified against Apple's own restatements.
