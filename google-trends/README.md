# Google Trends Scraper: Interest, Related & Trending Now

Get **Google Trends data as clean JSON or spreadsheet rows**, without running pytrends yourself and fighting "429 Too Many Requests":

- **Interest over time** for up to **5 terms compared together** on one 0-100 scale, exactly like trends.google.com
- **Hundreds of terms** in one run: automatic batching into groups of 5, with an optional **anchor term** that puts every group on **one comparable scale**
- **Interest by region**: countries, states/regions, cities (with latitude/longitude) or US metro areas (DMA)
- **Related queries** and **related topics**, top and rising (with "+250%" and "Breakout")
- **Trending Now**: the searches trending today in any country, with approximate search volume and news articles
- Any **location, time range** (past hour to 2004-present, or custom dates), **category** and **Google property** (Web, Images, News, Shopping, YouTube)

Built for SEO and content teams, market researchers, e-commerce and product managers, analysts, and **AI agents** that need search-demand data on demand.

## Why this scraper

- **Made for reliability.** Google Trends rate-limits hard. Every request is paced (1.5 s default), and a refused request (HTTP 429, captcha, network error) is retried with exponential backoff and a **new session: new proxy IP and new Google cookies**. If Google's explore endpoint stays blocked, chart tokens come from Google's **embeddable widget pages** instead, and as a last resort a **real Chrome browser** takes over.
- **You don't pay for failures.** A term is charged only when **all the data you asked for** was collected. Incomplete terms are stored for free with the reason in `errors`.
- **Clean outputs.** One item per term with `timeline`, `averageInterest`, `peakDate`, `latestValue`, `topRegion`, related lists, and a link to the same chart on Google Trends. Or switch on **flat rows** for Excel / Google Sheets / BI tools.
- **Transparent.** Each request is logged with its HTTP status, time, whether a consent or captcha page was detected, and which parser read the data. Unexpected responses are saved to the key-value store (`DEBUG-…`). The run summary (`OUTPUT`) lists every term's status and request statistics.

## Quick start

Compare two terms in the US over the past 12 months, plus today's US Trending Now searches:

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

## Python: drop-in pytrends replacement

Tired of `429 Too Many Requests` in pytrends? The free, MIT-licensed [pytrends-alternative](https://github.com/Egrarobo/pytrends-alternative) library keeps the pytrends interface (`TrendReq`, `build_payload`, `interest_over_time`, `interest_by_region`, `related_queries`, `trending_searches`) and runs the requests through this Actor:

```python
from gtrends_api import TrendReq   # was: from pytrends.request import TrendReq
pytrends = TrendReq()              # uses your APIFY_TOKEN
pytrends.build_payload(["coffee", "tea"], timeframe="today 12-m", geo="US")
df = pytrends.interest_over_time()
```

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
  "timeRangeResolved": "2025-09-27 2026-09-27",
  "resolution": "WEEK",
  "category": 0,
  "categoryName": "All categories",
  "gprop": "web",
  "gpropName": "Web Search",
  "language": "en-US",
  "status": "ok",
  "timeline": [
    { "date": "2025-09-28", "timestamp": 1759017600, "value": 81, "hasData": true, "isPartial": false, "formattedTime": "Sep 28 – Oct 4, 2025" },
    { "date": "2026-09-20", "timestamp": 1789862400, "value": 77, "hasData": true, "isPartial": true, "formattedTime": "Sep 20 – 26, 2026" }
  ],
  "averageInterest": 77.08,
  "peakValue": 100,
  "peakDate": "2025-12-21",
  "latestValue": 77,
  "latestDate": "2026-09-20",
  "googleAverage": 77,
  "timelinePoints": 53,
  "regionResolution": "REGION",
  "regions": [{ "geoCode": "US-CA", "geoName": "California", "value": 100, "formattedValue": "100", "hasData": true }],
  "topRegion": "California",
  "relatedQueriesTop": [{ "rank": 1, "query": "coffee near me", "value": 100, "formattedValue": "100", "link": "https://trends.google.com/trends/explore?q=coffee+near+me&date=today+12-m&geo=US" }],
  "relatedQueriesRising": [{ "rank": 1, "query": "coffee tariffs", "value": 5000, "formattedValue": "Breakout", "isBreakout": true, "link": "https://trends.google.com/trends/explore?q=coffee+tariffs&date=today+12-m&geo=US" }],
  "relatedTopicsTop": [{ "rank": 1, "topicId": "/m/02vqfm", "title": "Coffee", "topicType": "Beverage", "value": 100, "formattedValue": "100", "link": "https://trends.google.com/trends/explore?q=/m/02vqfm&date=today+12-m&geo=US" }],
  "relatedTopicsRising": [],
  "exploreUrl": "https://trends.google.com/trends/explore?date=today+12-m&geo=US&q=coffee%2Ctea&hl=en-US",
  "dataSource": "explore/http",
  "scrapedAt": "2026-09-27T12:00:00.000Z"
}
```

(Values above are illustrative.) Notes:

- **Values are relative (0-100), not search counts.** 100 is the peak of the most popular term in the comparison for the chosen place and time; 0 means too little data. This is how Google Trends works.
- `isPartial: true` marks the last, still-incomplete period. `averageInterest` ignores it.
- Dates are UTC: `YYYY-MM-DD` for daily, weekly and monthly data, full ISO time for hourly and minute data (time ranges up to 7 days).
- `status` is `ok` (everything requested was collected, charged), `partial` or `failed` (stored for free, with `errors`).
- With `anchorTerm`: `comparableValue` in every timeline point and `comparableAverage` per term.
- Fields for data you did not request are omitted; data that failed is `null`.

### Trending Now items

```json
{
  "type": "trending",
  "rank": 1,
  "title": "world series",
  "approxTraffic": "500K+",
  "approxTrafficMin": 500000,
  "startedAt": "2026-09-27T07:10:00.000Z",
  "newsCount": 3,
  "newsTitle": "Game 7 goes to extra innings",
  "newsUrl": "https://…",
  "newsSource": "ESPN",
  "news": [{ "title": "…", "url": "…", "source": "ESPN", "picture": "…", "snippet": null }],
  "picture": "https://…",
  "pictureSource": "ESPN",
  "geo": "US",
  "source": "rss",
  "exploreUrl": "https://trends.google.com/trends/explore?q=world+series&date=now+1-d&geo=US"
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
| `term-result` | one search term with **all** the data you requested (timeline, regions, related queries/topics) | $0.004 |
| `trending-item` | one Trending Now search stored | $0.001 |

Terms that fail or come back incomplete are not charged. The anchor term is charged once. The Actor checks your **maximum cost per run** before each group and never fetches data it cannot charge for: if the limit allows only 3 more terms, the next comparison contains only 3 terms.

Examples: 5 terms with everything = $0.02. 500 keywords with an anchor = about $2.00. Trending Now top 20 = $0.02.

## Tips for reliable runs

- **Proxy.** The default Apify datacenter proxy works for small runs; every retry uses a new IP. Google Trends limits requests per IP, so for hundreds of terms, daily schedules or many parallel runs use the **RESIDENTIAL** proxy group. Do not use `GOOGLE_SERP`: that proxy only serves Google Search pages.
- **Go slow.** Keep `maxConcurrency` at 1 and `requestDelayMs` at 1500+ unless you use residential proxies. Related queries/topics are the most rate-limited parts: ask for them only when you need them.
- **Related topics** with several terms cost one extra request per term (Google only returns them for single-term charts).
- **Topics instead of words.** A Knowledge Graph topic id such as `/m/0663v` (Pizza, the food) can be used as a search term; it covers all spellings and languages of the topic.
- **Scheduling.** Run it daily with the same input to build your own history; Google Trends data for short ranges changes slightly between requests (sampling).

## For AI agents and developers

Run synchronously and get the items in one HTTP call:

```bash
curl -X POST "https://api.apify.com/v2/acts/<username>~google-trends/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms":["claude","chatgpt","gemini"],"geo":"US","timeRange":"today 3-m","relatedQueries":true}'
```

- Input is plain JSON; every field is optional except `searchTerms` or `trendingNow`. `timeRange` also accepts any Google Trends time string directly (`"today 2-y"`, `"now 3-d"`, `"2025-01-01 2025-06-30"`).
- Every item has `type` (`term` or `trending`; `rowType` in flat mode) and `status`, so agents can tell complete, partial and failed data apart without reading logs.
- Values are relative. To answer "which is more popular", compare `averageInterest` within one group, or `comparableAverage` across groups when an anchor is set.
- The Actor can be used as a tool through the Apify MCP server (`mcp.apify.com`).

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
- Heavy use from shared datacenter IPs can be rate-limited by Google for a while. Retries with new IPs, the embed and browser fallbacks cover most cases, but very large runs need residential proxies.
- Values are relative and sampled by Google, not absolute search volumes.

## Legal

This Actor collects publicly available, aggregated and anonymized statistics. It does not collect personal data. You are responsible for using the data in line with Google's Terms of Service and the laws that apply to you.
