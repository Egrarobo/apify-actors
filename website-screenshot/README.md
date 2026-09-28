# Website Screenshot Pro — Bulk, Full Page, Mobile

Take **clean screenshots of hundreds of web pages in one run**. Paste a list of URLs (or connect the results of another Actor) and get a **full-page or viewport screenshot of every page**, on **desktop, laptop, tablet or mobile**, as **PNG, JPEG, WebP or PDF**. Cookie banners and ads are removed automatically, and lazy-loaded images are loaded before the capture.

Typical uses: **website monitoring and archiving**, **visual QA** after a release, **SEO and client reports**, **competitor tracking**, **thumbnails and link previews**, and giving **AI agents** a picture of a page.

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

| Event | When |
|---|---|
| `screenshot` | One page captured and saved |
| `pdf-export` | One PDF saved (only when "Also save as PDF" is on) |

Failed, invalid and skipped URLs are free. The Actor checks your **maximum cost per run** before every page and stops cleanly when the next page would not fit, so you are never charged above your limit. Pages that were not processed are listed in the log and in `OUTPUT.notProcessed`.

## Memory and speed

- **2048 MB** memory with the default 3 parallel pages is a good start for most sites.
- For large batches use **4096 MB and 6–8 parallel pages**. Rule of thumb: one parallel page per 512 MB.
- Full-page **mobile** screenshots are 3× sharper and bigger; choose JPEG or WebP to keep files small.

## Use it from code, Make, Zapier or n8n

Start the Actor through the Apify API with the JSON input above, then read the dataset items (each has `screenshotUrl`). To screenshot the pages found by another Actor, set `startUrlsDatasetId` to that run's dataset ID and `urlField` to the field with the URL.

## Limitations

- Sites with strong bot protection may show a challenge page; try a residential proxy.
- Pages that scroll inside an inner container (instead of the whole window) are captured at window height in full-page mode.
- Content behind a login is not supported.
- WebP images are at most 16,383 px tall (a limit of the WebP format); longer pages are cut, with a warning.
