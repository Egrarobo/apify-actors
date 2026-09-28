# Document to Markdown for AI & RAG

Convert **PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX), CSV, HTML and TXT** files into **clean Markdown or plain text** for **LLMs, ChatGPT, Claude, LangChain, LlamaIndex and RAG pipelines**. Headings, lists and tables are preserved, documents are split into **token-sized chunks with page numbers and section headings**, and **scanned PDFs can be OCR'd**.

Give it a list of links (Google Drive, Dropbox, OneDrive and GitHub links work too) and get back one dataset item per chunk, ready to embed into Pinecone, Qdrant, Weaviate, Chroma, pgvector or any vector database.

## What it does

- 📄 **PDF to Markdown**: paragraphs rebuilt from the text layer, headings detected from font sizes, bullet lists, simple tables as Markdown tables, running headers/footers and page numbers removed, hyphenated words re-joined, multi-column layouts kept in reading order
- 📝 **Word (DOCX) to Markdown**: headings, bold/italic, links, nested lists and tables
- 📊 **PowerPoint (PPTX)**: every slide with its title, bullet levels, tables and **speaker notes**
- 📈 **Excel (XLSX), CSV, TSV**: every sheet as a Markdown table, dates normalised, formula results used
- 🌐 **HTML pages**: main content only (navigation, footers, scripts removed), tables converted
- ✂️ **RAG chunking**: by heading (one section per chunk) or fixed size with overlap, measured in **tokens** (cl100k_base, the tokenizer of OpenAI embeddings) or characters. Tables that are too big are split by rows with the **header row repeated** in every chunk
- 🏷️ **Metadata per chunk**: source URL, file name, page range, heading path (e.g. `2. Methodology > 2.1 Chunking strategy`), chunk index, token count
- 🔍 **OCR for scanned PDFs and images** (English, Romanian, Russian). Pages that already have text are never OCR'd. Without OCR, scanned pages are detected and reported
- 🔗 **Share links just work**: Google Drive, Google Docs/Sheets/Slides (exported automatically), Dropbox, OneDrive, SharePoint, Box, GitHub
- 🧯 **One bad file doesn't stop the run**: failed documents get a dataset item with a clear error message

## How to use it

1. Paste links to your documents into **Document URLs** (or reference files in a key-value store, or a dataset of URLs from a crawler).
2. Pick **Markdown** or **Plain text**.
3. For RAG, choose **Chunking → By heading** or **Fixed size**, e.g. 800 tokens with 100 tokens overlap.
4. Turn on **OCR** if some PDFs are scans.
5. Click **Start** and download the results as JSON, CSV or Excel, or read them through the API.

## Input example

```json
{
  "urls": [
    { "url": "https://arxiv.org/pdf/1706.03762" },
    { "url": "https://drive.google.com/file/d/FILE_ID/view?usp=sharing" },
    { "url": "https://example.com/handbook.docx" }
  ],
  "outputFormat": "markdown",
  "chunking": "heading",
  "chunkSize": 800,
  "chunkSizeUnit": "tokens",
  "chunkOverlap": 100,
  "includePageNumbers": false,
  "ocr": true,
  "ocrLanguages": ["eng"]
}
```

Other sources:

- `keyValueStoreKeys`: files you uploaded to an Apify key-value store, as `"storeName/key"` or just `"key"` with `keyValueStoreId`
- `datasetId` + `datasetUrlField`: take URLs from another Actor's output (e.g. a website crawler that collected PDF links)

## Output

One dataset item per chunk (or per document when chunking is off):

```json
{
  "sourceUrl": "https://example.com/annual-report.pdf",
  "fileName": "annual-report.pdf",
  "fileType": "pdf",
  "pages": 3,
  "chunkIndex": 2,
  "chunkCount": 9,
  "text": "## 1.1 Key numbers\n\n| Quarter | Revenue | Students |\n| --- | --- | --- |\n| Q1 | 12,500 | 140 |\n| Q2 | 15,200 | 171 |",
  "tokenCount": 71,
  "charCount": 187,
  "documentUrl": "https://api.apify.com/v2/key-value-stores/.../records/0001-annual-report.md",
  "metadata": {
    "title": "Annual Report 2026",
    "totalPages": 3,
    "pagesEstimated": false,
    "pageStart": 1,
    "pageEnd": 1,
    "headings": ["1. Introduction", "1.1 Key numbers"],
    "headingPath": "1. Introduction > 1.1 Key numbers"
  },
  "status": "ok"
}
```

- `documentUrl`: the **full Markdown file** of the document in the run's key-value store (plus `textUrl` in plain-text mode)
- `metadata.ocrPages`: pages that were read with OCR, e.g. `"1-5"`
- `metadata.scannedPagesWithoutText`: scanned pages that were **not** read because OCR was off
- `metadata.warnings`: anything worth knowing (truncated sheets, formulas without saved values, page limits)
- Failed documents: `{ "sourceUrl": "...", "status": "failed", "error": "Download failed: HTTP 403 Forbidden. The file is private: share it as \"Anyone with the link can view\"." }`

The key-value store record `OUTPUT` has a run summary: documents succeeded/failed, pages, OCR pages, chunks and all errors.

## Pricing

**Pay per page.** You pay only for pages that are converted:

| Event | Price | When |
|---|---|---|
| Page processed | $0.0015 ($1.50 per 1,000 pages) | Each PDF page or PowerPoint slide. For formats without pages (DOCX, XLSX, CSV, HTML, TXT) every 3,000 characters of output count as one page |
| OCR page | + $0.005 ($5 per 1,000 pages) | Each scanned page or image read with OCR (only when OCR is on) |

Failed downloads and unsupported files are free. Set a **maximum cost per run** and the Actor converts only what fits in it, then stops cleanly. Use **Max pages per document** to cap long files.

## Supported formats

| Format | Notes |
|---|---|
| PDF | Text-layer PDFs; scanned pages with OCR. Password-protected PDFs are reported as errors |
| DOCX / DOCM | Word 2007+. Save legacy `.doc` as `.docx` |
| PPTX / PPTM | Slides in presentation order, speaker notes optional |
| XLSX / XLSM | All visible sheets, up to 100,000 rows each. Save legacy `.xls` as `.xlsx` |
| CSV / TSV | Delimiter auto-detected; UTF-8 (other encodings best-effort) |
| HTML | Main content extraction |
| TXT / Markdown / JSON / XML | Passed through as text |
| PNG / JPG / TIFF / WebP / BMP | OCR only |

## Use with LangChain, LlamaIndex, n8n, Make

Each item's `text` + `metadata` maps directly to a LangChain `Document(page_content, metadata)` or a LlamaIndex `TextNode`. Use the Apify integration for LangChain/LlamaIndex, or call the Actor from **Make, Zapier or n8n** and send the chunks to your vector database. The `pageStart`, `pageEnd` and `headingPath` fields let your chatbot **cite the exact page and section** of its answer.

## FAQ

**Are tables in PDFs supported?** Tables whose columns are clearly separated are rebuilt as Markdown tables. Complex tables (merged cells, no spacing, tables drawn as images) may come out as plain lines. DOCX, PPTX, XLSX and HTML tables are converted exactly.

**What about scanned PDFs?** Turn on **OCR**. Only pages without a text layer are OCR'd (≈2–3 seconds per page). Without OCR, the Actor tells you which pages are scanned.

**How big can files be?** Up to 100 MB by default (`maxFileSizeMb`, max 500 MB). A 300-page PDF converts in a few seconds.

**My Google Drive link fails.** Share the file as *Anyone with the link can view*. Google Docs, Sheets and Slides are exported to DOCX, XLSX and PPTX automatically.

**Why tokens?** Embedding models and LLM context windows are limited in tokens, not characters. Token counts use `cl100k_base` (OpenAI `text-embedding-3-*`, GPT-4); other tokenizers are usually within ±15%.

**Is my data stored?** Only in your own Apify storage for this run, under your account's retention settings.
