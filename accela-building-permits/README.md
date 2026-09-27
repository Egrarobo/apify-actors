# US Building Permits: Accela Citizen Access (any city)

Get **new building permits as daily leads** from any US city or county that runs **Accela Citizen Access** (the "ACA" permit portals at `aca-prod.accela.com/...` and self-hosted `…/CitizenAccess`). For every permit you get record number, type, trade category, status, opened date, address with city/state/ZIP, description and a link to the record. Turn on details to add **job valuation, contractor name, license, phone and address**, parcel number and the portal's extra fields.

Built for **roofers, solar installers, HVAC and pool contractors, remodelers, suppliers, lead-generation agencies and n8n / Make / Zapier users** who want fresh permits every morning instead of paying for a one-off city extraction.

*Keywords: building permit leads, new permits API, Accela permits scraper, roofing permits, solar permits, pool permits, HVAC permits, new construction permits, contractor leads, permit data export.*

## What you can do

- 🏗️ **Search one or many cities/counties at once**: 30+ known portals in a dropdown (Tampa, Hillsborough, Pinellas, Pasco, Sacramento, Clark County NV, Pima County AZ, Salt Lake City, Denver, Atlanta, Louisville, Indianapolis, Oklahoma City, Virginia Beach, …) plus **any other Accela agency** by code or portal URL
- 🔧 **Filter by trade**: `roofing`, `solar`, `pool`, `hvac`, `electrical`, `plumbing`, `new-construction`, `remodel`, `demolition`, … or any keyword; or let the portal filter by its own record types
- 💰 **Details**: valuation, contractor company, license number and type, phone, address, parcel number, applicant company
- 🔔 **Monitor mode**: each run saves only permits it has not seen before, with alerts on **Telegram, Slack, email or a webhook** (n8n, Make, Zapier). Schedule it daily
- 🛡️ **Privacy by default**: owner and applicant names are left out unless you switch them on
- ⚡ **Efficient and robust**: plain HTTP with ASP.NET postbacks (no browser for most portals), the portal's CSV export for big pulls, automatic retries and a real-browser fallback for portals that block plain requests

## Quick start

**Roofing and solar permits in Tampa and Hillsborough County, last 7 days, with contractor and valuation:**

```json
{
  "agencies": ["TAMPA", "HCFL"],
  "lastNDays": 7,
  "permitTypes": ["roofing", "solar"],
  "includeDetails": true
}
```

**Every building permit opened in September in a city that is not in the list:**

```json
{
  "customAgencies": ["https://aca-prod.accela.com/SPOKANE/Cap/CapHome.aspx?module=Building"],
  "dateFrom": "2026-09-01",
  "dateTo": "2026-09-30",
  "maxRecordsPerAgency": 0
}
```

**Daily pool-permit leads to a Make/n8n webhook (schedule once a day):**

```json
{
  "agencies": ["PINELLAS", "PASCO", "HCFL"],
  "permitTypes": ["pool"],
  "includeDetails": true,
  "lastNDays": 5,
  "monitorName": "tampa-bay-pools",
  "webhookUrl": "https://hook.eu1.make.com/your-hook-id"
}
```

## Output

One item per permit (dataset views: **Permits** and **Contractors & valuation**):

```json
{
  "agency": "PINELLAS",
  "agencyName": "Pinellas County, FL",
  "module": "Building",
  "recordNumber": "BLD-26-04001",
  "recordType": "Residential Solar",
  "category": "solar",
  "status": "In Review",
  "openedDate": "2026-09-27",
  "issuedDate": null,
  "expirationDate": "2027-03-26",
  "address": "1037 SEMINOLE BLVD",
  "city": "Seminole",
  "state": "FL",
  "zip": "33772",
  "fullAddress": "1037 SEMINOLE BLVD, SEMINOLE FL 33772",
  "parcelNumber": "19-29-15-10001-000-0100",
  "description": "Install 11 kW roof mounted photovoltaic system with battery",
  "projectName": null,
  "valuation": 32100,
  "contractorName": "BRIGHT SKY SOLAR INC",
  "contractorPerson": "QUALIFIER 1",
  "contractorLicense": "CVC5730001",
  "contractorLicenseType": "Certified Solar Contractor",
  "contractorPhone": "(727) 555-2001",
  "contractorAddress": "501 INDUSTRIAL WAY, LARGO, FL, 33771",
  "applicantName": null,
  "applicantCompany": "PERMIT RUNNERS INC",
  "ownerName": null,
  "ownerMailingAddress": null,
  "moreDetails": { "Job Value($)": "$32,100.00", "Construction Type": "V-B" },
  "detailsFetched": true,
  "detailUrl": "https://aca-prod.accela.com/PINELLAS/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=…",
  "portalUrl": "https://aca-prod.accela.com/PINELLAS/Cap/CapHome.aspx?module=Building&TabName=Building",
  "source": "grid",
  "scrapedAt": "2026-09-27T17:07:15.510Z"
}
```

*(Example values from the test portal.)* Fields the portal does not publish are `null`. Without details you get everything up to `description` plus the links. `issuedDate` is only filled where the portal's results list has an issued-date column; most portals list the **opened (applied) date**, which is what the date search filters on. In monitor mode items also carry `monitorName`, `isNew` and `detectedAt`. The run summary (`OUTPUT` in the key-value store) lists per agency how many records were read, matched and saved, how the portal was read (HTTP / browser, grid / CSV) and any error.

## Input

All fields are optional; with no input the Actor returns the last 7 days of Pinellas County, FL building permits.

| Field | Default | What it does |
|---|---|---|
| `agencies` | `["PINELLAS"]` | Known portals (dropdown). |
| `customAgencies` | – | Other portals: agency code (`KERNCO`) or full URL of the search page, also self-hosted ones. |
| `module` | agency's usual | `Building`, `Permits`, `Development`, … as in `CapHome.aspx?module=…`. |
| `lastNDays` / `dateFrom` / `dateTo` | 7 days | Period of the record **opened** date. |
| `permitTypes` | all | Trade names (roofing/roof, solar, pool, hvac, electrical, plumbing, new-construction/new, addition, remodel, demolition, windows, fence, sign, accessory-structure, mobile-home) or any keyword. |
| `excludeKeywords` | – | Drop permits mentioning these words. |
| `statuses` | any | Keep permits whose status contains e.g. `Issued`. |
| `recordTypes` | – | Let the portal filter by its "Record Type" dropdown (text contains). |
| `maxRecordsPerAgency` | 500 | Newest first; `0` = no limit. |
| `includeDetails` | false | Detail page per permit: contractor, valuation, parcel, extra fields. |
| `includePersonalNames` | false | Owner / applicant names and owner mailing address (with details). |
| `monitorName` | – | Monitor mode: only permits not seen before. |
| `telegramBotToken` + `telegramChatId`, `slackWebhookUrl`, `webhookUrl`, `emailTo` | – | Alerts in monitor mode. |
| `proxyConfiguration` | Apify Proxy | Use RESIDENTIAL (US) if a portal refuses datacenter IPs. |
| `exportMode` | auto | `grid` (links for every permit), `csv` (portal's "Download results"), `auto` (CSV only for >100 results without details). |

Advanced: `searchWindowDays` (7), `maxPagesPerAgency` (100), `browserFallback` (true), `forceBrowser` (false), `requestDelayMs` (700), `maxRetries` (3), `saveDebugPages` (true), `stateStoreName`, `reportAllOnFirstRun`, `resetState`, `notifyMaxItems`, `webhookMaxItems`, `notifyOnNoChanges`, `emailSubject`.

### Finding an agency code

Open the city's permit search in your browser. If the address looks like `https://aca-prod.accela.com/TAMPA/Cap/CapHome.aspx?module=Building`, the agency code is `TAMPA` and the module is `Building`. You can also paste the whole address into `customAgencies`. If the module is wrong, the log lists the modules the portal offers.

## Monitor mode and alerts

1. Set `monitorName` (e.g. `"tampa-roofing"`) and your filters, then **schedule** the Actor (daily is typical).
2. The **first run is a silent baseline**: it remembers the permits currently in the period without saving them (turn on `reportAllOnFirstRun` to get them too).
3. Every following run saves only **new** permits and sends one message per channel. Keep `lastNDays` at 3–7 so permits that the city enters a few days late are still caught; duplicates never come back.
4. The webhook receives JSON: `{ "event": "permits.new", "monitorName", "summary": { "newPermits", "checked", "agencies", "failedAgencies" }, "resultsUrl", "runId", "datasetId", "message", "permits": [ … ] }`. In n8n use a *Webhook* trigger node, in Make a *Custom webhook*.

Changing the filters of a monitor starts a new baseline so you are not flooded with old permits. `resetState` forgets everything.

## Pricing (pay per event)

| Event | Price | When |
|---|---|---|
| `permit` | $0.01 | Each permit saved to the dataset |
| `permit-details` | $0.01 | Each permit whose detail page was loaded (`includeDetails`) |

Searching, paging and monitor baselines are free; failed detail pages are not charged. 1,000 permits cost **$10**, or **$20 with contractor and valuation**. Set a *maximum cost per run* and the Actor stops cleanly at that budget; in monitor mode, permits that did not fit are reported on the next run.

## How it works

ACA portals are ASP.NET WebForms applications. The Actor opens the module's **General Search** page, fills the start/end date fields and posts the form back with the page's `__VIEWSTATE` and `ACA_CS_FIELD` like a browser would, then follows the result grid's pager (10 rows per page) or clicks **Download results** for a CSV of the whole list. Long periods are split into windows (7 days by default, newest first). Grid columns differ per agency, so they are mapped by their header text. When exactly one record matches, ACA opens it directly; that is handled too.

If a portal blocks plain HTTP (Cloudflare/WAF answer), the Actor rotates to a new proxy IP, then loads the portal once in a real Chrome and continues over HTTP with the browser's cookies, and finally works entirely inside the browser. Pages that do not look as expected are saved to the key-value store as `DEBUG-…` and the log says what the portal answered.

## Limits and good to know

- Only **public** search pages work. Modules behind a login and portals with a **CAPTCHA** on the search are reported with a clear message and skipped.
- The date search filters on the record's **opened/applied** date. To get only issued permits, set `statuses: ["Issued"]` with a period long enough to cover the city's issuing delay (e.g. `lastNDays: 30`); in monitor mode note that a permit is reported once, the first time it matches.
- Coverage and field names depend on each city's configuration. Some cities do not publish contractor or valuation on the detail page.
- Please keep the default delay between requests; these are city servers.

## Legal and privacy

Building permits are public records, and this Actor only reads pages any visitor can open without an account. Owner and applicant names are **off by default**; if you switch them on, you are responsible for complying with privacy, telemarketing (TCPA / Do-Not-Call) and anti-spam laws when contacting people, and with the terms of use of each portal. The Actor is not affiliated with Accela, Inc. or any government agency.

## Support

Missing a city, a wrong field, or a portal that changed? Open an issue on the Actor's page with the portal URL and the run ID. The `OUTPUT` summary and `DEBUG-…` pages usually show exactly what happened.
