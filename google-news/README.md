# Google News Scraper & API

Get Google News articles for any **search query**, **topic** (Business, Technology, Sports...) or **location** (Chicago, Bavaria...), in any language and country. For each article you get the **title, source, publication date and the publisher's real URL**, not the `news.google.com` redirect link. Results come as JSON, CSV or Excel, or through the Apify API.

The Actor reads Google News' **public RSS feeds** with plain HTTP requests. It does not open Google Search, needs no browser and no special proxy, so runs are fast and cheap: in our test, the example run (20 articles with real URLs) finished in 3 seconds.

This is an unofficial tool, not affiliated with or endorsed by Google.

## What you can do with it

- **Media monitoring and PR:** every article that mentions your brand, your competitors or your CEO, every day.
- **Market and investment research:** news on a company, a sector or a ticker, by country and language.
- **AI agents and RAG:** fresh, dated headlines with clean source URLs for your LLM pipeline.
- **Local news:** what is being written about a city or region, in the local language (e.g. Romanian news on Moldova, German news on Bavaria).

## Input

| Field | What it does | Example |
|---|---|---|
| `queries` | Search queries, one per line. Google operators work: `"exact phrase"`, `OR`, `-exclude`, `site:reuters.com`, `intitle:word` | `["OpenAI", "\"electric vehicles\" site:reuters.com"]` |
| `topics` | Google News sections: `TOP_STORIES`, `WORLD`, `NATION`, `BUSINESS`, `TECHNOLOGY`, `ENTERTAINMENT`, `SPORTS`, `SCIENCE`, `HEALTH` | `["BUSINESS"]` |
| `locations` | Local news for a city, region or country | `["Chicago"]` |
| `language` / `country` | The Google News edition | `en-US` / `US`, `en-GB` / `GB`, `ro` / `RO`, `de` / `AT` |
| `timeRange` | `any`, `1h`, `1d`, `7d`, `30d`, `1y` or `custom` (with `dateFrom` / `dateTo`) | `7d` |
| `maxArticlesPerFeed` | Max articles per query, topic or location (1 to 5,000) | `100` |
| `decodeUrls` | Real publisher URLs (on by default, included in the price) | `true` |
| `fetchPublisherDetails` | Snippet, main image and author read from the publisher's page (charged separately) | `false` |
| `includeRelatedCoverage` | Other articles about the same story (top stories and topics) | `false` |
| `deduplicate` | An article found by several queries is saved and charged once | `true` |

**More than 100 articles per query.** A Google News feed returns up to about 100 articles. When you ask for more, the Actor reads each query **day by day** over the period (one feed per day) and merges the results, so busy topics give thousands of articles. With `timeRange: "any"`, the last 30 days are used.

### Example input

```json
{
  "queries": ["OpenAI"],
  "language": "en-US",
  "country": "US",
  "timeRange": "7d",
  "maxArticlesPerFeed": 20
}
```

## Output

One row per article, newest first. A real row from 9 Oct 2026 (query `OpenAI`, US edition, past 7 days):

```json
{
  "feedType": "search",
  "feed": "OpenAI",
  "rank": 2,
  "title": "Nvidia, Oracle, CoreWeave and other AI stocks sink on OpenAI revenue report",
  "source": "CNBC",
  "sourceUrl": "https://www.cnbc.com",
  "publishedAt": "2026-10-08T18:14:54.000Z",
  "articleUrl": "https://www.cnbc.com/2026/10/08/open-ai-revenue-nvidia-oracle-coreweave.html",
  "urlDecoded": true,
  "googleNewsUrl": "https://news.google.com/rss/articles/CBMiggFBVV95cUxPOG8tazVE...?oc=5",
  "snippet": null,
  "imageUrl": null,
  "author": null,
  "language": "en-US",
  "country": "US",
  "period": "7d",
  "articleId": "CBMiggFBVV95cUxPOG8tazVE...",
  "scrapedAt": "2026-10-08T21:33:07.416Z"
}
```

With `fetchPublisherDetails: true` (query `Moldova`, Romanian edition `ro` / `RO`, 9 Oct 2026):

```json
{
  "title": "Radu Miruță: „Securitatea Republicii Moldova înseamnă și securitatea României”. Avertisment privind amenințările din regiune",
  "source": "Digi24",
  "publishedAt": "2026-10-08T15:21:44.000Z",
  "articleUrl": "https://www.digi24.ro/stiri/actualitate/radu-miruta-securitatea-republicii-moldova-inseamna-si-securitatea-romaniei-avertisment-privind-amenintarile-din-regiune-3984345",
  "snippet": "Ministrul interimar al Apărării, Radu Miruță, a avertizat joi, de la Chișinău, asupra amenințărilor la adresa securității regionale, de la incursiunile dronelor în spațiul aerian până la atacurile cibernetice și dezinformare.",
  "imageUrl": "https://s.iw.ro/gateway/g/...thumb.jpg"
}
```

Query `"electric vehicles" site:reuters.com`, UK edition, past 30 days (first 3 of 10 rows):

| publishedAt | title | articleUrl |
|---|---|---|
| 2026-10-08 | Why EV sales are lukewarm in America, but hot in Europe | https://www.reuters.com/business/autos-transportation/why-ev-sales-are-lukewarm-america-hot-europe-2026-10-08/ |
| 2026-10-07 | Anglo-Teck merger, nickel sale are test cases for navigating geopolitical complexities, CEO says | https://www.reuters.com/world/asia-pacific/anglo-teck-merger-nickel-sale-are-test-cases-navigating-geopolitical-2026-10-07/ |
| 2026-10-07 | South Korea unveils $747 billion energy transition plan through 2035 | https://www.reuters.com/business/energy/south-korea-unveils-747-billion-energy-transition-plan-through-2035-2026-10-07/ |

The run also saves a summary in the key-value store (`OUTPUT`): feeds read, articles saved, real URLs found, duplicates skipped and retries.

**About the snippet.** Google News RSS feeds carry no article summary. The `snippet`, `imageUrl` and `author` fields are filled only with `fetchPublisherDetails`, from the preview metadata the publisher puts on its own page (the description shown when the link is shared). The article body is not stored.

## Pricing

Pay per event: you pay only for articles saved, never for failed requests.

| Event | FREE | BRONZE | SILVER | GOLD |
|---|---|---|---|---|
| Article (with the real URL) | $1.80 / 1,000 | $1.50 / 1,000 | $1.25 / 1,000 | $0.95 / 1,000 |
| Publisher details (snippet, image, author), only when found | $1.00 / 1,000 | $0.90 / 1,000 | $0.80 / 1,000 | $0.60 / 1,000 |

Plus Apify's standard Actor start event ($0.00005 per run). Set a "Maximum cost per run" and the Actor stops cleanly when it is reached.

## Tips

- **Monitoring:** schedule the Actor daily with `timeRange: "1d"` and keep `deduplicate` on.
- **Exact names:** put brand or person names in quotes (`"Maia Sandu"`) to avoid loose matches.
- **One site only:** `site:reuters.com` in the query.
- **Speed over URLs:** turn `decodeUrls` off to get only the Google News links (they redirect to the article).

## FAQ

**Why did some rows have `urlDecoded: false`?** Google did not return the real URL for that article in time. The row keeps the `googleNewsUrl`, which opens the article in a browser. If decoding fails for 3 batches in a row, the run stops decoding and saves the remaining articles with their Google News links, instead of failing.

**Which proxy?** The default Apify proxy. The feeds are public, so no special proxy is needed. The Apify RESIDENTIAL and GOOGLE_SERP groups are not available in this Actor: if selected, the run uses the default proxy and says so in the log. You can use your own proxy URLs.

**Is it legal?** The Actor reads public feeds that Google publishes for news readers and collects headlines, links and dates. How you use the data (for example republishing articles) is your responsibility; respect publishers' copyright.
