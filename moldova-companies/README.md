# Moldova Company Registry Lookup (IDNO)

Look up **Moldovan companies by IDNO** (the 13-digit state identification number / fiscal code) or **by company name**, using the **official open data of the State Register of Legal Entities** published by the Public Services Agency of the Republic of Moldova (Agenția Servicii Publice, ASP).

Get the legal name, legal form, status, registration date, registered address, directors, founders and CAEM activity codes as clean JSON, CSV or Excel. It works for one company or thousands, and you can also **export the whole Moldovan business register** with filters.

Built for **KYB / due diligence, supplier and customer verification, CRM enrichment, lead lists, market research and AI agents**.

## What it does

- 🔎 **IDNO lookup**: paste one or thousands of IDNOs and get one clean record per company. Unknown IDNOs come back as `"found": false` and are not charged.
- 🔤 **Name search** that ignores case and diacritics and understands Cyrillic: `Stiinta`, `Știința` and `ŞTIINŢA` (comma or cedilla ș/ş, ț/ţ) all match. Legal-form words like SRL, S.R.L., SA, Î.I. or ООО are ignored. Three modes: *contains*, *exact* and *fuzzy* (tolerates typos).
- 🧰 **Filters**: legal form (SRL, SA, II…), status (active / liquidated / in process), registration date range, CAEM activity code, and city or district in the address.
- 📦 **Full export** of the register (or a filtered slice, e.g. all IT companies (CAEM 62) registered in 2025 in Chișinău) at a lower bulk price.
- 🏛️ **Official source only**: the latest file is found automatically on [asp.gov.md](https://www.asp.gov.md/ro/date-deschise/date-statistice) and the national open data portal [dataset.gov.md](https://dataset.gov.md/ro/dataset/11736-date-din-registrul-de-stat-al-unitatilor-de-drept-privind-intreprinderile-inregistrate-in-repu). Every result carries `sourceUrl` and `dataDate`.
- ⚡ **Fast repeat runs**: the official file is downloaded once and cached in your account for 24 h (configurable). Cached lookups finish in seconds.

## How to use it

1. Enter one or more **IDNO codes** and/or **company names**.
2. Optionally add **Filters**.
3. Click **Start**. Results appear in the **Output** tab and can be downloaded as JSON, CSV, Excel or used via API.

### Input examples

Look up companies by IDNO:

```json
{ "idnos": ["1002600048836"] }
```

Search by name (diacritics-insensitive), only active SRLs:

```json
{
  "names": ["tara verde", "Știința"],
  "filters": { "legalForms": ["SRL"], "statuses": ["active"] },
  "maxResults": 10
}
```

Find IT companies (CAEM 62) registered since 2025 in Chișinău:

```json
{
  "filters": { "activityCodes": ["62"], "registeredFrom": "2025-01-01", "location": "Chișinău" },
  "maxResults": 500
}
```

Export all active joint-stock companies:

```json
{ "exportAll": true, "filters": { "legalForms": ["SA"], "statuses": ["active"] } }
```

### Input fields

| Field | What it does |
|---|---|
| `idnos` | List of 13-digit IDNOs. Spaces and dashes are ignored. Filters don't apply to IDNO lookups. |
| `names` | List of names or name fragments. |
| `nameMatch` | `contains` (default), `exact` or `fuzzy`. |
| `fuzzyThreshold` | Fuzzy strictness in % (default 75). |
| `maxResults` | Max companies per name query, or in total for a filter-only search (default 25, max 5,000). |
| `filters` | `legalForms`, `statuses`, `registeredFrom`, `registeredTo`, `activityCodes`, `location` (see below). |
| `exportAll` | Export the whole register (with optional `filters`) at the bulk price. |
| `exportLimit` | Cap for the export (0 = no limit). |
| `includePeople` | Include directors / founders lists (default `true`). |
| `includeRawColumns` | Add every original column under its Romanian header in `raw`. |
| `cacheMaxAgeHours` | How long to reuse the downloaded official file before checking for a newer one (default 24). |
| `forceRefresh` | Download the official file again now. |
| `sourceFileUrl` | Advanced: use a specific XLSX/CSV snapshot instead of the latest one. |

**Filters**

- `legalForms`: abbreviations `SRL`, `SA`, `II`, `GT`, `SNC`, `SC`, `COOP`, `IS`, `IM`, or any part of the Romanian legal form name.
- `statuses`: `active`, `liquidated`, `in_process` (liquidation, insolvency, reorganization), `unknown`, `other`. The category is derived from the official status text, which is always returned unchanged in `status`.
- `registeredFrom` / `registeredTo`: `YYYY-MM-DD`.
- `activityCodes`: CAEM (NACE-based) code prefixes, e.g. `"62"`, `"62.01"`, `"47.19"`.
- `location`: any text in the registered address, e.g. `"Bălți"`, `"Ialoveni"`, `"MD-2004"`. Diacritics don't matter.

## Output

One dataset item per company. Keys are in English. Values are kept exactly as the state publishes them (Romanian).

```json
{
  "found": true,
  "idno": "1003600000033",
  "name": "ROBO SOFT S.R.L.",
  "legalForm": "Societate cu răspundere limitată",
  "legalFormCode": "SRL",
  "status": "Activ",
  "statusCategory": "active",
  "registrationDate": "2015-01-21",
  "liquidationDate": null,
  "address": "MD-2004, mun. Chişinău, bd. Dacia 10",
  "directors": ["Munteanu Ana"],
  "founders": ["Munteanu Ana", "Lupu Dan"],
  "activityCodes": ["62.01", "62.02"],
  "activities": ["62.01 Activităţi de realizare a softului la comandă", "62.02 Consultanţă în tehnologia informaţiei"],
  "matchedQuery": "robo soft",
  "matchScore": 0.95,
  "sourceUrl": "https://www.asp.gov.md/sites/default/files/date-deschise/date-statistice/2026/rsud/company.xlsx",
  "dataDate": "2026-09-21"
}
```

*The example uses fictional values.* Fields that the official file doesn't contain are `null` or empty lists. Name results include `matchScore` (1 = exact). IDNOs that are not in the register:

```json
{ "found": false, "idno": "1003600009999", "matchedQuery": "1003600009999", "error": "IDNO not found in the official register file." }
```

The run's key-value store has an `OUTPUT` summary: data date, number of companies in the register, IDNOs not found, name queries without matches and events charged.

## Use it from AI agents

This Actor works well as a tool for AI agents (Apify MCP server, LangChain, OpenAI / Claude tool calling, Make, n8n, Zapier):

- Small, predictable input: `{"idnos": [...]}` or `{"names": [...], "maxResults": 3}`.
- Compact, flat output with English keys, plus an explicit `found: false` answer for unknown IDNOs.
- Clear error messages for invalid input (e.g. an IDNO that is not 13 digits, an unknown filter or a bad date format).
- Every answer states where it came from (`sourceUrl`) and how fresh it is (`dataDate`).

Example agent prompt: *"Check that IDNO 1002600048836 is an active company and tell me its legal form and registration date."*

## Pricing

**Pay per event.** You pay only for companies returned:

- **Lookup result** (`company-result`): each company returned by an IDNO, name or filter search.
- **Bulk export item** (`bulk-export-item`): each company in an `exportAll` run, at a much lower price per company.

Not-found IDNOs, invalid inputs and runs that fail are not charged. Set a maximum cost per run and the Actor stops cleanly when it's reached.

## Data source, freshness and licence

- **Source**: *"Date din Registrul de stat al unităților de drept privind întreprinderile înregistrate în Republica Moldova"*, published by the Public Services Agency (ASP) on [asp.gov.md](https://www.asp.gov.md/ro/date-deschise/date-statistice) and on the Government Open Data Portal [dataset.gov.md](https://dataset.gov.md/ro/dataset/11736-date-din-registrul-de-stat-al-unitatilor-de-drept-privind-intreprinderile-inregistrate-in-repu). Each run uses the newest file available on either site.
- **Freshness**: this is a periodic snapshot (historically weekly), not a real-time register. `dataDate` is the date of the snapshot. For legally binding extracts, use the official ASP services.
- **Coverage**: companies (commercial entities) as included in the official file. Non-commercial organizations (NGOs) are a separate ASP dataset and are not included.
- **Licence**: the open data portal's terms allow anyone to reproduce, redistribute, adapt and use the published data, including commercially ([dataset.gov.md/about](https://dataset.gov.md/about)). Please credit *Agenția Servicii Publice (ASP), Republic of Moldova* when you republish.
- **Personal data**: the file includes names of directors and founders as published by the state. You are responsible for using them lawfully (e.g. under GDPR / Moldovan Law 133/2011 on personal data protection). Turn off `includePeople` if you don't need them.

This Actor downloads only the official open-data file. It doesn't scrape search pages or bypass any access control.

## FAQ

**What is an IDNO?** The *Numărul de identificare de stat* is the 13-digit unique identifier of a Moldovan legal entity. It is also its fiscal code (cod fiscal).

**Why is a company I know missing?** The file is a snapshot. Very new companies appear in the next update. Check `dataDate`. Some entity types (e.g. NGOs) are published in other datasets.

**Can I search by director or founder name?** No. Search is by IDNO, company name and filters. Directors and founders are returned as part of each company record.

**Does it work with Cyrillic?** Yes. Names written in Cyrillic are matched through transliteration (e.g. `молдагротех` matches `MOLDAGROTEH`).

**How often is data refreshed?** Each run checks for a newer official file when the cached copy is older than `cacheMaxAgeHours` (24 h by default). Use `forceRefresh` to check right away.
