# MTender Moldova Public Procurement: Tenders & Alerts

Search and monitor **Moldova's public procurement tenders** from **MTender** (mtender.gov.md), the official e-procurement system of the Republic of Moldova. Get clean, English-keyed JSON for every tender: title, buyer, estimated value, CPV codes, deadlines, lots, items, documents, awards, winning suppliers and contracts. Turn on **monitor mode** to get only **new tenders** on each run, with alerts on **Telegram, Slack, email or any webhook** (n8n, Make, Zapier).

Data comes straight from the official public MTender API (Open Contracting Data Standard, OCDS). No login, no API key, no browser.

*Keywords: achiziții publice Moldova, licitații publice, MTender, tender alerts, government contracts Moldova, государственные закупки Молдова, OCDS.*

## What you can do

- 🔎 **Search tenders** published in a period by **keywords** (Romanian diacritics-insensitive, Russian too), **CPV code**, **buyer name or IDNO**, **status**, **procurement method**, **category** and **value range / currency**
- 📄 **Get full details** for tender IDs or MTender links: lots, items with quantities, document links, bidding and enquiry periods, awards with supplier names and amounts, contracts
- 🔔 **Monitor** a saved search and get **only new tenders** each run, with Telegram, Slack, webhook and email alerts
- 🤖 **Built for automation**: flat JSON with stable English keys, one item per tender, ideal for AI agents, n8n, Make, Zapier, Google Sheets and BI tools
- 💸 **Pay only for results**: checking tenders is free, you pay per tender returned or per new-tender alert

## Quick start

**Latest tenders for medicines (last 7 days):**

```json
{
  "keywords": ["medicamente"],
  "dateFrom": "7 days",
  "statuses": ["active"]
}
```

**Road and construction works above 1 million MDL:**

```json
{
  "cpvPrefixes": ["45"],
  "minValue": 1000000,
  "currency": "MDL",
  "dateFrom": "2026-09-01"
}
```

**Full details for specific tenders:**

```json
{
  "tenderIds": [
    "ocds-b3wdp1-MD-1612345678901",
    "https://mtender.gov.md/tenders/ocds-b3wdp1-MD-1612345678902"
  ]
}
```

**Daily alert for new IT tenders (schedule this every hour or day):**

```json
{
  "monitorName": "it-equipment",
  "cpvPrefixes": ["302", "48", "72"],
  "statuses": ["active"],
  "telegramBotToken": "123456:ABC-your-bot-token",
  "telegramChatId": "123456789"
}
```

## How it works

MTender publishes every procurement process as OCDS data. The public feed lists processes by their **last update**, so the Actor walks the feed for your period, loads each tender and applies your filters. MTender has no server-side search, which is why filtering happens in the Actor: checking is free for you, and `maxScan` (default 3,000) caps how many tenders are checked per run.

The Actor picks its mode from the input:

| You fill | Mode | Output |
|---|---|---|
| nothing special | **Search** | Every tender matching the filters in the period |
| `tenderIds` | **Details** | One item per ID; filters and period are ignored |
| `monitorName` | **Monitor** | Only tenders not seen in earlier runs of this monitor |

## Input

All fields are optional. The most useful ones:

| Field | Example | Notes |
|---|---|---|
| `keywords` | `["medicament", "reactivi"]` | Searched in title, description, lots and items. Case and Romanian diacritics are ignored; parts of words match. |
| `keywordsMatch` | `"any"` / `"all"` | Whether one or all keywords must be present. |
| `excludeKeywords` | `["reparatie"]` | Skip tenders containing these words. |
| `cpvPrefixes` | `["33", "45233"]` | CPV code prefixes, matched against the main CPV and every item's CPV. |
| `statuses` | `["active"]` | `active`, `complete`, `cancelled`, `unsuccessful`, `planning`, `planned`, `withdrawn`. |
| `methods` | `["open"]`, `["smallValue"]` | OCDS method or MTender method detail (see `methodDetails` in the output). |
| `categories` | `["goods"]` | `goods`, `works`, `services`. |
| `buyerNames` | `["Primaria"]` | Part of the buyer's name. |
| `buyerIdnos` | `["1007601004785"]` | Buyer's 13-digit IDNO. |
| `minValue` / `maxValue` / `currency` | `100000`, `"MDL"` | Estimated value filter. |
| `dateFrom` / `dateTo` | `"2026-09-01"`, `"7 days"` | Period. Default: last 3 days. |
| `onlyNewlyPublished` | `true` | Skip older tenders that were only updated (awarded, amended) in the period. Disable to track awards of older tenders. |
| `feed` | `"all"` | `all`, `contractNotices` (calls for competition) or `plans` (planned procurements). |
| `tenderIds` | OCIDs or links | Details mode. |
| `monitorName` | `"medical-supplies"` | Monitor mode. |
| `maxResults` | `100` | Max tenders output per run (0 = no limit). |
| `includeRaw` | `false` | Adds the original OCDS record package as `raw`. |

## Output

One dataset item per tender:

```json
{
  "ocid": "ocds-b3wdp1-MD-1789030800000",
  "url": "https://mtender.gov.md/tenders/ocds-b3wdp1-MD-1789030800000",
  "title": "Reparația capitală a drumului str. Ștefan cel Mare",
  "description": "Lucrări de reparație capitală a carosabilului",
  "buyer": "Primăria municipiului Chișinău",
  "buyerIdno": "1007601004785",
  "status": "complete",
  "statusDetails": "complete",
  "method": "open",
  "methodDetails": "openTender",
  "category": "works",
  "cpv": "45233140-2",
  "cpvDescription": "Lucrări de drumuri",
  "cpvCodes": ["45233140-2"],
  "value": 8500000,
  "currency": "MDL",
  "datePublished": "2026-09-10T09:00:00Z",
  "dateModified": "2026-09-14T12:00:00Z",
  "tenderPeriodStart": "2026-09-10T09:00:00Z",
  "tenderPeriodEnd": "2026-09-11T09:00:00Z",
  "enquiryPeriodEnd": null,
  "lotsCount": 1,
  "lots": [{ "id": "lot-1", "title": "Str. Ștefan cel Mare", "status": "complete", "value": 8500000, "currency": "MDL" }],
  "items": [{ "description": "Asfaltare 10.000 m2", "cpv": "45233140-2", "quantity": 10000, "unit": "Metru pătrat", "relatedLot": "lot-1" }],
  "documents": [{ "title": "Anunț de participare.pdf", "type": "contractNotice", "url": "https://storage.mtender.gov.md/get/…" }],
  "bidsCount": 3,
  "awards": [{ "status": "active", "date": "2026-09-13T12:00:00Z", "value": 7950000, "currency": "MDL", "suppliers": [{ "name": "Drumuri-Construct SRL", "idno": "1002600055555" }], "relatedLots": ["lot-1"] }],
  "contracts": [{ "awardId": "aw-1", "status": "active", "value": 7950000, "dateSigned": "2026-09-14T11:00:00Z" }],
  "suppliers": ["Drumuri-Construct SRL"],
  "awardedValue": 7950000,
  "awardedCurrency": "MDL",
  "matchedKeywords": [],
  "scrapedAt": "2026-09-26T08:00:00.000Z"
}
```

(Values above are illustrative.) Key fields:

- `url`: the tender page on mtender.gov.md; `apiUrl`: the OCDS JSON behind it
- `value` / `currency`: the **estimated** value (asking price). The money actually committed is in `awards`, `awardedValue` and `contracts`
- `status`: overall status of the procedure; `stageStatus`: detail of the current stage (e.g. `clarification`, `tendering`, `awarding`)
- `tenderPeriodEnd`: deadline for offers; `enquiryPeriodEnd`: deadline for questions
- `suppliers`: winners of active awards
- Monitor mode adds `monitorName`, `isNew` and `detectedAt`
- Titles and descriptions are kept in the original language (usually Romanian)

In details mode, an ID that does not exist produces a free item with `ocid` and `error`, so integrations can see which IDs failed.

The `OUTPUT` record of each run holds a summary: tenders checked, matched and returned, whether a limit was reached, and notification results.

## Monitor mode and alerts

1. Set a **Monitor name** (one per saved search) and your filters.
2. Run once: the first run saves a **baseline** (current matching tenders are remembered, nothing is reported). Enable *Report current matches on the first run* if you want them.
3. Schedule the Actor (e.g. every hour). Each run continues where the previous one stopped and reports **only new matching tenders**.

Alerts are sent only when there are new tenders (or after every run with *Also notify when nothing is new*):

```
🔔 medical-supplies: 2 new MTender tenders (143 checked)
🆕 Medicamente oncologice
    IMSP Spitalul Clinic Republican „Timofei Moșneaga”
    2,100,000 MDL · deadline 2026-10-10 08:00 · CPV 33652000-5
    https://mtender.gov.md/tenders/ocds-b3wdp1-MD-…
```

- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), paste the token and your chat ID.
- **Slack**: paste an [incoming webhook](https://api.slack.com/messaging/webhooks) URL.
- **Webhook**: receives a `POST` with `event` (`tenders.new` or `tenders.none`), `monitorName`, `summary`, `message` and `tenders` (the new tenders, without raw data).
- **Email**: sent through the official `apify/send-mail` Actor (a separate, very small run on your account).

Tokens and webhook URLs are secret inputs, encrypted by Apify. A failed notification never fails the run.

The monitor's memory lives in the named key-value store `mtender-monitor-state` (one record per monitor name). If you change the filters, the next run becomes a new baseline so you are not flooded with old tenders. Enable **Start over** to forget everything.

## Use with AI agents, n8n, Make and Zapier

Run the Actor and get the tenders in one HTTP call:

```bash
curl -X POST "https://api.apify.com/v2/acts/<ACTOR_ID>/run-sync-get-dataset-items?token=<YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"keywords":["calculatoare"],"dateFrom":"14 days","statuses":["active"],"maxResults":20}'
```

- **n8n / Make / Zapier**: use the Apify app ("Run Actor" + "Get dataset items"), or point the Actor's **Webhook URL** at an n8n/Make webhook trigger to receive new tenders as they appear.
- **AI agents (MCP)**: the Actor can be called as a tool through the Apify MCP server. Each item is self-contained with English keys, so an agent can filter, summarize or draft bid/no-bid notes directly. Ask for `tenderIds` details when the agent needs lots, documents and awards for a specific tender.
- **Google Sheets**: export the dataset as CSV/Excel, or use the "overview" and "awards" dataset views.

## Pricing

Pay per event:

- **Tender result**: each tender returned in search or details mode.
- **New tender alert**: each new tender reported in monitor mode (includes the notifications).

Checking tenders that do not match, baseline runs and monitor runs with nothing new are not charged per tender (only an Actor start fee applies if one is listed on the Pricing tab). If a run reaches your **maximum cost per run**, it stops cleanly and keeps what it already returned; in monitor mode the remaining new tenders are reported on the next run, none are lost or duplicated.

## Good to know

- **Source and freshness**: data is read live from the public MTender API (`public.mtender.gov.md`), published under the Open Contracting Data Standard. Tenders are listed by their last update.
- **No full-text search on MTender**: every tender updated in your period is checked, so long periods take longer. Use `maxScan` to cap a run and narrow `dateFrom` for faster runs.
- **Publication date**: MTender's feed has no publication-date filter. `datePublished` is the start of the bidding period for contract notices and the creation time for plans; `onlyNewlyPublished` uses it.
- **Values** are estimates set by the buyer; `awardedValue` is the sum of active awards when they share one currency.
- **Politeness**: at most 4 parallel requests (configurable), a small delay between requests, automatic retries with exponential backoff, and a global slowdown when MTender answers "429 Too Many Requests".
- **Data quality**: some MTender records have empty fields, placeholder values or awards without contracts. Missing values are `null`, never invented.

## FAQ

**Why did my first monitor run return nothing?** It saved the baseline. New tenders are reported from the second run. Enable *Report current matches on the first run* to get them immediately.

**Can I search in Romanian without diacritics?** Yes. "achizitionare", "Achiziționare" and "ACHIZIŢIONARE" all match.

**How do I find CPV codes?** Use the first digits of the Common Procurement Vocabulary: `33` medical and pharmaceutical, `45` construction works, `30` office and computer equipment, `72` IT services, `15` food, `09` fuels, `34` vehicles, `90` cleaning and waste services.

**How do I get award winners for tenders from last month?** Set `dateFrom` to the period, `statuses: ["complete"]` and `onlyNewlyPublished: false`. See the "Awards & suppliers" dataset view.

**Is this an official MTender product?** No. It is an independent tool that reads MTender's public open data.
