# Prozorro.Sale Ukraine Auctions: privatization, lease, land & bankrupt assets

Search, track and get alerts for **Ukrainian public auctions on [Prozorro.Sale](https://prozorro.sale)**, the official state e-auction system. It covers **small and large privatization**, **state and municipal property lease**, **land rental and land sale**, **bankruptcy assets**, **bank assets and non-performing loans (NPL)** from the Deposit Guarantee Fund, timber, subsoil and other procedures.

Data comes from the **official Prozorro.Sale open-data API** (no scraping, no login, no proxies). Every auction is returned as one clean record with **English field names**, starting price, minimal step, guarantee, bidding deadline, auction date, organizer, items with CAV/CPV codes and addresses, **document download links**, and, for finished auctions, **the winner and final price**. Each record links to its public auction page.

## Українською коротко

**Що це:** інструмент для пошуку та моніторингу аукціонів **Prozorro.Sale** — мала та велика приватизація, оренда державного й комунального майна, оренда та продаж землі, активи банкрутів, активи банків і NPL від ФГВФО.

**Що ви отримуєте:** по кожному аукціону — назва лота, стартова ціна, мінімальний крок, гарантійний внесок, дати подання пропозицій і аукціону, організатор, адреси та класифікатори, посилання на документи, а для завершених — переможець і фінальна ціна. Дані беруться з **офіційного відкритого API Prozorro.Sale**.

**Моніторинг:** вкажіть назву монітора (`monitorName`) і фільтри (тип аукціону, регіон, ключові слова, ціна) — і отримуйте лише **нові** аукціони в Telegram, Slack, email або через webhook. Запускайте за розкладом (наприклад, щогодини) у розділі Schedules.

**Оплата:** лише за отримані результати — див. розділ *Pricing* нижче.

## What you can do

- 🔎 **Search auctions** by auction type (selling method), status, region or city, CAV/CPV classification code, keywords (Ukrainian or English), starting price range, publication date and auction date.
- 📄 **Get full details** for a list of auction IDs such as `LRE001-UA-20260916-77195`: lots and items, prices, deadlines, documents, bids, winner, contract and final price.
- 🔔 **Monitor new auctions**: run on a schedule and get only auctions you have not seen before, with alerts on **Telegram, Slack, email or any webhook** (Make, Zapier, n8n).
- 🤖 **Use it from AI agents and automations**: flat, predictable JSON with English keys, explicit scan coverage in `OUTPUT`, and clear error messages.

Typical users: real-estate and land investors, agribusinesses looking for land to rent, lawyers and bankruptcy trustees, NPL buyers, analysts and journalists following privatization.

## Quick start

**Open land-rental auctions in Kyiv oblast under 100,000 UAH:**

```json
{
  "sellingMethods": ["landRental"],
  "openForBidsOnly": true,
  "regions": ["Київська"],
  "maxPrice": 100000
}
```

**Small privatization of real estate (CAV 04) published in September 2026:**

```json
{
  "sellingMethods": ["smallPrivatization"],
  "classificationCodes": ["04"],
  "publishedFrom": "2026-09-01",
  "publishedTo": "2026-09-30",
  "maxResults": 0
}
```

**Details for specific auctions:**

```json
{
  "mode": "details",
  "auctionIds": ["LRE001-UA-20260916-77195", "SPE001-UA-20260920-34951"]
}
```

**Daily Telegram alert about new lease offers in Lviv:**

```json
{
  "monitorName": "lviv-lease",
  "sellingMethods": ["legitimatePropertyLease"],
  "regions": ["Львів"],
  "telegramBotToken": "123456:ABC-your-bot-token",
  "telegramChatId": "123456789"
}
```

Schedule this task (for example every hour or every morning). The first run only remembers the current auctions; every later run reports the new ones.

## Filters

All filters are optional and combined with AND. Inside one list, any value may match.

| Input | Meaning |
|---|---|
| `sellingMethods` | Auction types. A family such as `landRental`, `smallPrivatization`, `legitimatePropertyLease`, `landSell`, `basicSell`, `bankRuptcy`, `largePrivatization`, `timber`, `subsoil`, `nonperformingLoans` covers all its formats (english, dutch, …); an exact value like `landRental-english` matches only that one. Run with `"mode": "types"` for the full, current list with auction ID prefixes (free). |
| `statuses` | `active_rectification`, `active_tendering`, `active_auction`, `active_qualification`, `qualification`, `active_awarded`, `pending_payment`, `pending_admission`, `complete`, `unsuccessful`, `cancelled`. |
| `openForBidsOnly` | Shortcut for auctions you can still bid on (`active_rectification`, `active_tendering`). |
| `keywords` | All words must appear in the title, description, item descriptions or address. Ukrainian works best (e.g. `нежитлове приміщення`); English titles are searched too. |
| `regions` | Part of an oblast or settlement name in Ukrainian: `Київ`, `Львівська`, `Одеса`. Matches where the asset is. |
| `classificationCodes` | CAV / CPV code or prefix: `04` real estate, `06` land, `34` vehicles, `03` agriculture and forestry products. |
| `organizerCodes` | EDRPOU code of the organizer or, for leases, the property owner (e.g. a university or hospital). |
| `minPrice`, `maxPrice` | Starting price in UAH (for leases: monthly rent). |
| `publishedFrom`, `publishedTo` | Publication date. Accepts `2026-09-01`, a full timestamp, or relative values such as `7 days` (ago). |
| `auctionDateFrom`, `auctionDateTo` | Date of the bidding session, e.g. `+3 days` to `+30 days` from now. |

## How searching works (read this once)

Prozorro.Sale does not offer a "search everything" API. It publishes:

1. a **change feed** of every auction ordered by the time it last changed, and
2. the **latest 100 auctions per auction type**.

This Actor reads those official feeds and applies your filters. With **Scan method = auto**:

- If you choose auction types and **no date**, it reads the latest 100 auctions of each type. This is fast and ideal for "what is on offer right now".
- Otherwise it reads **every auction changed in the period** (from `publishedFrom`, `changedSince`, or the last `lookbackHours`, 24 by default). This is complete for the period. Because an auction's last change is never earlier than its publication, "published from X" is covered completely.

`maxPages` (100 auctions per page, default 50) is a safety limit. If it is reached, the `OUTPUT` record says **PARTIAL** and shows exactly which period was checked, so an incomplete scan never looks complete. Monitors continue from where they stopped on the next run.

## Output

One dataset item per auction:

```json
{
  "auctionId": "LRE001-UA-20260916-77195",
  "procedureId": "68c9a0f1c2b4e5a6d7e8f901",
  "url": "https://prozorro.sale/auction/LRE001-UA-20260916-77195",
  "title": "Право оренди земельної ділянки, лот 6 (3.3845 га)",
  "titleEn": null,
  "status": "active_tendering",
  "statusText": "Open for bids",
  "openForBids": true,
  "sellingMethod": "landRental-english",
  "procedureType": "landRental",
  "auctionType": "english",
  "startingPrice": 42000,
  "currency": "UAH",
  "vatIncluded": false,
  "minimalStep": 420,
  "guarantee": 8400,
  "registrationFee": 600,
  "datePublished": "2026-09-16T09:12:00.000000Z",
  "biddingEnd": "2026-10-06T17:00:00.000000Z",
  "auctionDate": "2026-10-07T07:00:00.000000Z",
  "region": "Київська область",
  "city": "Бровари",
  "classificationCodes": ["06000000-2"],
  "items": [{ "description": "…", "classification": { "code": "06000000-2", "scheme": "CAV", "description": "Земельні ділянки" }, "quantity": 3.3845, "unit": "гектар", "region": "Київська область", "city": "Бровари", "address": "…", "properties": { "cadastralNumber": "…" } }],
  "seller": { "name": "…", "edrpou": "…", "region": "…", "email": "…", "phone": "…" },
  "propertyOwner": null,
  "documents": [{ "title": "Оголошення", "documentType": "notice", "documentOf": "auction", "format": "application/pdf", "url": "https://procedure.prozorro.sale/api/documents/public/…" }],
  "result": { "outcome": "in_progress", "bidsCount": null, "winnerName": null, "finalPrice": null, "priceIncreasePercent": null },
  "scrapedAt": "2026-09-26T08:00:00.000Z"
}
```

(Values above are illustrative.) Notes:

- `result.outcome` is `in_progress`, `winner_pending`, `winner_confirmed`, `sold`, `no_winner` or `cancelled`. `finalPrice` comes from the signed contract, or from the winning award before signing.
- On **lease** auctions the organization that owns the property (`propertyOwner`, e.g. a university) differs from the one running the auction (`seller`, usually a regional State Property Fund office).
- Personal data of private bidders is masked by Prozorro.Sale itself and appears as `[redacted]`.
- `includeItems`, `includeDocuments` and `includeRaw` control the size of each record. `raw` holds the original API record (about 30 KB).
- In monitor mode each item also has `isNew`, `monitorName` and `detectedAt`.

The `OUTPUT` record of the run's key-value store summarizes the run: number of matches, what was scanned (`scan.note`, `scan.scannedFrom`, `scan.scannedTo`, `scan.truncated`), auctions not found (details mode), notification results and whether the spending limit was reached.

## Monitor mode and alerts

Set **`monitorName`** to turn a search into a monitor. Each monitor remembers which auctions it has reported (in the named key-value store `prozorro-sale-monitor`) and where it stopped reading the change feed, so no auction is missed or reported twice between runs.

- **What counts as new** (`alertOn`): `newlyPublished` (default) reports auctions published after the monitor started. `newlyMatching` also reports older auctions when they start to match your filters, e.g. when they open for bids.
- The first run saves a baseline and reports nothing, unless **`reportAllOnFirstRun`** is enabled.
- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), paste the token and your chat ID.
- **Slack**: paste an [incoming webhook](https://api.slack.com/messaging/webhooks) URL.
- **Webhook**: receives `POST` JSON with `event` (`auctions.new`), `monitorName`, `newCount`, `message`, `scan`, `resultsUrl` and `auctions` (the first `webhookMaxItems` records). Use it with Make, Zapier or n8n.
- **Email**: sent through the official `apify/send-mail` Actor as a separate small run on your account.

Tokens and webhook URLs are secret inputs, encrypted by Apify. A failed notification never fails the run; the result is shown in `OUTPUT.notifications`.

Example message:

```
🔔 lviv-lease: 2 new Prozorro.Sale auctions
🆕 LLE001-UA-20260925-12345: Оренда нежитлового приміщення, 45.6 кв. м
    861.84 UAH · Львів, Львівська область · auction 2026-10-10 09:00
    https://prozorro.sale/auction/LLE001-UA-20260925-12345
…
```

## Use with AI agents, n8n and Make

- **Apify API / MCP**: call the Actor with a JSON input and read the dataset. Field names are stable English keys; dates are ISO 8601 (UTC); money is a number plus `currency`.
- **n8n / Make / Zapier**: use the Apify app "Run Actor" and "Get dataset items", or set `webhookUrl` in monitor mode to receive only new auctions.
- Agents should check `OUTPUT.scan.note`: an empty result means "nothing matched in the checked period", which is stated explicitly.

## Pricing

Pay per event:

| Event | Price | When |
|---|---|---|
| `auction-result` | $0.003 | Each auction returned by search or details mode ($3 per 1,000). |
| `new-auction-alert` | $0.01 | Each **new** auction found by a monitor, including its alerts. Monitors are not charged `auction-result` as well. |
| `feed-page` (optional) | $0.0005 | Each change-feed page read (up to 100 auctions). Covers scanning cost for frequent monitors that often find nothing new. |

A monitor that finds nothing costs only the pages it read. Listing auction types is free. Email alerts run `apify/send-mail` on your own account.

**Spending limit**: if a run reaches your maximum cost per run, it stops cleanly and keeps what it already delivered. A monitor does **not** advance past undelivered auctions, so they are reported by the next run; nothing is lost and nothing is reported twice.

## Data source and terms

- Official API: `https://procedure.prozorro.sale/api` (main database) and `https://dgf-procedure.prozorro.sale/api` (Deposit Guarantee Fund assets, select **Data source = dgf**). Read-only, no API key.
- Prozorro.Sale open data may be freely copied, published and used, including commercially, **with a mandatory reference to the source** ([prozorro.sale/opendata](https://prozorro.sale/opendata/)). Please credit "Prozorro.Sale" when you publish the data.
- The Actor is polite: requests are never parallel, there is a pause between requests (`requestIntervalMs`, 300 ms by default), and rate-limit (429) or server errors are retried with backoff, honoring `Retry-After`.
- Legacy auctions from the old system (before the current database, "ЦБД-1") are not included.

## FAQ

**Why did my search return nothing?** Nothing matched in the checked period. Look at `OUTPUT.scan.note`: widen `lookbackHours`, set `publishedFrom`, or check spelling of regions (Ukrainian, e.g. `Київ`, not `Kyiv`).

**How do I find an auction type name?** Run once with `"mode": "types"`. Auction ID prefixes tell the type too: `LRE` = landRental-english, `SPE` = smallPrivatization-english, `LLE` = legitimatePropertyLease-english.

**Can I get auctions that finished last month with their final prices?** Yes: set `statuses` to `["complete"]` and `changedSince` to the start of last month. Finished auctions changed status in that period, so the change feed contains them.

**Can I test against the sandbox?** Set `apiBaseUrl` to `https://procedure-staging.prozorro.sale` (synthetic test data).
