# Google Hotels Scraper & Price API

**See what a hotel costs on Google Hotels for your dates, and what every booking site charges for the same room.** Type a city, a hotel name or paste a Google Hotels link; get the price per night and for the stay, taxes, rating, reviews and stars, and optionally the rate on Booking.com, Expedia, Hotels.com, Agoda, Trip.com, the hotel's official site and 30+ more.

- **What you get:** one row per hotel with prices, `cheapestProvider`, `officialSitePrice`, rating, address, GPS, phone and photos; with offers on, a list of every booking site's price
- **What it costs:** $3 per 1,000 hotels with a price (`$0.003` each), plus $2 per 1,000 hotels when you also load every booking site's price. Hotels without any price are **free**; failed runs cost only Apify's $0.00005 start fee.
- **Try it now:** the form is prefilled with `hotels in Paris`, 5 hotels and **every booking site's price** on (default dates: one night, 30 days from today, 2 adults). Click **Start**; the 5 hotels with all sites' prices cost about **$0.03**.

## Rate parity in one run: is the hotel's own website the cheapest?

Most hotels want their own website to be the cheapest place to book, but online travel agencies often sell the same room for less. Turn on **Include prices of every booking site** and compare `officialSitePrice` with `priceLowest` and `cheapestProvider`.

A real example from 8 Oct 2026 (`hotels in Paris`, 1 night on 7 Nov 2026, 2 adults, USD, 5 hotels with offers):

| Hotel | Google's price / night | Cheapest site | Cheapest price | Official site | Booking sites |
|---|---|---|---|---|---|
| Novotel Paris Est | $76.01 | Amimir.com | $76 | $118 | 21 |
| ibis Paris Porte d'Italie | $86.11 | Billabook.com | $86 | $97.69 | 21 |
| Hôtel Mercure Paris Porte d'Orléans | $97 | Pilot | $97 | $125 | 21 |
| Appart Hôtel - Residhome Paris Asnières Park | $78.24 | Amimir.com | $78 | $100.66 | 15 |
| St Christopher's Paris - Canal | $55.01 | St Christopher's Paris - Canal (official site) | $55 | $55 | 4 |

In 4 of 5 hotels a third-party site was cheaper than the official site, by about $12 to $42 a night. Prices change all the time; this is a snapshot of one run.

Input for the same check:

```json
{
  "queries": ["hotels in Paris"],
  "maxHotelsPerQuery": 5,
  "includeOffers": true,
  "currency": "USD"
}
```

To track **your own hotel and its competitors every day**, run one search, copy their `entityId`s (or `url`s) into **Google Hotels links** and schedule the run.

## Who it's for

- **Hotel revenue managers:** rate parity and competitor price checks every morning, for the dates that matter
- **Travel startups and analysts:** price research for any city and date (check Google's terms before republishing data)
- **Analysts:** price per night by city, date, star class and rating for reports and dashboards
- **AI agents:** "find a 4-star hotel in Lisbon under $150 for these dates" as one tool call

## Why this scraper

- **Fast and light:** plain HTTP requests with a real Chrome TLS fingerprint. No browser unless Google forces one.
- **Self-healing:** if Google shows a captcha, it retries on a new IP. If it shows the EU cookie consent page or blocks HTTP, it **automatically switches to a real Chrome browser**, which clicks through the consent page.
- **Two independent data paths:** the Google Hotels results page and Google's own internal hotel search endpoint. If one stops working, the other is used.
- **Clear logs:** every request logs the HTTP status, whether a consent or captcha page was detected, and which parser found the data. Unexpected pages are saved to the key-value store for inspection.
- **Fair pricing:** you pay per hotel with a price. Sold-out hotels without any price are free, and failed runs cost only Apify's $0.00005 start fee.

## What you can scrape

| Input | Example | You get |
|---|---|---|
| **Searches** | `hotels in Paris`, `hotels near Times Square` | Up to N hotels per search, in Google's order, across result pages |
| **Hotel names** | `Hotel Lutetia Paris` | The best-matching hotel |
| **Google Hotels links** | `https://www.google.com/travel/hotels/entity/ChoI…` | That exact hotel. This is the best input for daily price tracking. |

Set **check-in and check-out** (or a relative date like `+30 days`), **adults, children with ages, currency, language and country**. You can filter by **price per night, minimum rating and hotel class**.

## Quick start

The prefilled example (5 hotels in Paris with every booking site's price, default dates):

```json
{
  "queries": ["hotels in Paris"],
  "maxHotelsPerQuery": 5,
  "includeOffers": true
}
```

Without the booking sites' prices, the same search costs $3 per 1,000 hotels: set **Include prices of every booking site** off and raise **Max hotels per search**.

Your dates, guests and filters:

```json
{
  "queries": ["hotels near Times Square"],
  "hotelNames": ["Hotel Lutetia Paris"],
  "checkInDate": "2026-12-18",
  "checkOutDate": "2026-12-21",
  "adults": 2,
  "children": 1,
  "childrenAges": ["7"],
  "currency": "EUR",
  "minRating": "4",
  "hotelClass": ["4", "5"],
  "includeOffers": true,
  "maxHotelsPerQuery": 40
}
```

## Use it in n8n / Make / Zapier / Claude (MCP)

All four have an official Apify integration, so you need no custom code, only your Apify API token (Apify Console → Settings → API & Integrations).

**n8n**
1. Add the **Apify** node (n8n Cloud: search for it on the canvas; self-hosted: Settings → Community Nodes → install the Apify node).
2. Operation **Run Actor**, Actor `egra_van/google-hotels-prices`, input JSON as in the Quick start, **Wait for finish** on.
3. Add a second Apify node, operation **Get Dataset Items**, Dataset ID = `defaultDatasetId` from step 2.

**Make**
1. Add the **Apify → Run an Actor** module, choose *Google Hotels Scraper & Price API*, paste the input JSON and let it wait for the run to finish (synchronous run).
2. Add **Apify → Get Dataset Items** with the dataset ID from step 1, then e.g. **Google Sheets → Add a Row**.

**Zapier**
1. Action **Apify → Run Actor**: choose this Actor and paste the input JSON.
2. Action **Apify → Fetch Dataset Items** (or the trigger **Finished Actor Run** in a second Zap) and send each row to Google Sheets, Slack or email.

**Claude, ChatGPT, Cursor and other AI assistants (MCP)**
Add the Apify MCP server to your assistant (in Claude: add a custom connector with the URL below). To give the assistant only this tool, use:

```
https://mcp.apify.com?tools=egra_van/google-hotels-prices
```

Then ask, for example: *"Find 4-star hotels in Lisbon for 12-15 December for 2 adults, under $150 a night, and tell me which booking site is cheapest for each."*

## Output example

```json
{
  "query": "hotels in New York",
  "position": 1,
  "hotelName": "The Manhattan at Times Square Hotel",
  "entityId": "ChkIooCAqvyy0fDgARoML2cvMWhoZ18zbWdzEAE",
  "url": "https://www.google.com/travel/hotels/entity/ChkIooCAqvyy0fDgARoML2cvMWhoZ18zbWdzEAE/prices?...",
  "rating": 3,
  "reviews": 9928,
  "hotelClass": 4,
  "hotelClassText": "4-star hotel",
  "address": "790 7th Ave, New York, NY 10019",
  "lat": 40.7622856,
  "lng": -73.9826404,
  "priceLowest": 137.91,
  "pricePerNight": 137.91,
  "pricePerNightText": "$138",
  "pricePerNightWithTaxes": 161.75,
  "priceBeforeTaxes": 97.91,
  "taxes": 23.84,
  "fees": 40,
  "priceTotal": 161.75,
  "currency": "USD",
  "checkIn": "2026-04-27",
  "checkOut": "2026-04-28",
  "nights": 1,
  "dealLabel": "20% less than usual",
  "offersCount": 36,
  "cheapestProvider": "Vio.com",
  "officialSitePrice": 158,
  "offers": [
    { "provider": "Vio.com", "price": 138, "priceWithTaxes": 162, "priceTotal": 162, "isOfficialSite": false, "isSponsored": false, "url": "https://www.google.com/travel/clk?...", "directUrl": "https://deals.vio.com/..." },
    { "provider": "The Manhattan at Times Square Hotel", "price": 158, "priceWithTaxes": 185, "priceTotal": 185, "isOfficialSite": true, "directUrl": "https://www.ihg.com/..." },
    { "provider": "Booking.com", "price": 158, "priceWithTaxes": 184.81, "priceTotal": 184.81, "isOfficialSite": false }
  ],
  "thumbnail": "https://lh3.googleusercontent.com/...",
  "phone": "(212) 581-3300",
  "website": "https://www.ihg.com/spnd/hotels/us/en/new-york/nycat/hoteldetail",
  "checkInTime": "4:00 PM",
  "checkOutTime": "12:00 PM",
  "googleMapsUrl": "https://maps.google.com/?cid=16204309452407439394",
  "dataSource": "page/http+rpc:AtySUc",
  "scrapedAt": "2026-04-20T08:00:00.000Z"
}
```

### Price fields explained

- `pricePerNight`: the nightly price Google shows in the list for your country (`gl`). In the US this is **before taxes, including resort/service fees**. In many other countries Google already includes taxes.
- `pricePerNightWithTaxes`: nightly price with all taxes and fees. `priceBeforeTaxes`, `taxes` and `fees` are its parts.
- `priceTotal`: `pricePerNightWithTaxes × nights`.
- `priceLowest`: the lowest of Google's price and all loaded offers.
- `offers[].price` / `priceWithTaxes`: that booking site's nightly price. `isOfficialSite` marks the hotel's own website. `isSponsored` marks paid ads.
- `address` and `phone` are filled when offers are loaded or a hotel link is used. The list view does not contain them.
- `amenities` holds amenity names when Google includes them in text. `amenityCodes` holds Google's internal amenity IDs as returned.

## Pricing (pay per event)

| Event | When | Price |
|---|---|---|
| `hotel` | each hotel with a price saved to the dataset | $0.003 ($3 / 1,000 hotels) |
| `hotel-offers` | extra, when the per-booking-site offers of a hotel are loaded | $0.002 ($2 / 1,000 hotels) |

Example: 1,000 hotels with every booking site's price cost $5.00. Hotels without any price are saved for free. Discounts apply on Apify's paid plans (Bronze, Silver, Gold). Set **Maximum cost per run** in the run options: the scraper stops cleanly at that limit and never loads offers it cannot charge for.

## Proxies: important

Google blocks datacenter IPs quickly. What to expect:

| Proxy | Result |
|---|---|
| Default (Apify datacenter) | Works for small runs. Expect `captcha=YES` in the log after some requests. Every retry uses a new IP, and the browser fallback takes over when HTTP is blocked. |
| **Your own proxies** (proxy URLs) | Any provider, including residential IPs. You pay your provider directly. |

The Apify **RESIDENTIAL** and **GOOGLE_SERP** groups are not available in this Actor: if you select one, it is dropped and the log says so. The run continues on your other selected Apify proxy groups or, if none are left, on the default Apify proxy. If the proxy cannot be set up (for example, no Apify IPs for the chosen country), the run continues without a proxy and the log warns you. For residential or other IPs, use your own proxy URLs.

On the **Apify free plan** only a few shared datacenter IPs are available. Keep runs small (a few searches, 20-50 hotels) and schedule them apart.

## Tips

- **Tracking the same hotels daily:** run once with a search, copy the `entityId`s (or `url`s) of the hotels you care about into **Google Hotels links**, and schedule the run.
- **Rate parity:** turn on **Include prices of every booking site** and compare `officialSitePrice` with `priceLowest` / `cheapestProvider`.
- **Many dates:** run one task per date (the dates are part of each request). Schedules and the Apify API make this easy.
- **Children:** give their ages. Searches with children use Google's internal search endpoint, which accepts ages.

## How AI agents call this Actor

**Through the Apify MCP server** (Claude, ChatGPT, Cursor, VS Code, the n8n AI Agent): connect `https://mcp.apify.com?tools=egra_van/google-hotels-prices` and the agent sees this Actor as one tool, with its input schema. With the default `https://mcp.apify.com`, an agent finds Actors with `search-actors`, reads the input with `fetch-actor-details`, runs them with `call-actor` and reads the results with `get-dataset-items`.

**Through the REST API, in one HTTP call** (waits for the run and returns the dataset items):

```bash
curl -X POST "https://api.apify.com/v2/acts/egra_van~google-hotels-prices/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"queries":["hotels in Lisbon"],"checkInDate":"2026-12-12","checkOutDate":"2026-12-15","adults":2,"hotelClass":["4"],"maxPrice":150,"includeOffers":true,"maxHotelsPerQuery":10}'
```

**Agents that pay with crypto** can buy a prepaid Apify API token through [Apify AGI](https://docs.apify.com/platform/integrations/mcp) (x402) and use it with this Actor like any other token.

Tips for agents:

- Only one of `queries`, `hotelNames` or `hotelUrls` is needed; everything else has a default. Without dates the stay is 1 night, 30 days from today.
- Each item has `priceLowest`, `pricePerNight`, `priceTotal` and `currency`; with `includeOffers` also `cheapestProvider`, `officialSitePrice` and `offers[]`.
- Prices depend on `country` (where you search from), `currency`, dates and guests, exactly like on google.com.
- Set `maxTotalChargeUsd` in the run options to cap the cost; the scraper stops cleanly at the limit.

## Limitations

- Google Hotels is not an official API. Google can change its internal data format at any time, and the scraper is updated when that happens. The log always says which data path was used, so a change is easy to spot.
- Prices depend on the country you search from (`country`), dates, guests and currency, just like on google.com.
- The number of offers per hotel and their order are decided by Google.

## FAQ

**Is it legal?** The scraper collects publicly visible price information, like a person using Google Hotels. You are responsible for complying with Google's terms and the laws that apply to you, including when you republish data.

**Why did a run fail?** Open the log. Each request line shows `status`, `consent=`, `captcha=` and the parser used. `captcha=YES` on every retry means the proxy IPs are blocked: add your own proxies, keep the browser fallback on, and run fewer hotels at a time. Saved `DEBUG-…` pages in the key-value store show exactly what Google returned.

**Can I get more than ~20 hotels per search?** Yes. Raise **Max hotels per search**. The scraper follows Google's result pages (about 18-20 hotels each) up to **Max result pages per search**.
