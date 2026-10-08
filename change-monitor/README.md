# Dataset Change Monitor

Run your scraper on a schedule and **get only what changed since the last run**. This Actor compares each new run's results with the previous one and outputs **new items, changed items (with before → after values per field) and removed items**. You can also get an **alert on Telegram, Slack, email or any webhook**.

It works with **any Apify Actor or dataset**, and also with JSON or CSV files. Typical uses: price monitoring, stock and availability tracking, new job postings, new real-estate listings, competitor catalogs, new reviews, and SEO or content change detection.

## Why use it

- 🆕 **New items**: new products, listings, jobs or posts since the last run
- ✏️ **Changed items** with a field-level diff: `price: 19.99 → 17.49`, `stock: true → false`
- ❌ **Removed items**: sold out, delisted or deleted
- 🔔 **Alerts** only when something changed: Telegram, Slack, webhook (Make, Zapier, n8n) and email
- 🎯 **You choose what counts as a change**: watch only `price` and `stock`, or everything except `scrapedAt`
- 🔌 **No code**: add it as an integration to your scraper and it runs after every scrape
- 📦 **Handles large datasets**: reads page by page and keeps a compact, compressed snapshot between runs
- 💸 **Pay only for results**: a small fee per 1,000 items compared plus a fee per reported change

## Try it in one click (free demo)

Click **Start** with an empty input. The Actor then compares two small built-in sample snapshots of a fictional shop ("yesterday" and "today") and shows the exact output you will get on your own data: 1 new item, 2 changed items with `before → after` values (a price drop and an out-of-stock item) and 1 removed item. Demo rows have `"demo": true`; no state is saved and no change events are charged.

## Quick start: run it after every scrape (recommended)

1. Open your scraper (or saved task) in Apify Console → **Integrations** → **Add integration** → **Dataset Change Monitor**.
2. Set **Unique key fields** (e.g. `url`), **Fields to ignore** (e.g. `scrapedAt`) and, if you want, your Telegram or Slack details.
3. Schedule the scraper as usual. After each run, this Actor compares the new results with the previous ones.

The first run saves a **baseline** and reports nothing (unless you enable *Report all items as new on the first run*). From the second run on, you only get the differences.

When used as an integration, the dataset of the finished run is detected automatically, and the monitor name defaults to the scraper's task or Actor ID, so every scraper keeps its own history.

## Other ways to provide data

| Input | When to use |
|---|---|
| `datasetId` | Compare a specific dataset (ID or name). |
| `actorRunId` | Compare the default dataset of a given run. |
| `datasetUrl` | A public JSON, JSON Lines or CSV link, e.g. an Apify dataset export URL or a Google Sheet published as CSV. |
| `items` | Pass an array directly (testing, Make, Zapier, n8n). |

## Input example

```json
{
  "datasetId": "aBcD1234efGh5678",
  "monitorName": "amazon-laptops",
  "idFields": ["asin"],
  "compareFields": ["price", "stock", "title"],
  "trackRemoved": true,
  "telegramBotToken": "123456:ABC-your-bot-token",
  "telegramChatId": "123456789",
  "notifyMaxItems": 10
}
```

### Matching options

- **Monitor name**: every name keeps its own memory of the previous run. Use one name per scraper, search or list you track. Runs with the same name are compared with each other.
- **Unique key fields** (`idFields`): identify the same item across runs, e.g. `url`, `id`, `asin`, `sku`. Several fields are combined, and nested fields use dots (`offer.id`). If you leave it empty, the whole item is the key, so items can only be *new* or *removed*, never *changed*.
- **Fields to watch** (`compareFields`): only these fields decide whether an item changed. Leave empty to watch all fields.
- **Fields to ignore** (`ignoreFields`): fields that change on every run, such as `scrapedAt`, `timestamp` or `position`.

If you change the key, watched or ignored fields, the next run starts a new baseline automatically, because old and new snapshots are no longer comparable.

## Output

Each change is one dataset item:

```json
{
  "changeType": "changed",
  "key": "https://shop.example/p/123",
  "changedFields": ["price", "stock"],
  "changes": [
    { "field": "price", "before": 19.99, "after": 17.49 },
    { "field": "stock", "before": true, "after": false }
  ],
  "totalChangedFields": 2,
  "item": { "url": "https://shop.example/p/123", "title": "…", "price": 17.49, "stock": false },
  "monitorName": "shop-example",
  "detectedAt": "2026-09-26T08:00:00.000Z"
}
```

- `changeType`: `new`, `changed` or `removed`
- `item`: the current item. For `removed`, it holds the last known values of the compared fields.
- `changes`: only for `changed`. Long values are shortened.

The `OUTPUT` record in the run's key-value store contains a summary: counts of new, changed, removed and unchanged items, items compared, notification results, and whether the snapshot was updated.

## Notifications

Notifications are optional and are sent only when something changed (or after every run if you enable *Also notify when nothing changed*). Messages look like this:

```
🔔 amazon-laptops: 3 new, 2 changed, 1 removed (1,240 items checked)
🆕 NEW: B0CX23V2ZK
✏️ CHANGED: B0BSHF7WHW
    price: 999 → 899
❌ REMOVED: B0C1234567
…and 2 more
Full results: https://console.apify.com/storage/datasets/…
```

- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), paste the token, and set your chat ID. For groups and channels, add the bot first.
- **Slack**: create an [incoming webhook](https://api.slack.com/messaging/webhooks) and paste its URL.
- **Webhook**: receives a `POST` with JSON: `event`, `monitorName`, `summary`, `message`, `resultsUrl` and the first changes (`webhookMaxItems`, default 100). Great for Make, Zapier, n8n, Google Apps Script or your own backend.
- **Email**: sent through the official `apify/send-mail` Actor. That call runs on your Apify account as a separate, very small run (usually a fraction of a cent). Separate several addresses with commas.

The bot token, Slack URL and webhook URL are stored as **secret inputs** and are encrypted by Apify.

A failed notification never fails the run: the result is shown in the log and in `OUTPUT.notifications`.

## Pricing

Pay per event:

- **Items compared**: charged per started 1,000 items read from your data.
- **Change detected**: charged per reported new, changed or removed item.

A run where nothing changed only costs the comparison. Change types you switch off are not reported and not charged. If a run hits your **maximum cost per run**, it stops cleanly, keeps what it already reported and **does not update the snapshot**, so no change is lost. The next run compares against the same previous data.

## Safety features

- **Empty result protection**: if a scrape returns 0 items (for example because it was blocked), nothing is reported as removed and the previous snapshot is kept. Enable *Allow an empty source* if empty results are real.
- **Crash-safe state**: the new snapshot is written completely before it replaces the old one.
- **Duplicates**: when the same key appears twice in one run, only the first item is used, and the log tells you so.
- **Items without a key** are skipped and counted.

## Where the history is stored

Snapshots live in a named key-value store in your account, `change-monitor-state` by default, one entry per monitor name. Named storages are kept until you delete them. To start over, enable **Start over** for one run, or delete the `state-<monitor-name>-…` records.

## Limits

- Only fields up to 4 levels deep are listed individually in `changes`. Deeper differences and arrays are shown as one changed field.
- Very long values are stored as a fingerprint plus a 200-character preview. Changes are still detected exactly, but `before` shows only the preview.
- The snapshot is held in memory while comparing. About 100,000 typical items fit in 1 GB of memory. For millions of items, give the run more memory, or turn off *Show which fields changed* to keep only fingerprints.
- `datasetUrl` files are downloaded whole, so use `datasetId` for very large data.
- With *Max items to compare*, removals are not reported for that run, because unseen items might still exist.

## FAQ

**Why did the first run report nothing?** The first run saves the baseline. Enable *Report all items as new on the first run* if you want everything reported.

**Every item shows as changed.** A field changes on every run, for example a timestamp, rank or session ID. Add it to *Fields to ignore*, or list only the fields you care about in *Fields to watch*.

**Every item shows as new.** The key is not stable. Pick a stable field such as a product ID or canonical URL as *Unique key fields*.

**Can I monitor several scrapers?** Yes. Use a different *Monitor name* for each one. As an integration this happens automatically.

**Can I use it outside Apify?** Yes. Send your items with `items` or `datasetUrl` through the Apify API, Make, Zapier or n8n, and use the same monitor name each time.
