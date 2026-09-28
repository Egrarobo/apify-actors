# Google Hotels Scraper: Prices, Rate Parity & OTA Offers

Get **hotel prices from Google Hotels** for any city, landmark, hotel name or Google Hotels link, **for your exact dates and guests**: price per night, price with taxes and fees, total for the stay, deals ("20% less than usual"), guest rating, number of reviews, star class, GPS, photos, and optionally **the price on every booking site** Google compares: Booking.com, Expedia, Agoda, Hotels.com, Trip.com, the hotel's official site and 30+ more.

Built for **revenue managers, rate-parity checks, travel startups, price comparison sites and analysts** who need data that arrives on every run.

## Why this scraper

- **Fast and light:** plain HTTP requests with a real Chrome TLS fingerprint. No browser unless Google forces one.
- **Self-healing:** if Google shows a captcha, it retries on a new IP. If it shows the EU cookie consent page or blocks HTTP, it **automatically switches to a real Chrome browser**, which clicks through the consent page.
- **Two independent data paths:** the Google Hotels results page and Google's own internal hotel search endpoint. If one stops working, the other is used.
- **Clear logs:** every request logs the HTTP status, whether a consent or captcha page was detected, and which parser found the data. Unexpected pages are saved to the key-value store for inspection.
- **Fair pricing:** you pay per hotel with a price. Sold-out hotels without any price are free, and failed runs cost nothing.

## What you can scrape

| Input | Example | You get |
|---|---|---|
| **Searches** | `hotels in Paris`, `hotels near Times Square` | Up to N hotels per search, in Google's order, across result pages |
| **Hotel names** | `Hotel Lutetia Paris` | The best-matching hotel |
| **Google Hotels links** | `https://www.google.com/travel/hotels/entity/ChoI…` | That exact hotel. This is the best input for daily price tracking. |

Set **check-in and check-out** (or a relative date like `+30 days`), **adults, children with ages, currency, language and country**. You can filter by **price per night, minimum rating and hotel class**.

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
| `hotel` | each hotel with a price saved to the dataset | $0.0025 ($2.50 / 1,000 hotels) |
| `hotel-offers` | extra, when the per-booking-site offers of a hotel are loaded | $0.0035 ($3.50 / 1,000 hotels) |

Example: 1,000 hotels with every booking site's price cost $6.00. Hotels without any price are saved for free. Set **Maximum cost per run** in the run options: the scraper stops cleanly at that limit and never loads offers it cannot charge for.

## Proxies: important

Google blocks datacenter IPs quickly. What to expect:

| Proxy | Result |
|---|---|
| **GOOGLE_SERP** (Apify proxy group) | Best value for Google. Requests are sent to `http://www.google.com` as this proxy requires. |
| **RESIDENTIAL** (Apify proxy group) | Very reliable, charged per GB. Pages are compressed and the browser does not load images, so traffic stays low. |
| Default (shared datacenter) | Works for small runs. Expect `captcha=YES` in the log after some requests. Every retry uses a new IP, but the pool is small. |

On the **Apify free plan** only a few shared datacenter IPs are available, and GOOGLE_SERP and RESIDENTIAL are not included. Keep runs small (a few searches, 20-50 hotels) and schedule them apart.

## Tips

- **Tracking the same hotels daily:** run once with a search, copy the `entityId`s (or `url`s) of the hotels you care about into **Google Hotels links**, and schedule the run.
- **Rate parity:** turn on **Include prices of every booking site** and compare `officialSitePrice` with `priceLowest` / `cheapestProvider`.
- **Many dates:** run one task per date (the dates are part of each request). Schedules and the Apify API make this easy.
- **Children:** give their ages. Searches with children use Google's internal search endpoint, which accepts ages.

## Limitations

- Google Hotels is not an official API. Google can change its internal data format at any time, and the scraper is updated when that happens. The log always says which data path was used, so a change is easy to spot.
- Prices depend on the country you search from (`country`), dates, guests and currency, just like on google.com.
- The number of offers per hotel and their order are decided by Google.

## FAQ

**Is it legal?** The scraper collects publicly visible price information, like a person using Google Hotels. You are responsible for complying with Google's terms and the laws that apply to you, including when you republish data.

**Why did a run fail?** Open the log. Each request line shows `status`, `consent=`, `captcha=` and the parser used. `captcha=YES` on every retry means the proxy IPs are blocked: switch to the GOOGLE_SERP or RESIDENTIAL proxy. Saved `DEBUG-…` pages in the key-value store show exactly what Google returned.

**Can I get more than ~20 hotels per search?** Yes. Raise **Max hotels per search**. The scraper follows Google's result pages (about 18-20 hotels each) up to **Max result pages per search**.
