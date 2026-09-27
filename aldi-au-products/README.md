# ALDI Australia Scraper – Products, Prices & Special Buys

Scrape **ALDI Australia** ([aldi.com.au](https://www.aldi.com.au)) by keyword, category, **Special Buys** date or product and get **prices, unit prices, price drops, Super Savers, Lower Prices, Special Buys, categories and images** in one clean, typed format. Built for price-comparison apps, grocery price trackers, deal sites and retail analysts.

The Actor reads the same JSON API the ALDI website uses (no HTML parsing), so every field is complete and typed. It retries with new IPs when blocked, can fall back to a real Chrome browser, and reports every failed search as a clear error row instead of failing the whole run.

*Keywords: ALDI scraper, ALDI Australia API, ALDI Special Buys, ALDI prices, Australian grocery prices, supermarket price comparison, unit price, Super Savers, grocery price tracker.*

## What you can do

- 🔎 **Search** ALDI's range by keyword ("milk", "coffee pods", "nappies")
- 🗂️ **Scrape whole categories** by pasting category links (sub-categories too)
- 🛍️ **Get Special Buys** for any Wednesday/Saturday drop — or all current and upcoming ones at once
- 🏷️ **Only specials**: Special Buys, Super Savers, Lower Prices and price drops
- 📦 **Track specific products** by link or product number (e.g. on a daily schedule)
- ⚖️ **Compare fairly** with unit prices (`$0.71 per 100g`)
- 🔗 **Same schema as our Coles & Woolworths Actor** — combine the datasets for a full Australian price comparison
- 💸 **Pay only for products returned.** Error rows are free.

## Quick start

**Search:**

```json
{ "searchTerms": ["milk", "coffee pods"], "maxItemsPerSearch": 50 }
```

**All current & upcoming Special Buys, Super Savers and Lower Prices:**

```json
{ "onlySpecials": true, "maxItemsPerSearch": 500 }
```

**Categories and a Special Buys day:**

```json
{
  "categoryUrls": [
    "https://www.aldi.com.au/products/dairy-eggs-fridge/k/960000000",
    "https://www.aldi.com.au/special-buys/2026-09-30"
  ]
}
```

**Track products daily:**

```json
{ "productIds": ["https://www.aldi.com.au/product/lodge-farms-cage-eggs-700g-000000000000399451", "704511"] }
```

## Input

| Field | Default | What it does |
|---|---|---|
| `searchTerms` | – | Keywords to search. |
| `categoryUrls` | – | Category pages (`/products/…/k/…`), Special Buys days (`/special-buys/YYYY-MM-DD`), Super Savers or Lower Prices. |
| `productIds` | – | Product links or ALDI product numbers (`399451` or `000000000000399451`). |
| `onlySpecials` | `false` | Keep only specials. With nothing else filled in: last 2 + next 2 Special Buys days, Super Savers and Lower Prices. |
| `maxItemsPerSearch` | `100` | Max products saved per search term / category / list. |
| `sortBy` | `relevance` | Relevance, price or name order. |
| `storeId` | automatic | ALDI store code sent to the API. Prices are national, so leave it empty. |
| `proxyConfiguration` | Apify Proxy | See **Proxies**. |
| `useBrowserForCookies` | `false` | Start with cookies from a real browser (only if the log shows blocks). |
| `browserFallback` | `true` | If requests keep getting blocked, load the data from inside a real browser. |
| `maxPagesPerSearch`, `maxRetries`, `requestDelayMs` | `30`, `4`, `500` | Safety limits and pacing. |
| `saveDebugPages` | `true` | Save block pages / screenshots as `DEBUG-*` records. |
| `includeRaw` | `false` | Add ALDI's original product object as `raw`. |

## Output

```json
{
  "store": "aldi",
  "productId": "000000000000704511",
  "name": "BELMONT Choc Tim Tam Original Biscuits 200g",
  "brand": "BELMONT",
  "size": "200g",
  "price": 3.49,
  "wasPrice": 3.99,
  "savings": 0.5,
  "unitPrice": 1.75,
  "unitPriceMeasure": "100 g",
  "unitPriceText": "$1.75 per 100 g",
  "loyaltyPrice": null,
  "isOnSpecial": true,
  "promoType": "PRICE_DROP",
  "promoText": "Save $0.50 · Was $3.99",
  "availableFrom": null,
  "inStock": true,
  "category": "Snacks & Confectionery",
  "badges": [],
  "imageUrl": "https://dm…aldi.cx/is/image/…/product/jpg/scaleWidth/600/…",
  "url": "https://www.aldi.com.au/product/belmont-choc-tim-tam-original-biscuits-200g-000000000000704511",
  "currency": "AUD",
  "searchTerm": "tim tam",
  "categoryUrl": null,
  "scrapedAt": "2026-09-27T08:30:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `price` | Shelf price in AUD (for weight-priced goods: the price ALDI charges). |
| `wasPrice`, `savings` | Only when ALDI shows a struck-through price. |
| `unitPrice`, `unitPriceText` | ALDI's comparable unit price. |
| `isOnSpecial`, `promoType` | `SPECIAL_BUY`, `SUPER_SAVER`, `LOWER_PRICE`, `PRICE_DROP`, `PROMOTION` or `LIMITED_TIME` (not counted as special). |
| `availableFrom` | Special Buys on-sale date text. |
| `inStock` | ALDI sells groceries in store only, so this is `false` only for discontinued products. |
| `loyaltyPrice` | Always `null` (ALDI has no loyalty pricing); kept for a schema shared with our Coles/Woolworths and Tesco Actors. |

**Error rows** (free) have `isError: true`, the failing input, `error`, `errorStep`, `httpStatus`, `blocked` and `blockMarkers`. Dataset views: **Products**, **Specials & savings**, **Errors**. The run summary (requests, retries, blocks, method, store used) is saved as `OUTPUT` in the key-value store.

## Proxies and reliability

The Actor uses fast plain HTTP requests to ALDI's JSON API. When a request is blocked it switches headers and IP, then (if `browserFallback` is on) loads the data from inside a real Chrome browser — and logs every step (HTTP status, detected block page, exit IP). The default **Apify Proxy** should work; if the log shows `BLOCKED` on every attempt, use proxy group **RESIDENTIAL** with country **AU**.

## Pricing

Pay per event: **$1.00 per 1,000 products** saved (`product` event). Error rows, retries and blocked attempts are free. Set a maximum cost per run and the Actor stops cleanly when it is reached.

## Good to know

- ALDI Australia does not sell groceries online; this is ALDI's **online product catalogue** with national shelf prices. Individual stores can differ, and Special Buys are "while stocks last".
- Special Buys drop on Wednesdays and Saturdays; upcoming days appear a few days before.
- Data is publicly visible on aldi.com.au; use it in line with ALDI's terms and applicable law. Not affiliated with ALDI.
