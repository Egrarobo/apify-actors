# PDF to Excel: Invoice & Table Extractor

Turn **PDF invoices and PDF tables into rows** you can open in **Excel, Google Sheets or CSV**, or send to **n8n, Make, Zapier** and your database.

- **Invoices, bills, purchase orders:** supplier, invoice number, invoice date, due date, PO number, customer, VAT/tax ID, currency, subtotal, tax rate, tax amount, total, IBAN, and **one row per line item** (description, SKU, quantity, unit, unit price, VAT, amount).
- **Any other PDF** (price lists, statistical reports, schedules, statements): **every table becomes rows**, with the column names from the table header.
- **No AI model and no API key.** The PDF's text layer is read with open-source tools (pdfplumber), so results are repeatable and your documents are not sent to any AI service.
- **Totals are cross-checked:** each line is checked (quantity × unit price = amount) and the lines are checked against the subtotal and total, so you see at once which invoices need a human look.
- **$6 per 1,000 PDF pages with data.** Pages without any table, failed downloads and scanned pages are free.

## What you get

### Invoices: one row per line item

Real output for the sample invoice [`invoice-us-ruled.pdf`](https://raw.githubusercontent.com/Egrarobo/apify-actors/main/pdf-tables-to-rows/samples/invoice-us-ruled.pdf) (a fictional invoice with a bordered item table):

```json
{
  "fileName": "invoice-us-ruled.pdf",
  "documentType": "invoice",
  "rowType": "invoice-line",
  "page": 1,
  "lineIndex": 1,
  "description": "Copy paper A4, 80 g, box of 5 reams",
  "sku": "PAP-A4-80",
  "quantity": 12,
  "unitPrice": 24.9,
  "lineTotal": 298.8,
  "lineCheck": "ok",
  "invoiceNumber": "INV-2026-0142",
  "invoiceDate": "2026-09-15",
  "dueDate": "2026-10-15",
  "poNumber": "PO-7781",
  "supplierName": "Larkspur Sample Supply Co.",
  "supplierTaxId": "00-0000142",
  "customerName": "Bluebird Sample Bakery LLC",
  "currency": "USD",
  "subtotal": 664.17,
  "taxRate": 8,
  "taxAmount": 53.13,
  "total": 717.3,
  "linesSum": 664.17,
  "totalsCheck": "ok",
  "status": "ok"
}
```

European invoices work too: decimal commas (`1.150,00`), dates like `30.09.2026`, VAT per line, borderless tables and item tables that continue on the next page. Real output for line 4 of the 2-page sample [`invoice-eu-2-pages.pdf`](https://raw.githubusercontent.com/Egrarobo/apify-actors/main/pdf-tables-to-rows/samples/invoice-eu-2-pages.pdf):

```json
{
  "page": 1,
  "lineIndex": 4,
  "description": "Content updates",
  "quantity": 6.5,
  "unit": "h",
  "unitPrice": 42,
  "lineTaxRate": 21,
  "lineTotal": 273,
  "lineCheck": "ok",
  "invoiceNumber": "2026/0387",
  "invoiceDate": "2026-09-30",
  "dueDate": "2026-10-14",
  "supplierName": "Wrenfield Sample Web Studio B.V.",
  "supplierTaxId": "NL000000000B01",
  "customerName": "Harbor Lane Sample Clinic",
  "currency": "EUR",
  "subtotal": 3800.9,
  "taxRate": 21,
  "taxAmount": 798.19,
  "total": 4599.09,
  "totalsCheck": "ok",
  "iban": "NL00EXMP0000000000"
}
```

All 14 lines of that invoice (9 on page 1, 5 on page 2) come out as 14 rows, and their sum (3,800.90) matches the subtotal.

### Any PDF: one row per table row

Real output for the USDA [Weekly Combined Regional Shell Egg Report](https://www.ams.usda.gov/mnreports/ams_2848.pdf) (a public US government price report, 2 pages, 7 borderless tables):

```json
{
  "fileName": "usda-shell-eggs-2026-10-02.pdf",
  "documentType": "tables",
  "rowType": "table-row",
  "page": 1,
  "tableIndex": 1,
  "tableTitle": "National Shell Eggs - Caged · Delivered Warehouse, White, Cents Per Dozen",
  "hasHeader": true,
  "rowIndex": 1,
  "data": {
    "Class": "Extra Large",
    "Price Range": "61.00 - 94.00",
    "Average Price": 81.88,
    "Price Change": 1,
    "Last Reported (9/25/2026)": 80.88
  }
}
```

Export the dataset to **CSV or Excel** and every key of `data` becomes its own column. The 34-page USDA [retail specialty crops report](https://www.ams.usda.gov/mnreports/fvwretail.pdf) gives **1,099 rows from 32 tables** in one run.

### One Excel file for the whole run

With **Save one Excel file** on (default), the run also saves `OUTPUT.xlsx` in its key-value store: a sheet **Invoice lines**, a sheet **Invoices** (one row per invoice with the totals and checks) and **one sheet per table**. The link is in the run's **Output** tab and in the `OUTPUT` summary record.

## How to use it

1. Paste links to your PDFs into **PDF URLs**. Google Drive, Dropbox, OneDrive/SharePoint, Box and GitHub share links work (share them as *Anyone with the link*). You can also use files uploaded to a key-value store, or a dataset of PDF links from a crawler.
2. Keep **What to extract = Auto**, or choose **Invoices** or **Tables**.
3. Click **Start**. Download the results as Excel, CSV or JSON, open `OUTPUT.xlsx`, or read them through the API.

## Input example

```json
{
  "urls": [
    { "url": "https://raw.githubusercontent.com/Egrarobo/apify-actors/main/pdf-tables-to-rows/samples/invoice-us-ruled.pdf" },
    { "url": "https://www.ams.usda.gov/mnreports/ams_2848.pdf" }
  ],
  "mode": "auto",
  "tableDetection": "auto",
  "parseNumbers": true,
  "dateOrder": "auto",
  "saveExcel": true
}
```

| Field | What it does |
|---|---|
| `urls` | PDF links (share links are converted automatically) |
| `kvStoreFileNames`, `kvStoreId` | PDFs uploaded to an Apify key-value store, as `"storeName/file.pdf"` or `"file.pdf"` + `kvStoreId` |
| `datasetId`, `datasetUrlField` | PDF links taken from another Actor's dataset |
| `mode` | `auto` (default), `invoice` or `tables` |
| `tableDetection` | `auto` (tables with borders, then borderless), `lines` or `text` |
| `parseNumbers` | `true`: `1,234.50`, `1.234,50`, `$12` and `(15.00)` become numbers. Percentages and codes with leading zeros stay text |
| `dateOrder` | `auto`, `DMY` or `MDY`, only for ambiguous dates like `03/04/2026`. Invoice dates are returned as `YYYY-MM-DD` |
| `pdfPassword` | Password for protected PDFs |
| `maxPagesPerDocument`, `maxDocuments`, `maxFileSizeMb` | Limits (0 pages = all) |

## Output fields

| Field | Meaning |
|---|---|
| `status` | `ok`, `no-data` (no table or invoice found, not charged) or `failed` (with `error`, not charged) |
| `rowType` | `invoice-line`, `invoice` (invoice fields found but no item table) or `table-row` |
| `lineCheck` | `ok` when quantity × unit price = amount (discounts allowed), `mismatch`, or `computed` when the amount was missing |
| `totalsCheck` | `ok` when the lines add up to the subtotal (or total) and subtotal + tax = total; `mismatch` means: look at this invoice |
| `otherColumns` | item-table columns that are not one of the standard fields |
| `tableTitle` | the line(s) printed right above a borderless table |
| `tableMethod` | `lines` (table with cell borders) or `text` (aligned columns) |

The `OUTPUT` record has the run summary: PDFs with data, without data and failed, rows, pages charged, the Excel link and all errors.

## Pricing

**Pay per page with data.**

| Event | Price |
|---|---|
| PDF page with data | **$0.006** per page ($6 per 1,000 pages) on the Free plan; $5.50 on Starter, $5 on Scale, $4.50 on Business |

A page is charged only if it produced at least one row (an invoice line, an invoice field or a table row). Cover pages, terms and conditions, scanned pages, failed downloads and files that are not PDFs are **free**. A 1-page invoice costs $0.006; 1,000 two-page invoices cost about $12.

Set a **maximum cost per run** and the Actor reads only the pages that fit, then stops cleanly. **Max pages per PDF** caps long files.

## Use it in n8n, Make or Zapier

Call the Actor with an HTTP request and get the rows back in the same call:

```bash
curl -X POST "https://api.apify.com/v2/acts/egra_van~pdf-invoice-table-extractor/run-sync-get-dataset-items" \
  -H "Authorization: Bearer $APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"urls": [{"url": "https://raw.githubusercontent.com/Egrarobo/apify-actors/main/pdf-tables-to-rows/samples/invoice-eu-2-pages.pdf"}], "mode": "invoice"}'
```

Typical flow: *new invoice PDF in Gmail or Google Drive → this Actor → append the rows to Google Sheets or your accounting tool*, and send invoices with `totalsCheck = mismatch` to a person.

**AI agents** (Claude, ChatGPT, Cursor, n8n AI Agent) can use it through the Apify MCP server: `https://mcp.apify.com?tools=egra_van/pdf-invoice-table-extractor`.

## Limits, said plainly

- **Scanned PDFs (photos or scans without a text layer) are not read.** The Actor reports them as `no-data` and does not charge. If you can, export the PDF from the original program, or OCR it first.
- Invoice fields are found next to their usual labels in English, Romanian, German, French, Dutch, Spanish and Italian (`Invoice No`, `Factura nr`, `Rechnungsnummer`, `Bill to`, `Total due`, `TVA`, `MwSt`...). An unusual layout may leave some fields empty; the line items and table rows still come out.
- The supplier name is taken from a label (`From`, `Supplier`, `Furnizor`...) or, if there is none, from the largest text at the top of page 1.
- Very complex tables (cells merged over several rows and columns) can come out with `col_1`, `col_2`... names instead of the header text. Check `hasHeader`.

## FAQ

**Is my data stored or used for AI training?** No AI service sees your files. They are downloaded into your own Apify run; the results stay in your Apify storage under your retention settings.

**Can it read Word or Excel files?** No, only PDF. For Word, Excel and PowerPoint, use our *Document to Markdown* Actor.

**Why are some numbers text?** Percentages (`21%`), ranges (`61.00 - 94.00`) and codes with leading zeros (`00123`) are kept as written. Turn off `parseNumbers` to keep every cell exactly as printed.

**Where do the sample PDFs come from?** The two invoices are fictional samples made for this Actor (public domain, CC0). The egg price and petroleum reports are public US government documents (USDA AMS and EIA).
