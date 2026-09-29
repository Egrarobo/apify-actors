# Bulk Certificate & Diploma PDF Generator

Turn a list of names into **print-ready PDF certificates and diplomas** in seconds. Paste a Google Sheet link, pick a design, and get one PDF per person, plus a ZIP of everything and (optionally) one merged PDF for printing.

Built for **schools, online course creators, training companies, event organizers, coding clubs and HR teams** who hand out certificates in batches.

## What it does

- 📄 **One PDF per row** of your Google Sheet, CSV or JSON list
- 🎨 **3 ready designs**: Classic certificate, Modern certificate, Kids diploma, or **your own HTML/CSS**
- ✍️ **Personalize any text** with `{{column}}` placeholders: `{{name}}`, `{{course}}`, `{{hours}}`, `{{grade}}`, anything in your sheet
- 🔐 **QR verification codes** and unique certificate IDs (e.g. `SCHOOL-2026-0001`)
- 🌍 **Full Unicode**: accents and diacritics (é, ü, ș, ț, ă…) and **Cyrillic** render correctly, with embedded fonts
- 📦 **ZIP download** of all PDFs and an optional **merged PDF** for one-click printing
- 🖨️ A4 or US Letter, landscape or portrait
- ⚡ About 200 certificates per minute

## How to use it

1. Put your list in a Google Sheet. First row = column names, e.g. `name | course | date`.
2. Share the sheet: **Anyone with the link → Viewer**.
3. Paste the link into **Google Sheet or CSV link**.
4. Choose a design, write your title and text (use `{{course}}` etc. to insert columns).
5. Click **Start**. Download the ZIP or the individual PDFs from the **Output** tab.

## Input example

```json
{
  "csvUrl": "https://docs.google.com/spreadsheets/d/XXXX/edit#gid=0",
  "template": "certificate-classic",
  "title": "Certificate",
  "subtitle": "of completion",
  "body": "Awarded for successfully completing {{course}} ({{hours}} hours).",
  "date": "{{date}}",
  "issuer": "Bright Minds Academy",
  "signature1Name": "Jane Doe",
  "signature1Title": "Director",
  "accentColor": "#1f4e8c",
  "addQrCode": true,
  "verifyUrlTemplate": "https://brightminds.example/verify?id={{certificateId}}",
  "certificateIdPrefix": "BMA-2026-",
  "mergeIntoOnePdf": true
}
```

You can also pass rows directly with `records` (JSON array), `csvText` (pasted CSV), or `datasetId` (items from another Apify Actor).

## Output

Each generated document appears in the dataset:

```json
{
  "name": "Maria Popescu",
  "fileName": "Maria Popescu.pdf",
  "certificateId": "BMA-2026-0001",
  "pdfUrl": "https://api.apify.com/v2/key-value-stores/.../records/0001-maria-popescu.pdf"
}
```

The run's key-value store also contains:

- `all-documents.zip`: every PDF in one ZIP
- `all-documents-merged.pdf`: all certificates in one file (if enabled)
- `OUTPUT`: summary with links

## Pricing

**Pay per document.** You only pay for PDFs that are actually generated. Empty rows are skipped for free. You can set a maximum spend per run, and the Actor stops cleanly when it is reached.

## Your own design

Choose **Custom HTML** and write your page with placeholders:

```html
<div class="page" style="padding:30mm; font-family:'Playfair Display'">
  <h1>{{name}}</h1>
  <p>completed {{course}} on {{date}}</p>
  <img src="{{qrDataUrl}}" style="width:25mm">
</div>
```

Available fonts: **Montserrat, Playfair Display, Great Vibes** (script), **Lora**. All values are HTML-escaped automatically.

## Automate it

Run it from **Make, Zapier, n8n** or the Apify API. For example, when a student finishes a course in your LMS, add a row and generate the certificate automatically. The `pdfUrl` in the output can be emailed directly.

## FAQ

**My Google Sheet link doesn't work.** Set sharing to *Anyone with the link can view*. You can also use *File → Share → Publish to web → CSV*.

**Can I use a different name column?** Yes, set **Name column** (e.g. `full_name`).

**Can each person get a different course or date?** Yes. Add a column and reference it with `{{column}}`.

**Is my data stored?** Only in your own Apify storage for this run, under your account's retention settings.

## n8n template

Send every person their certificate by email straight from a Google Sheet: import [this ready-made n8n workflow](https://github.com/Egrarobo/apify-actors/blob/main/n8n-templates/certificates-from-google-sheets.json) (Workflows → Import from file). It calls this Actor with an HTTP Request node, so no community node is needed.
