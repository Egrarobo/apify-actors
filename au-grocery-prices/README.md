# Coles & Woolworths Scraper: Prices, Specials & Unit Prices

Search **Coles** and **Woolworths** (Australia) by keyword, category or product and get **prices, was-prices, unit prices, specials, promotions and stock** from both supermarkets in **one unified format**. Built for price-comparison apps, retail analysts, deal sites and anyone tracking specials.

The Actor reads the same JSON the two websites use, so every field is typed and complete. It handles the stores' bot protection with a real Chrome browser when needed, retries with new IPs and cookies when blocked, and reports every failed search as a clear error row instead of failing the whole run.

*Keywords: Coles scraper, Woolworths scraper, Australian grocery prices, supermarket price comparison, Woolies specials, Coles specials, half price, unit price, grocery price tracker API.*

## What you can do

- 🔎 **Search both stores at once** by keyword ("milk", "tim tam", "nappies")
- 🗂️ **Scrape whole categories** by pasting category links (sub-categories too)
- 🏷️ **Get all current specials**, or keep only specials from your searches (`onlySpecials`)
- 📦 **Check specific products** by link or product number
- ⚖️ **Compare fairly** with unit prices (`$1.34 per 100g`, `$0.38 / 100G`)
- 🧾 **One schema for both stores**: price, was-price, saving, promotion text, stock, category, image, link
- 💸 **Pay only for products returned**. Error rows are free.

## Quick start

**Compare a product across both stores:**

```json
{
  "searchTerms": ["full cream milk 2l", "tim tam"],
  "maxItemsPerSearch": 50
}
```

**All current specials of both stores:**

```json
{
  "onlySpecials": true,
  "maxItemsPerSearch": 2000
}
```

**A category, specials only:**

```json
{
  "categoryUrls": [
    "https://www.coles.com.au/browse/dairy-eggs-fridge",
    "https://www.woolworths.com.au/shop/browse/fruit-veg"
  ],
  "onlySpecials": true
}
```

**Track specific products (e.g. on a daily schedule):**

```json
{
  "productIds": [
    "https://www.woolworths.com.au/shop/productdetails/277728/woolworths-white-sandwich-bread-loaf",
    "https://www.coles.com.au/product/coles-cheese-shredded-tasty-light-700g-8145346",
    "woolworths:49622"
  ]
}
```

## Input

| Field | Default | What it does |
|---|---|---|
| `stores` | both | `coles`, `woolworths`. Applies to search terms, bare product numbers and "Only specials". Links always run on their own store. |
| `searchTerms` | – | Keywords; each is searched in every selected store. |
| `categoryUrls` | – | Category pages from coles.com.au (`/browse/...`, `/on-special`) or woolworths.com.au (`/shop/browse/...`, `/shop/browse/specials`). |
| `productIds` | – | Product links, `coles:1234567` / `woolworths:123456`, or bare numbers (looked up in every selected store). |
| `onlySpecials` | `false` | Keep only products on special. With nothing else filled in, returns the full specials lists. |
| `maxItemsPerSearch` | `100` | Max products saved per search term / category / specials list, per store. |
| `includeSponsored` | `false` | Also keep paid "sponsored/promoted" tiles (marked `isSponsored`). |
| `proxyConfiguration` | Apify Proxy | See **Proxies** below. |
| `useBrowserForCookies` | `true` | Pass Coles' bot protection with a real browser, then use fast JSON requests. |
| `browserFallback` | `true` | If fast requests keep getting blocked, fetch the JSON from inside the browser. |
| `maxPagesPerSearch` | `30` | Safety limit on result pages per search (48 per page on Coles, 36 on Woolworths). |
| `maxRetries`, `requestDelayMs` | `4`, `800` | Retries per request and average pause between requests. |
| `saveDebugPages` | `true` | Save block pages/screenshots as `DEBUG-*` records for diagnosis. |
| `includeRaw` | `false` | Add the store's original product object as `raw`. |

## Output

One item per product. Example output:

```json
[
  {
    "store": "coles",
    "productId": "8145346",
    "name": "Coles Cheese Shredded Tasty Light",
    "brand": "Coles",
    "size": "700g",
    "price": 9.5,
    "wasPrice": null,
    "savings": null,
    "unitPrice": 13.57,
    "unitPriceMeasure": "1kg",
    "unitPriceText": "$13.57 per 1kg",
    "isOnSpecial": false,
    "promoType": "EVERYDAY",
    "promoText": null,
    "inStock": true,
    "isSponsored": false,
    "category": "Dairy, Eggs & Fridge > Cheese > Grated Cheese",
    "barcode": null,
    "imageUrl": "https://productimages.coles.com.au/productimages/8/8145346.jpg",
    "url": "https://www.coles.com.au/product/coles-cheese-shredded-tasty-light-700g-8145346",
    "currency": "AUD",
    "searchTerm": "cheese",
    "categoryUrl": null,
    "scrapedAt": "2026-09-27T08:30:00.588Z"
  },
  {
    "store": "woolworths",
    "productId": "49622",
    "name": "Golden Crumpets Round 6 pack",
    "brand": "Golden",
    "size": "6 pack",
    "price": 2,
    "wasPrice": 4.8,
    "savings": 2.8,
    "unitPrice": 0.33,
    "unitPriceMeasure": "1EA",
    "unitPriceText": "$0.33 / 1EA",
    "isOnSpecial": true,
    "promoType": "HALF_PRICE",
    "promoText": "Half price · Save $2.80",
    "inStock": true,
    "isSponsored": false,
    "category": "Bakery > Packaged Bread & Bakery",
    "barcode": "9310043003014",
    "imageUrl": "https://cdn1.woolworths.media/content/wowproductimages/large/049622.jpg",
    "url": "https://www.woolworths.com.au/shop/productdetails/49622/golden-crumpets-round",
    "currency": "AUD",
    "searchTerm": "crumpets",
    "categoryUrl": null,
    "scrapedAt": "2026-09-27T08:30:00.588Z"
  }
]
```

| Field | Meaning |
|---|---|
| `price` | Current shelf price in AUD (`null` if the store shows no price, e.g. unavailable). |
| `wasPrice`, `savings` | Only filled when the product is really discounted (`wasPrice > price`). |
| `unitPrice`, `unitPriceMeasure`, `unitPriceText` | The store's comparable unit price. |
| `isOnSpecial`, `promoType`, `promoText` | Special flag, type (Coles: `SPECIAL`, `DOWNDOWN`, `EVERYDAY`…; Woolworths: `HALF_PRICE`, `SPECIAL`) and the promotion wording. |
| `inStock` | Whether the product can be bought online. |
| `isSponsored` | Paid placement (only output if `includeSponsored`). |
| `barcode` | EAN/GTIN (Woolworths). |
| `searchTerm` / `categoryUrl` / `productInput` | Which of your inputs produced the row. |

**Error rows** (free) have `isError: true`, the input that failed, `error`, `errorStep`, `httpStatus`, `blocked` and `blockMarkers` — so integrations know exactly which search failed and why. The dataset has three views: **Products**, **Specials & savings** and **Errors**. A run summary (products, requests, retries, blocks, method used per store) is saved as `OUTPUT` in the key-value store.

## Proxies and reliability

Both supermarkets protect their sites against bots (Coles: Imperva; Woolworths: Akamai). The Actor:

1. opens the Coles homepage once in a **real Chrome browser** (with a virtual display, not headless) to pass the check and collect cookies, then loads products with fast JSON requests using those cookies;
2. uses fast plain requests for Woolworths;
3. when a request is blocked: re-acquires cookies → switches to a new IP → loads the JSON **from inside the browser**, and logs every step (HTTP status, what block page was detected, exit IP).

The default **Apify Proxy** works for most runs. If the log shows `BLOCKED` for every attempt, choose proxy group **RESIDENTIAL** with country **Australia (AU)** — residential Australian IPs are the most reliable option, especially for Coles.

## How AI agents call this Actor

**Through the Apify MCP server** (Claude, ChatGPT, Cursor, VS Code, the n8n AI Agent): connect `https://mcp.apify.com?tools=egra_van/au-grocery-prices` and the agent sees this Actor as one tool, with its input schema. With the default `https://mcp.apify.com`, an agent finds Actors with `search-actors`, reads the input with `fetch-actor-details`, runs them with `call-actor` and reads the results with `get-dataset-items`.

**Through the REST API, in one HTTP call** (waits for the run and returns the dataset items):

```bash
curl -X POST "https://api.apify.com/v2/acts/egra_van~au-grocery-prices/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms": ["milk"]}'
```

**Agents without an Apify account** can pay per run through Apify's [agentic payments](https://docs.apify.com/platform/integrations/x402) (x402, Skyfire).

Tips for agents:

- The JSON above is a complete, working input; every other field has a default (see the input section above).
- Set `maxTotalChargeUsd` in the run options to cap the cost of a run.

## Pricing

Pay per event: **$1.00 per 1,000 products** saved (`product` event). Error rows, retries, blocked attempts and the browser warm-up are not charged. Set a maximum cost per run and the Actor stops cleanly when it is reached.

## Good to know

- Prices are the stores' **default online prices** (Coles online store 0584, Woolworths national online catalogue). Prices of individual physical stores or delivery postcodes can differ slightly and are not selected by this Actor.
- Search results are ranked by the store; sponsored tiles are removed by default and products are de-duplicated per search.
- Woolworths "Everyday Market" (third-party marketplace) items can appear in search results like on the website.
- Data is publicly visible on the stores' websites; use it in line with the stores' terms and applicable law.

## FAQ

**Why did a search return fewer products than `maxItemsPerSearch`?** The store had fewer results, `onlySpecials` filtered them, or `maxPagesPerSearch` was reached (the log says which).

**A run shows "BLOCKED" in the log.** That is the store's bot protection; the Actor retries automatically. If a search still fails, it appears as an error row with the detected block page. Use the RESIDENTIAL proxy with country AU and slow down by raising `requestDelayMs` to 1500–3000 ms.

**Can I get Aldi or IGA?** Not yet — planned.
