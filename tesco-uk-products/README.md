# Tesco Scraper – UK Grocery Prices & Clubcard Prices

Scrape **Tesco UK** groceries ([tesco.com](https://www.tesco.com/groceries/)) by keyword, category or product and get **prices, Clubcard Prices, unit prices, offers, availability, images and Tesco IDs (TPNC / TPNB)** in one clean, typed format. Built for price-comparison apps, grocery price trackers, deal sites and retail analysts.

The Actor reads Tesco's own **product API** (the GraphQL service the website uses) instead of the bot-protected web pages, so it is fast, returns typed data and usually works **without residential proxies**. When a request is blocked it retries with a new IP and can fall back to a real Chrome browser; every failed search becomes a clear error row instead of failing the whole run.

*Keywords: Tesco scraper, Tesco API, Tesco prices, Clubcard Prices, UK grocery prices, supermarket price comparison, unit price, Tesco offers, grocery price tracker.*

## What you can do

- 🔎 **Search** Tesco by keyword ("semi skimmed milk", "nappies")
- 🗂️ **Scrape categories** by pasting category links (departments, aisles)
- 💳 **Clubcard Prices**: every product's member price in `loyaltyPrice`; keep only Clubcard deals with one switch
- 🏷️ **Only offers**: Clubcard Prices, multibuys, price cuts — or scan all departments for offers
- 📦 **Track specific products** by link or product ID (e.g. on a daily schedule)
- ⚖️ **Compare fairly** with unit prices (`£0.73/litre`)
- 🔗 **Same schema as our Coles & Woolworths and ALDI Australia Actors**
- 💸 **Pay only for products returned.** Error rows are free.

## Quick start

```json
{ "searchTerms": ["semi skimmed milk", "bananas"], "maxItemsPerSearch": 50 }
```

**All Clubcard Prices (scans every department):**

```json
{ "onlyClubcardPrices": true, "maxItemsPerSearch": 1000 }
```

**Categories and products:**

```json
{
  "categoryUrls": ["https://www.tesco.com/shop/en-GB/browse/fresh-food/all"],
  "productIds": ["https://www.tesco.com/shop/en-GB/products/254656543", "282822189"]
}
```

## Input

| Field | Default | What it does |
|---|---|---|
| `searchTerms` | – | Keywords to search. |
| `categoryUrls` | – | Category pages (`/shop/en-GB/browse/…`, `/groceries/en-GB/shop/…`, or any link with `facet=`). |
| `productIds` | – | Product links or Tesco product IDs. |
| `onlySpecials` | `false` | Keep only products with an offer. With nothing else filled in: scan all departments. |
| `onlyClubcardPrices` | `false` | Keep only Clubcard Price deals (same all-departments scan when nothing else is filled in). |
| `maxItemsPerSearch` | `100` | Max products saved per search term / category / department. |
| `proxyConfiguration` | Apify Proxy | See **Proxies**. |
| `useBrowserForCookies` | `false` | Start with cookies from a real browser (only if the log shows blocks). |
| `browserFallback` | `true` | Load data from inside a real browser if requests keep getting blocked; also used to read a rotated API key. |
| `apiKey` | built-in | Tesco's public API key; found automatically if Tesco changes it. |
| `maxPagesPerSearch`, `maxRetries`, `requestDelayMs` | `30`, `4`, `1000` | Safety limits and pacing (Tesco rate-limits bursts). |
| `saveDebugPages`, `includeRaw` | `true`, `false` | Diagnosis helpers. |

## Output

```json
{
  "store": "tesco",
  "productId": "254656543",
  "tpnb": "54550994",
  "gtin": "5000000000000",
  "name": "Tesco British Semi Skimmed Milk 2.272L, 4 Pints",
  "brand": "TESCO",
  "size": "2.272L, 4 Pints",
  "price": 1.65,
  "wasPrice": null,
  "savings": null,
  "unitPrice": 0.73,
  "unitPriceMeasure": "litre",
  "unitPriceText": "£0.73/litre",
  "loyaltyPrice": 1.45,
  "isOnSpecial": true,
  "promoType": "CLUBCARD_PRICE",
  "promoText": "£1.45 Clubcard Price",
  "promoEndDate": null,
  "inStock": true,
  "category": "Fresh Food > Milk, Butter & Eggs > Milk > Fresh Milk",
  "imageUrl": "https://digitalcontent.api.tesco.com/v2/media/ghs/…jpeg?h=225&w=225",
  "url": "https://www.tesco.com/shop/en-GB/products/254656543",
  "currency": "GBP",
  "searchTerm": "milk",
  "categoryUrl": null,
  "scrapedAt": "2026-09-27T08:30:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `productId` / `tpnb` / `gtin` | Tesco product number used in links (TPNC), Tesco base product number, barcode (when Tesco provides it). |
| `price` | Shelf price in GBP. |
| `loyaltyPrice` | Clubcard Price per item (`null` without one; multibuy Clubcard deals are in `promoText`). |
| `wasPrice`, `savings` | Only for real price cuts ("Was £x Now £y"). |
| `promoType` | `CLUBCARD_PRICE`, `CLUBCARD_MULTIBUY`, `MULTIBUY`, `PRICE_CUT`, `OFFER` (comma-separated if several). |
| `inStock` | Tesco's "for sale" flag (national, not store-specific). |
| `category` | Department > aisle > shelf, when Tesco's API provides it. |

**Error rows** (free) have `isError: true`, the failing input, `error`, `errorStep`, `httpStatus`, `blocked` and `blockMarkers`. Dataset views: **Products**, **Offers & Clubcard Prices**, **Errors**. The run summary (requests, retries, blocks, method, API key source) is saved as `OUTPUT` in the key-value store.

## Proxies and reliability

tesco.com is protected by Akamai and blocks many datacenter IPs — that is why most Tesco scrapers need residential proxies. This Actor reads Tesco's product API, which answers normal requests, so the default **Apify Proxy** is enough in most runs. If the log shows `BLOCKED` on every attempt, use proxy group **RESIDENTIAL** with country **GB** (the in-browser fallback also needs the website to load, which works best from UK residential IPs).

## Pricing

Pay per event: **$1.50 per 1,000 products** saved (`product` event). Error rows, retries and blocked attempts are free. Set a maximum cost per run and the Actor stops cleanly when it is reached.

## Good to know

- Prices are Tesco's national online prices (no delivery postcode or store is selected). Clubcard Prices need a Clubcard at checkout.
- Only Tesco UK groceries (tesco.com). Tesco Ireland uses different API credentials.
- Data is publicly visible on tesco.com; use it in line with Tesco's terms and applicable law. Not affiliated with Tesco.
