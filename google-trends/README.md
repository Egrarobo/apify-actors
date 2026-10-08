# Google Trends Scraper & API

**Get Google Trends data as JSON or spreadsheet rows, without running pytrends and fighting "429 Too Many Requests".** Give it your keywords, a country and a time range; get back interest over time, interest by region, top and rising related searches, and today's Trending Now searches.

- **What you get:** one row per keyword with the 0-100 timeline, average, peak date, latest value, top region, related and rising queries, and a link to the same chart on trends.google.com
- **What it costs:** $3 per 1,000 keywords (`$0.003` each; less on paid Apify plans, down to $1.50), $1 per 1,000 Trending Now searches. Keywords that fail or come back incomplete are **free**.
- **Try it now:** the form is prefilled with `coffee` vs `tea` in the US over 12 months plus the top 10 Trending Now searches. Click **Start**; that run costs about **$0.02**.

## pytrends 429 fix: why this works when pytrends doesn't

[pytrends](https://github.com/GeneralMills/pytrends) is archived and Google answers its requests with `429 Too Many Requests` very quickly. This Actor runs the same Google Trends requests from Apify's infrastructure:

- every request is paced (1.5 s by default), and a refused request (HTTP 429, captcha, network error) is retried with **a new proxy IP and new Google cookies**;
- if Google's explore endpoint stays blocked, chart data comes from Google's **embeddable widget pages**, and as a last resort from a **real Chrome browser**;
- you only pay for keywords that came back complete.

Still writing Python? The free [pytrends-alternative](https://github.com/Egrarobo/pytrends-alternative) library keeps the pytrends interface and runs it through this Actor:

```python
from gtrends_api import TrendReq   # was: from pytrends.request import TrendReq
pytrends = TrendReq()              # uses your APIFY_TOKEN
pytrends.build_payload(["coffee", "tea"], timeframe="today 12-m", geo="US")
df = pytrends.interest_over_time()
```

## Who it's for

- **SEO and content teams:** find rising searches before they peak and plan content around them
- **Market researchers and product managers:** compare brands, products or features over 5 years, by country, state or city
- **E-commerce:** see when demand for a product starts every year (seasonality) and stock up in time
- **Analysts and AI agents:** search-demand data on demand, as clean JSON with a `status` on every row

### Keyword demand checker for Etsy, KDP and Payhip sellers

Selling printables, planners, low-content books or digital downloads? Before you make the next product, check if people actually search for it and when:

```json
{
  "searchTerms": ["budget planner", "meal planner", "habit tracker", "reading journal", "wedding planner"],
  "geo": "US",
  "timeRange": "today 5-y",
  "relatedQueries": true,
  "maxRelatedItems": 10
}
```

You get 5 years of weekly interest for each idea on **one 0-100 scale** (which idea has more demand), the **peak week** (the season to publish before), and the **rising related searches** (new niche ideas you had not thought of). This is 5 keywords, so the run costs $0.02. For 50 ideas, set `"anchorTerm": "budget planner"` so every group of 5 stays comparable (see below).

## Why this scraper

- **You don't pay for failures.** A keyword is charged only when **all the data you asked for** was collected. Incomplete keywords are stored for free, with the reason in `errors`.
- **Clean outputs.** One item per keyword with `timeline`, `averageInterest`, `peakDate`, `latestValue`, `topRegion` and related lists, or **flat rows** for Excel, Google Sheets and BI tools.
- **Hundreds of keywords on one scale.** Google compares at most 5 at a time; with an anchor term the Actor rescales every group so all keywords are comparable.
- **Transparent.** Each request is logged with its HTTP status, time, consent or captcha detection and the parser used. Unexpected responses are saved to the key-value store (`DEBUG-…`), and the run summary (`OUTPUT`) lists every keyword's status.

## Quick start

Compare two terms in the US over the past 12 months, plus today's US Trending Now searches (this is the prefilled example):

```json
{
  "searchTerms": ["coffee", "tea"],
  "geo": "US",
  "timeRange": "today 12-m",
  "trendingNow": true,
  "maxTrendingItems": 10
}
```

All inputs, including related queries, regions and more:

```json
{
  "searchTerms": ["iphone", "samsung galaxy", "google pixel"],
  "geo": "GB",
  "timeRange": "custom",
  "customTimeRange": "2025-01-01 2025-12-31",
  "category": "5",
  "gprop": "",
  "interestOverTime": true,
  "interestByRegion": true,
  "regionResolution": "REGION",
  "relatedQueries": true,
  "relatedTopics": true,
  "maxRelatedItems": 10
}
```

### Many terms on one scale (anchor term)

Google compares at most 5 terms at a time, and every comparison is scaled to its own top term (= 100). So "40" in one group and "40" in another are not the same thing. With `anchorTerm`, each group is built as **anchor + 4 of your terms**; the Actor uses the anchor to rescale all groups onto one scale and adds `comparableValue` (per point) and `comparableAverage` (per term), where 100 is the highest point of **all** terms.

```json
{
  "searchTerms": ["asana", "trello", "notion", "clickup", "monday.com", "jira", "basecamp", "todoist", "airtable"],
  "anchorTerm": "slack",
  "geo": "US",
  "timeRange": "today 5-y"
}
```

Pick an anchor that is stable and roughly as popular as your terms. If the anchor averages below 10 in a group, the log warns you: Google rounds to whole numbers, so tiny anchors make the rescaling imprecise. Without an anchor, more than 5 terms are simply split into groups of 5 (not comparable between groups), and `comparisonMode: "separate"` gives every term its own 0-100 scale.

## Use it in n8n / Make / Zapier / Claude (MCP)

All four have an official Apify integration, so you need no custom code, only your Apify API token (Apify Console → Settings → API & Integrations).

**n8n**
1. Add the **Apify** node (n8n Cloud: search for it on the canvas; self-hosted: Settings → Community Nodes → install the Apify node).
2. Operation **Run Actor**, Actor `egra_van/google-trends-reliable`, input JSON as in the Quick start, **Wait for finish** on.
3. Add a second Apify node, operation **Get Dataset Items**, Dataset ID = `defaultDatasetId` from step 2.
4. Ready-made workflow: [weekly content ideas from rising searches](https://github.com/Egrarobo/apify-actors/blob/main/n8n-templates/google-trends-content-ideas.json): every Monday it gets rising searches for your seed keywords, keeps only new ones, writes an SEO brief for each with OpenAI and saves them to Google Sheets. It uses a plain HTTP Request node, so it also works without the Apify node.

**Make**
1. Add the **Apify → Run an Actor** module, choose *Google Trends Scraper & API*, paste the input JSON and let it wait for the run to finish (synchronous run).
2. Add **Apify → Get Dataset Items** with the dataset ID from step 1, then e.g. **Google Sheets → Add a Row**.

**Zapier**
1. Action **Apify → Run Actor**: choose this Actor and paste the input JSON.
2. Action **Apify → Fetch Dataset Items** (or the trigger **Finished Actor Run** in a second Zap) and send each row to Google Sheets, Slack or email.

**Claude, ChatGPT, Cursor and other AI assistants (MCP)**
Add the Apify MCP server to your assistant (in Claude: add a custom connector with the URL below). To give the assistant only this tool, use:

```
https://mcp.apify.com?tools=egra_van/google-trends-reliable
```

Then ask, for example: *"Compare Google Trends interest for notion, clickup and asana in the US over 5 years and tell me which one is growing."*

## Output

### One item per term

```json
{
  "type": "term",
  "term": "coffee",
  "isAnchor": false,
  "groupId": 1,
  "comparedWith": ["tea"],
  "geo": "US",
  "timeRange": "today 12-m",
  "timeRangeResolved": "2025-10-08 2026-10-08",
  "resolution": "WEEK",
  "category": 0,
  "categoryName": "All categories",
  "gprop": "web",
  "gpropName": "Web Search",
  "language": "en-US",
  "status": "ok",
  "timeline": [
    { "date": "2025-10-05", "timestamp": 1759622400, "value": 63, "hasData": true, "isPartial": false, "formattedTime": "Oct 5 – 11, 2025" },
    { "date": "2026-10-04", "timestamp": 1791072000, "value": 69, "hasData": true, "isPartial": true, "formattedTime": "Oct 4 – 10, 2026" }
  ],
  "averageInterest": 77.25,
  "peakValue": 100,
  "peakDate": "2026-04-12",
  "latestValue": 69,
  "latestDate": "2026-10-04",
  "googleAverage": 77,
  "timelinePoints": 53,
  "exploreUrl": "https://trends.google.com/trends/explore?date=today+12-m&geo=US&q=coffee%2Ctea&hl=en-US",
  "dataSource": "explore/http",
  "scrapedAt": "2026-10-08T11:53:56.720Z"
}
```

This is a real result of the prefilled example (run on 8 Oct 2026; the timeline is shortened to its first and last week, the full one has 53 points). In the same run `tea` had `averageInterest` 36.77, so coffee had about twice the search interest of tea in the US.

With `interestByRegion`, `relatedQueries` or `relatedTopics` on, the item also has these fields (values illustrative):

```json
{
  "regionResolution": "REGION",
  "regions": [{ "geoCode": "US-CA", "geoName": "California", "value": 100, "formattedValue": "100", "hasData": true }],
  "topRegion": "California",
  "relatedQueriesTop": [{ "rank": 1, "query": "coffee near me", "value": 100, "formattedValue": "100", "link": "https://trends.google.com/trends/explore?q=coffee+near+me&date=today+12-m&geo=US" }],
  "relatedQueriesRising": [{ "rank": 1, "query": "coffee tariffs", "value": 5000, "formattedValue": "Breakout", "isBreakout": true, "link": "https://trends.google.com/trends/explore?q=coffee+tariffs&date=today+12-m&geo=US" }],
  "relatedTopicsTop": [{ "rank": 1, "topicId": "/m/02vqfm", "title": "Coffee", "topicType": "Beverage", "value": 100, "formattedValue": "100", "link": "https://trends.google.com/trends/explore?q=/m/02vqfm&date=today+12-m&geo=US" }],
  "relatedTopicsRising": []
}
```

Notes:

- **Values are relative (0-100), not search counts.** 100 is the peak of the most popular term in the comparison for the chosen place and time; 0 means too little data. This is how Google Trends works.
- `isPartial: true` marks the last, still-incomplete period. `averageInterest` ignores it.
- Dates are UTC: `YYYY-MM-DD` for daily, weekly and monthly data, full ISO time for hourly and minute data (time ranges up to 7 days).
- `status` is `ok` (everything requested was collected, charged), `partial` or `failed` (stored for free, with `errors`).
- With `anchorTerm`: `comparableValue` in every timeline point and `comparableAverage` per term.
- Fields for data you did not request are omitted; data that failed is `null`.

### Trending Now items

The values below are illustrative; the fields are the real output format.

```json
{
  "type": "trending",
  "rank": 1,
  "title": "example search",
  "approxTraffic": "500K+",
  "approxTrafficMin": 500000,
  "startedAt": "2026-10-08T07:10:00.000Z",
  "newsCount": 3,
  "newsTitle": "Example news headline",
  "newsUrl": "https://…",
  "newsSource": "Example News",
  "news": [{ "title": "…", "url": "…", "source": "Example News", "picture": "…", "snippet": null }],
  "picture": "https://…",
  "pictureSource": "Example News",
  "geo": "US",
  "source": "rss",
  "exploreUrl": "https://trends.google.com/trends/explore?q=example+search&date=now+1-d&geo=US"
}
```

Two sources:

- **`rss`** (default): Google's official Trending Now RSS feed. Most reliable; the top trending searches with approximate traffic, start time, picture and news.
- **`trendingPage`**: the data behind trends.google.com/trending, for the past 4, 24, 48 hours or 7 days. More searches, plus `increasePercent`, `endedAt`, `isActive`, `categories` and `relatedQueries`. News is added from the RSS feed where the titles match. If this source fails, the Actor falls back to RSS.

Trending Now runs **before** the search terms (it is a single request).

### Flat rows for spreadsheets

With `"flattenTimeline": true` each term becomes several rows with a `rowType` column:

| rowType | Columns |
|---|---|
| `term` | term, status, averageInterest, comparableAverage, peakDate, topRegion, comparedWith, errors, exploreUrl |
| `timeline` | term, date, value, comparableValue, isPartial, hasData |
| `region` | term, regionCode, regionName, value, lat, lng |
| `relatedQuery` | term, list (top/rising), rank, query, value, formattedValue, isBreakout |
| `relatedTopic` | term, list, rank, topicId, title, topicType, value, formattedValue, isBreakout |

Filter by `rowType` in Excel or Google Sheets, or pivot `timeline` rows (term × date). Price is the same: per term.

### Dataset views and run summary

The dataset has views **Terms overview**, **Interest over time**, **Interest by region**, **Related queries & topics**, **Trending now** and **Flat rows**. The key-value store record `OUTPUT` holds the run summary: status and errors per term, groups, anchor scale factors, trending status and request statistics (requests, retries, 429s, captcha and consent pages, sessions, browser use).

## Pricing

Pay per event, platform usage included:

| Event | When | Price |
|---|---|---|
| `term-result` | one search term with **all** the data you requested (timeline, regions, related queries/topics) | $0.003 (down to $0.0015 on higher plans) |
| `trending-item` | one Trending Now search stored | $0.001 |

Terms that fail or come back incomplete are not charged. The anchor term is charged once. The Actor checks your **maximum cost per run** before each group and never fetches data it cannot charge for: if the limit allows only 3 more terms, the next comparison contains only 3 terms.

Examples: 5 terms with everything = $0.02. 500 keywords with an anchor = about $2.00. Trending Now top 20 = $0.02.

## Tips for reliable runs

- **Proxy.** The default Apify proxy works for most runs; every retry uses a new IP. Google Trends limits requests per IP, so for hundreds of terms, daily schedules or many parallel runs, spread the work over several smaller runs or add **your own proxy URLs** (any provider, including residential IPs; you pay your provider directly). The Apify **RESIDENTIAL** and **GOOGLE_SERP** groups are not available in this Actor (`GOOGLE_SERP` only serves Google Search pages): if you select one, the run continues on the default Apify proxy and says so in the log.
- **Go slow.** Keep `maxConcurrency` at 1 and `requestDelayMs` at 1500+ unless you use your own residential proxies. Related queries/topics are the most rate-limited parts: ask for them only when you need them.
- **Related topics** with several terms cost one extra request per term (Google only returns them for single-term charts).
- **Topics instead of words.** A Knowledge Graph topic id such as `/m/0663v` (Pizza, the food) can be used as a search term; it covers all spellings and languages of the topic.
- **Scheduling.** Run it daily with the same input to build your own history; Google Trends data for short ranges changes slightly between requests (sampling).

## How AI agents call this Actor

**Through the Apify MCP server** (Claude, ChatGPT, Cursor, VS Code, the n8n AI Agent): connect `https://mcp.apify.com?tools=egra_van/google-trends-reliable` and the agent sees this Actor as one tool, with its input schema. With the default `https://mcp.apify.com`, an agent finds Actors with `search-actors`, reads the input with `fetch-actor-details`, runs them with `call-actor` and reads the results with `get-dataset-items`.

**Through the REST API, in one HTTP call** (waits for the run and returns the dataset items):

```bash
curl -X POST "https://api.apify.com/v2/acts/egra_van~google-trends-reliable/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms":["claude","chatgpt","gemini"],"geo":"US","timeRange":"today 3-m","relatedQueries":true}'
```

**Agents that pay with crypto** can buy a prepaid Apify API token through [Apify AGI](https://docs.apify.com/platform/integrations/mcp) (x402) and use it with this Actor like any other token.

Tips for agents:

- Input is plain JSON; only `searchTerms` (or `trendingNow: true`) is needed. `timeRange` also accepts any Google Trends time string (`"today 2-y"`, `"now 3-d"`, `"2025-01-01 2025-06-30"`).
- Every item has `type` (`term` or `trending`; `rowType` in flat mode) and `status` (`ok`, `partial`, `failed`), so complete, partial and failed data can be told apart without reading logs.
- Values are relative (0-100). To answer "which is more popular", compare `averageInterest` within one group, or `comparableAverage` across groups when `anchorTerm` is set.
- Set `maxTotalChargeUsd` in the run options to cap the cost: the Actor never fetches data it cannot charge for.

## Input reference

| Field | Default | Description |
|---|---|---|
| `searchTerms` | – | Terms to compare (up to 5 per group, any number in total) |
| `comparisonMode` | `groups` | `groups` or `separate` |
| `anchorTerm` | – | Common term added to every group to make groups comparable |
| `geo` | worldwide | `US`, `GB`, `US-CA`, … |
| `timeRange` | `today 12-m` | Preset or `custom` |
| `customTimeRange` | – | `2025-01-01 2025-06-30`, `2026-09-20T00 2026-09-26T23`, `today 2-y`, `now 3-d` |
| `category` / `categoryId` | 0 (all) | Google Trends category |
| `gprop` | web | `images`, `news`, `froogle` (Shopping), `youtube` |
| `language` | `en-US` | Interface language (`hl`) |
| `timezoneOffset` | 0 | Google's `tz`, minutes behind UTC |
| `interestOverTime` | true | Timeline |
| `interestByRegion` | false | Regions; `regionResolution`: auto, COUNTRY, REGION, CITY, DMA; `includeLowSearchVolumeRegions` |
| `relatedQueries` / `relatedTopics` | false | Top and rising lists; `maxRelatedItems` (25) |
| `flattenTimeline` | false | Flat rows for spreadsheets |
| `trendingNow` | false | Trending Now searches; `trendingGeo`, `trendingSource` (`rss`/`trendingPage`), `trendingHours`, `maxTrendingItems`, `includeNews` |
| `proxyConfiguration` | Apify Proxy | See tips above |
| `useBrowser` | `fallback` | `fallback`, `always`, `never` |
| `useEmbedFallback` | true | Use embeddable widget pages when explore is rate-limited |
| `maxRetries` | 5 | Retries per request (new session each time) |
| `maxConcurrency` | 1 | Parallel comparison groups |
| `requestDelayMs` | 1500 | Pause between requests |

## Limitations

- Google Trends has no public API for this data (the official Trends API launched in 2025 is an alpha with limited access), so this Actor reads the same internal endpoints the Google Trends website uses. Google can change them without notice; the Actor logs which step failed and saves the response for diagnosis.
- Heavy use from shared datacenter IPs can be rate-limited by Google for a while. Retries with new IPs, the embed and browser fallbacks cover most cases; very large runs work best split into smaller runs or with your own proxies.
- Values are relative and sampled by Google, not absolute search volumes.

## Legal

This Actor collects publicly available, aggregated and anonymized statistics. It does not collect personal data. You are responsible for using the data in line with Google's Terms of Service and the laws that apply to you.
