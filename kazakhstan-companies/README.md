# Kazakhstan Company Lookup by BIN

Look up **Kazakhstan legal entities by BIN** (the 12-digit business identification number, БИН / БСН) or **by company name** in **official public sources** of the Republic of Kazakhstan:

- the **State register of legal entities** of the Ministry of Justice, published as open data on the government portal [data.egov.kz](https://data.egov.kz/datasets/view?index=gbd_ul), and
- the **statistical business register** of the Bureau of National Statistics ([stat.gov.kz BIN search](https://stat.gov.kz/en/juridical/by/bin/)).

You get the registered name in Russian and Kazakh, legal form, status, registration date, legal address, director, main activity (OKED), size class (KRP), KATO territory code, ownership form and sector as clean JSON, CSV or Excel. Keys are in English, and the original records are included too.

Built for **KYB / due diligence, AML and compliance checks, supplier and customer verification, CRM enrichment and AI agents**.

## What it does

- 🔢 **BIN lookup**: paste one or thousands of BINs. Every BIN is checked first (12 digits, structure and the official check digit), so typos are caught before any request is made. An IIN of a private person is recognized and rejected.
- 🔤 **Name search** in the state register (Russian or Kazakh, Cyrillic). Legal-form words such as ТОО, АО, ЖШС or LLP are ignored. The best matches come first, and active companies rank above closed ones.
- 🏛️ **Two official sources, one record**: registration data from the Ministry of Justice register, plus statistical classification (OKED, size, KATO) from the Bureau of National Statistics. If one source is down, you still get the other one's data with a warning.
- 🧭 **BIN decoding**: registration year and month, resident or non-resident entity, head office, branch or representative office. It's read from the number itself.
- 🌐 **Languages**: Russian (default) or Kazakh values. English classifier labels come from stat.gov.kz where it provides them.
- ⚡ **Cache**: answers are kept in your account for 7 days (configurable), so repeat lookups are instant and don't load government servers.
- 🧾 **Clear answers for agents**: unknown BINs return `"found": false` and invalid BINs return `"lookupStatus": "invalid"`. Neither is charged.

## How to use it

1. Enter one or more **BINs** and/or **company names**.
2. Click **Start**.
3. Download the results from the **Output** tab as JSON, CSV or Excel, or use them via the API.

### Input examples

Check one company:

```json
{ "bins": ["971240001315"] }
```

Several BINs, Kazakh-language values, registry data only:

```json
{ "bins": ["971240001315", "020240000555"], "language": "kz", "sources": ["registry"] }
```

Search by name:

```json
{ "names": ["Казахтелеком"], "maxResults": 5 }
```

### Input fields

| Field | What it does |
|---|---|
| `bins` | List of 12-digit BINs. Spaces and dashes are ignored. |
| `names` | Company names or name fragments (Cyrillic, as registered). Searches the state register. |
| `maxResults` | Maximum companies per name query (default 10, max 200). |
| `language` | `ru` (default), `kz` or `en`. Chooses the language of `name`, `status`, `address` and classifier labels. Russian and Kazakh names are always included. |
| `sources` | `registry` (data.egov.kz), `statistics` (stat.gov.kz) or both (default). |
| `includeOriginal` | Include the untouched source records under `original` (default on). |
| `validateChecksum` | Reject BINs with a wrong check digit without querying (default on). |
| `cacheDays` | How long answers are cached (default 7, 0 = off). "Not found" is cached for at most 1 day. |
| `forceRefresh` | Ignore the cache for this run. |
| `proxyConfiguration` | Off by default. See [Access from outside Kazakhstan](#access-from-outside-kazakhstan). |
| `egovApiKey` | Optional data.egov.kz API key. See [Data sources](#data-sources-and-freshness). |
| `maxConcurrency` | Parallel lookups (default 2, max 5). |
| `requestTimeoutSecs` | Timeout per request (default 30). Failed requests are retried 3 times with growing delays. |
| `apiBaseUrl` | Testing only (mock server). Leave empty. |

## Output

One dataset item per company. The values below are **fictional**:

```json
{
  "found": true,
  "bin": "150140010013",
  "name": "Товарищество с ограниченной ответственностью \"Робокод Казахстан\"",
  "nameRu": "Товарищество с ограниченной ответственностью \"Робокод Казахстан\"",
  "nameKz": "\"Робокод Қазақстан\" жауапкершілігі шектеулі серіктестігі",
  "legalFormCode": "LLP",
  "registrationDate": "2015-01-20",
  "status": "Зарегистрирован",
  "statusCategory": "active",
  "address": "г.Алматы, Бостандыкский район, проспект Абая, дом 10",
  "addressRu": "г.Алматы, Бостандыкский район, проспект Абая, дом 10",
  "addressKz": "Алматы қ., Бостандық ауданы, Абай даңғылы, 10 үй",
  "katoCode": "751210000",
  "katoAddress": "АЛМАТЫ Г.А., БОСТАНДЫКСКИЙ РАЙОН, ПРОСПЕКТ АБАЯ, дом 10",
  "director": "ИВАНОВ ИВАН ИВАНОВИЧ",
  "primaryActivity": { "code": "62011", "name": "Разработка программного обеспечения" },
  "secondaryActivityCodes": ["85599", "62020"],
  "size": { "code": "105", "name": "Малые предприятия (<= 5 чел.)" },
  "sizeExcludingBranches": { "code": "105", "name": "Малые предприятия (<= 5 чел.)" },
  "economicSector": { "code": "1122", "name": "Национальные частные нефинансовые корпорации – ОПП" },
  "ownershipForm": { "code": "2", "name": "Частная собственность" },
  "binInfo": { "registrationYearMonth": "2015-01", "entityType": "resident_legal_entity", "unitType": "head_office" },
  "matchedQuery": "150140010013",
  "lookupStatus": "found",
  "language": "ru",
  "source": "State register of legal entities (Ministry of Justice of the Republic of Kazakhstan) via data.egov.kz + Statistical business register (Bureau of National Statistics, stat.gov.kz)",
  "sources": ["registry", "statistics"],
  "sourceUrls": ["https://data.egov.kz/datasets/getdata?index=gbd_ul&…", "https://old.stat.gov.kz/api/juridical/counter/api/?bin=150140010013&lang=ru"],
  "retrievedAt": "2026-09-26T10:00:00.000Z",
  "fromCache": false,
  "original": { "registry": { "…": "…" }, "statistics": { "…": "…" } }
}
```

- `statusCategory` is one of `active`, `liquidated`, `suspended`, `in_process`, `other` or `unknown`. It's derived from the official status text, which is always kept unchanged in `status`.
- `legalFormCode` is one of `LLP` (ТОО), `ALP` (ТДО), `JSC` (АО), `BRANCH`, `REPRESENTATIVE_OFFICE`, `STATE_ENTERPRISE`, `STATE_INSTITUTION`, `COOPERATIVE`, `PUBLIC_ASSOCIATION`, `FOUNDATION`, `INSTITUTION`, `ASSOCIATION` or `null`. It's read from the registered name.
- Fields that a source doesn't provide are `null`. The statistics fields (`size`, `katoCode`, `economicSector`, `ownershipForm`, `secondaryActivityCodes`) come only from stat.gov.kz.
- `retrievedAt` is when the data was fetched from the official source. For cached answers, that's the original fetch time.
- Name-search results also have `matchScore` (1 = exact name).
- If a source failed but the other answered, the item has a `warnings` list.

When nothing is found, or the BIN is invalid, you still get an item. These items are free:

```json
{ "found": false, "bin": "230150000014", "lookupStatus": "not_found", "error": "BIN not found in the official sources queried." }
{ "found": false, "bin": "150140010014", "matchedQuery": "150140010014", "lookupStatus": "invalid", "error": "Invalid BIN: the check digit (12th digit) does not match. Check for a typo." }
```

`lookupStatus: "error"` means that no source could answer, for example because it was blocked or down. The run's key-value store has an `OUTPUT` summary with counts, charged events, cache hits and any unavailable sources.

## Use it from AI agents

This Actor works as a tool for AI agents (Apify MCP server, OpenAI / Claude tool calling, LangChain, Make, n8n, Zapier):

- The input is small and predictable: `{"bins": ["…"]}` or `{"names": ["…"], "maxResults": 3}`.
- The output is flat, with English keys and an explicit answer for every query (`found`, `lookupStatus`, `error`).
- Every record states where it came from (`source`, `sourceUrls`) and when it was retrieved (`retrievedAt`).
- Invalid BINs are explained ("check digit does not match", "this is an IIN, not a BIN") instead of being silently dropped.

Example agent prompt: *"Verify that BIN 971240001315 is an active Kazakh company and give me its legal form, director and registration date."*

## Pricing

**Pay per event: $0.01 per company found** (`company-result`), i.e. $10 per 1,000 companies.

- Not-found BINs, invalid BINs and failed lookups are **free**.
- Results served from the cache are charged like fresh results. The cache speeds up your runs and protects the government servers.
- Set a **maximum cost per run** and the Actor stops cleanly when it's reached. It never charges more than the limit.
- If you enable Apify Proxy, proxy traffic is billed by Apify as usual. Responses are small (a few KB per company).

## Data sources and freshness

| Source | What it gives | How it's accessed |
|---|---|---|
| **State register of legal entities**, Ministry of Justice (dataset `gbd_ul` on [data.egov.kz](https://data.egov.kz/datasets/view?index=gbd_ul)) | BIN, full name (ru/kz), registration date, status, legal address (ru/kz), activity (ru/kz), director | Without a key: the portal's public dataset viewer (`/datasets/getdata`). With `egovApiKey`: the official open-data API v4 (`/api/v4/gbd_ul/v1`). |
| **Statistical business register**, Bureau of National Statistics ([stat.gov.kz](https://stat.gov.kz/en/juridical/by/bin/)) | OKED primary and secondary codes, size class (KRP), KATO code and address, sector (KSE), ownership form (KFS), head's name | Public BIN-search API (`/api/juridical/counter/api/?bin=…&lang=…`) |

- **Freshness**: both sources are official live services, not a snapshot. The state register dataset on data.egov.kz is updated by the Ministry of Justice (independent mirrors refresh it weekly). The statistical register is updated by the Bureau of National Statistics.
- **Not included**: founders / shareholders, beneficial owners, tax debts and financial statements. These are not in the public sources above. Short names and founders exist in the official register but are not published in this open dataset.
- **Legal force**: this is information from public open-data services, not an official extract. For legally binding certificates, use [egov.kz](https://egov.kz/cms/ru/services/e_032) (service "Information about a registered legal entity").
- **API key**: a free data.egov.kz API key is issued in the portal's developer cabinet after registration on the portal. It's optional.

This Actor only queries public endpoints of official portals, one BIN at a time, at low concurrency and with caching. It doesn't solve captchas, log in or bypass access controls. The tax authority's taxpayer search (kgd.gov.kz) is not used.

## Access from outside Kazakhstan

Kazakh government portals sometimes block, throttle or silently drop connections from IP addresses outside Kazakhstan. The Actor detects this: it retries with backoff, marks a source as unavailable after repeated failures (so the run doesn't hang), and tells you what to do. If all sources are unreachable, the run fails with a clear message and nothing is charged.

**Fix**: open **Proxy configuration**, enable **Apify Proxy**, select the **RESIDENTIAL** group and country **Kazakhstan (KZ)**. Each retry uses a new proxy IP.

## Personal data and responsible use

Records include the names of company heads (directors) as published by the state. Process them lawfully, e.g. under the Law of the Republic of Kazakhstan "On personal data and their protection" and GDPR where it applies, and only for legitimate purposes such as KYB and compliance. Please credit the Ministry of Justice of the Republic of Kazakhstan (data.egov.kz) and the Bureau of National Statistics (stat.gov.kz) when you republish data.

## FAQ

**What is a BIN?** The *Бизнес-идентификационный номер* (BIN, Kazakh БСН) is the 12-digit identifier of a legal entity, branch or representative office in Kazakhstan. Individuals have an IIN instead.

**Why is my BIN "invalid"?** The last digit of every BIN is a check digit calculated from the other 11. A mismatch almost always means a typo. If you are sure the BIN is right, set `validateChecksum` to `false`.

**Can I look up individual entrepreneurs (ИП) by IIN?** No. The register used here covers legal entities, branches and representative offices.

**Why are `size` / `katoCode` empty?** They come from stat.gov.kz. That source didn't answer (see `warnings`) or doesn't have the company.

**Does name search work in Latin letters?** Names are searched as registered, usually in Cyrillic. Search "Казахтелеком", not "Kazakhtelecom".
