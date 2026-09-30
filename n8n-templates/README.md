# n8n templates

Ready-to-import n8n workflows that use these Actors through the Apify API.

| Workflow | Actor | What it does |
|---|---|---|
| [certificates-from-google-sheets.json](certificates-from-google-sheets.json) | [Bulk Certificate & Diploma PDF Generator](https://apify.com/egra_van/bulk-certificate-pdf-generator) | Reads people from Google Sheets, generates one PDF certificate each, emails it with Gmail |
| [document-to-markdown-rag.json](document-to-markdown-rag.json) | [Document to Markdown for AI & RAG](https://apify.com/egra_van/document-to-markdown) | Form to add PDF/Word/PowerPoint links, converts them to Markdown chunks, stores them in a vector store, and answers questions in a chat with file and page citations |
| [google-trends-content-ideas.json](google-trends-content-ideas.json) | [Google Trends Scraper](https://apify.com/egra_van/google-trends-reliable) | Every week finds rising Google searches for your seed keywords, keeps only relevant new ones, writes an SEO content brief for each with OpenAI and saves them to Google Sheets |
| [competitor-website-monitor.json](competitor-website-monitor.json) | [Dataset Change Monitor](https://apify.com/egra_van/dataset-change-monitor) + [Website Screenshot Pro](https://apify.com/egra_van/website-screenshot-pro) | Checks competitor pages every day, finds added and removed lines, takes a screenshot of changed pages, summarizes important changes with OpenAI, emails them and logs them in Google Sheets |

## Import

In n8n: **Workflows → Import from file** (or paste the JSON into the canvas).

All workflows call Apify with an **HTTP Request** node, so they work on n8n Cloud and self-hosted without community nodes. Create one **Header Auth** credential:

- Name: `Authorization`
- Value: `Bearer YOUR_APIFY_TOKEN` (Apify Console → Settings → API & Integrations)
