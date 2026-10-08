# Website Screenshot Pro: Bulk Screenshots & PDF

**Paste a list of URLs and get a clean screenshot of every page, in one run.** Full page or just the visible window, on desktop, laptop, tablet or mobile, as PNG, JPEG, WebP and optionally PDF, with cookie banners hidden, ads blocked and lazy-loaded images loaded before the capture. Download everything as one ZIP.

- **What you get:** one image (and optional PDF) per URL with a public download link, plus a row with the HTTP status, final URL, page title, size and a plain-English reason for every failed URL
- **What it costs:** $3 per 1,000 screenshots (`$0.003` each; less on paid Apify plans, down to $1.50), $1 per 1,000 extra PDFs. Invalid, broken or failed URLs are **free**.
- **Try it now:** the form is prefilled with 2 pages (`apify.com`, `wikipedia.org`). Click **Start**; that run costs **$0.01**.

## Bulk screenshots to PDF: 100 competitor homepages in one run

Typical jobs: a **monthly snapshot of competitor homepages and pricing pages**, **visual QA** after a release, **client and SEO reports**, **archiving pages** as a dated record, **thumbnails** for a directory, or giving an **AI agent** a picture of a page.

```json
{
  "urls": [
    "https://stripe.com/pricing",
    "https://www.paypal.com/us/business/paypal-business-fees",
    "https://squareup.com/us/en/pricing"
  ],
  "fullPage": true,
  "format": "jpeg",
  "quality": 80,
  "savePdf": true,
  "outputZip": true
}
```

Put up to hundreds of URLs in `urls` (or read them from another Actor's dataset with `startUrlsDatasetId`). With `outputZip` you get one `screenshots.zip` with every image and PDF. 100 pages with PDFs cost $0.60.

A real result from 8 Oct 2026 (the prefilled pages plus `stripe.com/pricing`, full page, PNG + PDF): all 3 captured in about 15 seconds on our test machine. `wikipedia.org` is 1920×1100 px (199 kB), `apify.com` 1920×10036 px (1.2 MB). `stripe.com/pricing` is 22,334 px tall, so it was cut at the 15,000 px limit and the row says so in `warnings`.

## Why this screenshot Actor

- 🧹 **Clean screenshots**: cookie and consent pop-ups hidden (OneTrust, Cookiebot, Didomi, Quantcast, TrustArc, Usercentrics, CookieYes and generic cookie bars). Nothing is clicked or accepted.
- 🚫 **Ads and trackers blocked**: faster pages, no flashing banners
- 🖼️ **Lazy images really load**: the page is scrolled before a full-page capture, so images further down are not empty boxes
- 📱 **Device presets**: Desktop 1920×1080, Laptop 1366×768, Tablet 768×1024, Mobile 390×844 (retina, touch, mobile browser) or any custom size
- 🗂️ **PNG, JPEG, WebP, plus PDF** of the same page in one run
- 🎯 **Element screenshots**: capture only `#pricing` or `.hero`
- 🌙 **Dark mode**, custom elements to hide, wait for an element, extra delay
- ⚡ **Fast in bulk**: several pages in parallel, retries with a fresh proxy IP, one ZIP with everything
- 🧾 **Honest results**: HTTP status, final URL after redirects, page title, size in pixels and bytes, clear warnings, and a plain-English reason for every failed URL
- 💸 **Pay only for successful screenshots**: invalid, broken or failed URLs are free

## Quick start

1. Paste your URLs, one per line.
2. Choose the device and whether you want the **full page**.
3. Click **Start**. Open the **Screenshots** table to see image previews and download links.

## Input example

```json
{
  "urls": ["https://apify.com", "https://www.wikipedia.org", "example.com/pricing"],
  "device": "mobile",
  "fullPage": true,
  "format": "webp",
  "quality": 80,
  "hideCookieBanners": true,
  "blockAds": true,
  "hideSelectors": ["#intercom-container"],
  "savePdf": false,
  "outputZip": true
}
```

### Main options

| Option | What it does |
|---|---|
| `urls` | Pages to capture. `example.com` becomes `https://example.com`. Duplicates are skipped. |
| `startUrlsDatasetId` + `urlField` | Read URLs from a dataset, e.g. the results of another scraper. Nested fields use dots (`page.url`). |
| `device` | `desktop`, `laptop`, `tablet`, `mobile` or `custom` (then set `width` and `height`). |
| `scaleFactor` | Pixel density: 1 = normal, 2 = retina. Defaults to the device's own value. |
| `fullPage` | Whole page instead of the visible window. Very long pages are cut at `maxHeight` (15,000 px by default). |
| `format`, `quality` | `png` (lossless), `jpeg` or `webp` (small files). |
| `clipSelector` | Capture one element only, e.g. `#pricing`. |
| `savePdf` | Also save an A4 PDF of each page. |
| `hideCookieBanners`, `blockAds`, `hideSelectors` | Page clean-up. |
| `scrollToBottom` | Load lazy images before full-page or element captures (on by default). |
| `darkMode` | Ask the site for its dark theme. |
| `waitUntil`, `delaySecs`, `waitForSelector` | When to take the picture. A page that never finishes loading is still captured at the timeout, with a warning. |
| `timeoutSecs`, `retries` | Per-page timeout and number of retries (network errors, timeouts, HTTP 429/5xx). |
| `maxConcurrency` | Pages captured in parallel (default 3). |
| `proxyConfiguration` | Apify Proxy or your own proxies. Off by default. |
| `outputZip` | One `screenshots.zip` with every image and PDF. |

## Output

Every image is stored in the run's **key-value store** under a readable key such as `apify.com-pricing-3f9a1c2b7d.png`, with a public link. Each URL also gets one dataset item:

```json
{
  "url": "https://apify.com",
  "finalUrl": "https://apify.com/",
  "status": 200,
  "title": "Apify: Full-stack web scraping and data extraction platform",
  "screenshotUrl": "https://api.apify.com/v2/key-value-stores/abc123/records/apify.com-1f0c9e0b2d.png",
  "screenshotKey": "apify.com-1f0c9e0b2d.png",
  "pdfUrl": null,
  "format": "png",
  "device": "desktop",
  "width": 1920,
  "height": 7342,
  "fullPage": true,
  "truncated": false,
  "bytes": 1843201,
  "contentType": "text/html",
  "cookieBannersHidden": 1,
  "loadTimeMs": 3120,
  "attempts": 1,
  "warnings": [],
  "takenAt": "2026-09-27T08:00:00.000Z",
  "error": null
}
```

A failed URL looks like this (and is not charged):

```json
{ "url": "https://no-such-domain.example", "screenshotUrl": null, "error": "Domain not found (DNS lookup failed). Check the address for typos.", "errorType": "navigation-failed", "attempts": 1 }
```

The dataset has two views: **Screenshots** (with image previews) and **Failed URLs**. The `OUTPUT` record in the key-value store has a summary of the run (counts, ZIP link, charged events).

### Good to know

- **4xx and 5xx pages are still captured** (you see the error page) and the HTTP status is recorded, which is what you want for monitoring. 429 and 5xx responses are retried first.
- **Redirects are followed**; `finalUrl` shows where you ended up.
- **Direct links to PDF or other files** are reported as "not a web page" and not charged. Direct image links are captured, with a warning.
- **Invalid URLs** are listed in the results with a reason and never stop the run.
- If the run is restarted by the platform (e.g. server migration), already captured URLs are skipped, so nothing is charged twice.

## Pricing

Pay per event, only for results:

| Event | When | Price |
|---|---|---|
| `screenshot` | One page captured and saved | $0.003 ($3 / 1,000; down to $1.50 on higher plans) |
| `pdf-export` | One PDF saved (only when "Also save as PDF" is on) | $0.001 ($1 / 1,000) |

Failed, invalid and skipped URLs are free. Discounts apply on Apify's paid plans (Bronze, Silver, Gold). The Actor checks your **maximum cost per run** before every page and stops cleanly when the next page would not fit, so you are never charged above your limit. Pages that were not processed are listed in the log and in `OUTPUT.notProcessed`.

## Memory and speed

- **2048 MB** memory with the default 3 parallel pages is a good start for most sites.
- For large batches use **4096 MB and 6–8 parallel pages**. Rule of thumb: one parallel page per 512 MB.
- Full-page **mobile** screenshots are 3× sharper and bigger; choose JPEG or WebP to keep files small.

## Use it in n8n / Make / Zapier / Claude (MCP)

All four have an official Apify integration, so you need no custom code, only your Apify API token (Apify Console → Settings → API & Integrations).

**n8n**
1. Add the **Apify** node (n8n Cloud: search for it on the canvas; self-hosted: Settings → Community Nodes → install the Apify node).
2. Operation **Run Actor**, Actor `egra_van/website-screenshot-pro`, input JSON as in the Quick start, **Wait for finish** on.
3. Add a second Apify node, operation **Get Dataset Items**, Dataset ID = `defaultDatasetId` from step 2.
4. Ready-made workflow: [competitor website monitor](https://github.com/Egrarobo/apify-actors/blob/main/n8n-templates/competitor-website-monitor.json): checks competitor pages every day, takes a screenshot of every changed page, summarizes the changes with OpenAI, emails them and logs them in Google Sheets.

**Make**
1. Add the **Apify → Run an Actor** module, choose *Website Screenshot Pro: Bulk Screenshots & PDF*, paste the input JSON and let it wait for the run to finish (synchronous run).
2. Add **Apify → Get Dataset Items** with the dataset ID from step 1, then e.g. **Google Drive → Upload a File (from `screenshotUrl`)**.

**Zapier**
1. Action **Apify → Run Actor**: choose this Actor and paste the input JSON.
2. Action **Apify → Fetch Dataset Items** (or the trigger **Finished Actor Run** in a second Zap) and send each row to Google Sheets, Slack or email.

**Claude, ChatGPT, Cursor and other AI assistants (MCP)**
Add the Apify MCP server to your assistant (in Claude: add a custom connector with the URL below). To give the assistant only this tool, use:

```
https://mcp.apify.com?tools=egra_van/website-screenshot-pro
```

Then ask, for example: *"Take full-page mobile screenshots of these 5 competitor pricing pages and tell me what changed in their plans."*

To screenshot the pages found by another Actor, set `startUrlsDatasetId` to that run's dataset ID and `urlField` to the field with the URL.

## How AI agents call this Actor

**Through the Apify MCP server** (Claude, ChatGPT, Cursor, VS Code, the n8n AI Agent): connect `https://mcp.apify.com?tools=egra_van/website-screenshot-pro` and the agent sees this Actor as one tool, with its input schema. With the default `https://mcp.apify.com`, an agent finds Actors with `search-actors`, reads the input with `fetch-actor-details`, runs them with `call-actor` and reads the results with `get-dataset-items`.

**Through the REST API, in one HTTP call** (waits for the run and returns the dataset items):

```bash
curl -X POST "https://api.apify.com/v2/acts/egra_van~website-screenshot-pro/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com","https://apify.com/pricing"],"device":"mobile","fullPage":true,"format":"jpeg"}'
```

**Agents that pay with crypto** can buy a prepaid Apify API token through [Apify AGI](https://docs.apify.com/platform/integrations/mcp) (x402) and use it with this Actor like any other token.

Tips for agents:

- Only `urls` is needed. `example.com` becomes `https://example.com`; duplicates are skipped.
- Each row has `screenshotUrl` (a public link to the image), `status`, `finalUrl`, `title` and `error` (null when it worked), so an agent can open the image or report why a page failed.
- For a vision model, use `format: "jpeg"` or `"webp"` and `fullPage: false` to keep images small.
- Set `maxTotalChargeUsd` in the run options to cap the cost; the Actor stops cleanly before the next page that would not fit.

## Limitations

- Sites with strong bot protection may show a challenge page; try a residential proxy.
- Pages that scroll inside an inner container (instead of the whole window) are captured at window height in full-page mode.
- Content behind a login is not supported.
- WebP images are at most 16,383 px tall (a limit of the WebP format); longer pages are cut, with a warning.
