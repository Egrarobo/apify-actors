# Google Ads Transparency Scraper: Ads by Country

**See every ad a company runs on Google: Search, Display, Shopping and YouTube.** Type a website (`nike.com`), an advertiser name (`Nike, Inc.`) or an advertiser ID, and get one row per ad from the public [Google Ads Transparency Center](https://adstransparency.google.com): format, the countries where it was shown, the first and last day it was shown, the image or preview of the ad and a link to its page.

- **What you get:** advertiser, ad ID, format (`TEXT`, `IMAGE`, `VIDEO`), `firstShown`, `lastShown`, `regions` (country codes and names), `imageUrl` / `previewUrl` / `videoUrl`, `adUrl`, plus every version of the ad.
- **What it costs:** $1.20 per 1,000 ads stored (`$0.0012` each), countries and versions included. Lower on paid Apify plans (down to $0.70 per 1,000). Searches that find nothing cost only Apify's $0.00005 start fee.
- **Try it now:** the form is prefilled with `nike.com`, region `US` and 10 ads. Click **Start**; it takes about half a minute and costs about **$0.01**.

## Who it's for

- **Marketing agencies** checking what a client's competitors advertise, in which countries, and since when.
- **Advertisers** looking for ad ideas: which messages a competitor keeps running for months (a sign they work).
- **Researchers and journalists** studying who advertises what, where.

## What you can search

| You type | What you get |
|---|---|
| A domain: `nike.com`, `https://www.nike.com/shoes` | ads of **every advertiser** that sends people to this website (resellers and agencies included) |
| An advertiser name: `Nike, Inc.` | ads of the advertiser with **exactly this name** and the most ads. The log lists other advertisers with a similar name and their IDs. |
| An advertiser ID: `AR16735076323512287233`, or a Transparency Center link | ads of that one advertiser (most precise) |

Filters, all optional:

- **Region:** a 2-letter country code (`US`, `GB`, `DE`, `IN`...) or `anywhere`.
- **Period:** any time, last 7 / 30 / 90 days, or custom dates. Google keeps the day-by-day data for about the last 12 months; older periods return no ads.
- **Format:** text, image or video.
- **Max ads per domain / advertiser.**

## Quick start

```json
{
  "searchTerms": ["nike.com", "AR16735076323512287233"],
  "region": "US",
  "period": "last30days",
  "format": "all",
  "maxAdsPerQuery": 100
}
```

Run it from the API:

```bash
curl -X POST "https://api.apify.com/v2/acts/egra_van~google-ads-transparency/run-sync-get-dataset-items?token=YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"searchTerms": ["nike.com"], "region": "US", "maxAdsPerQuery": 20}'
```

## Output

One ad of `nike.com` as read from the Transparency Center on 8 Oct 2026 (text ad, archived by Google as a picture):

```json
{
  "searchTerm": "nike.com",
  "advertiserName": "Nike, Inc.",
  "advertiserId": "AR16735076323512287233",
  "adId": "CR16080400334098268161",
  "format": "TEXT",
  "firstShown": "2023-11-16T23:49:45.279Z",
  "imageUrl": "https://tpc.googlesyndication.com/archive/simgad/12353189800749445678",
  "adUrl": "https://adstransparency.google.com/advertiser/AR16735076323512287233/creative/CR16080400334098268161?region=US"
}
```

| Field | Meaning |
|---|---|
| `advertiserName`, `advertiserId` | the verified advertiser (one domain can have several) |
| `adId` | the ad's ID in the Transparency Center (`CR...`) |
| `format` | `TEXT` (Google Search), `IMAGE` (Display, Shopping), `VIDEO` (YouTube) |
| `firstShown`, `lastShown` | first and last time Google showed the ad (UTC). The Center counts from its own start of records, so very old ads start there. |
| `regions`, `regionNames`, `regionCount` | countries where the ad was shown (with **Add countries and all variants** on, the default) |
| `imageUrl` | picture of the ad. Google archives text ads as a picture of the ad, so the headline and text are in this image. |
| `previewUrl` | Google's preview script for image and video ads (opens the rendered ad) |
| `videoUrl` | YouTube link, when Google exposes it |
| `variants` | every version of the ad (images or previews) |
| `adUrl`, `advertiserUrl` | the ad and the advertiser in the Transparency Center |

The run summary (key-value store, record `OUTPUT`) lists, for each search, the advertiser found, how many ads Google reports for your filters, how many were stored, and any error.

## Pricing (pay per event)

| Apify plan | Per 1,000 ads |
|---|---|
| Free | $1.20 |
| Starter (Bronze) | $1.00 |
| Scale (Silver) | $0.85 |
| Business (Gold) | $0.70 |

Countries and all versions of each ad are included. You pay only for ads stored; you can set a maximum cost per run in Apify and the Actor stops there.

## Speed and Google's limits

The Actor reads only what the Transparency Center shows to any visitor, without logging in. It sends **one request at a time with a pause of 2 seconds** (you can make it longer). With countries on, that is about 2 seconds per ad: 100 ads take about 3–4 minutes, 1,000 ads about 35 minutes. Turn **Add countries and all variants** off to go about 20 times faster (one request per 40 ads), without the country list.

If Google answers with its "unusual traffic" page, the Actor waits (30 s, 60 s, 120 s) and tries again **on the same IP**. It never solves captchas and never switches IP to get around a block. If Google still refuses, the run stops and keeps the ads already read. The Apify RESIDENTIAL and GOOGLE_SERP proxy groups are not available in this Actor; you can add your own proxy URLs.

## Limitations

- **Ad text:** Google stores text ads as a picture (`imageUrl`), not as text. The Actor does not read text out of pictures.
- **Dates:** only about the last 12 months can be filtered by period.
- **Names:** an advertiser name search picks one advertiser. Big brands have several (per country, per agency); use the domain to get them all, or the IDs from the log.
- **Counts** reported by Google are rounded ranges (e.g. 8,000–9,000).
- Political ads have their own section in the Transparency Center and are not covered.

## FAQ

**Is this legal?** The Transparency Center is a public page Google publishes so anyone can see who advertises what (and, in the EU, because the Digital Services Act requires an ad repository). The Actor reads only public data, slowly, without an account. Check your own use case with your lawyer.

**Why does a domain return ads from other companies?** Google lists every verified advertiser whose ads send people to that domain: resellers, affiliates and agencies too. Use the advertiser ID to get one company only.

**Why fewer ads than Google reports?** You reached **Max ads per domain / advertiser**, or your maximum cost per run. Raise either.
