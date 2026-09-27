import { Actor, log } from 'apify';
import { collectSources, fetchSource, detectType } from './sources.js';
import { convertPdf, compactRanges } from './converters/pdf.js';
import { convertDocx } from './converters/docx.js';
import { convertPptx } from './converters/pptx.js';
import { convertXlsx, convertCsv } from './converters/sheet.js';
import { convertHtml, decodeText } from './converters/html.js';
import { ocrImage, terminateOcr, OCR_LANGUAGES } from './ocr.js';
import { chunkBlocks } from './chunk.js';
import { mdToBlocks, mdToText, tidyMarkdown, countTokens } from './markdown.js';

const EVENT_PAGE = 'page-processed';
const EVENT_OCR = 'ocr-page';
const CHARS_PER_PAGE = 3000;          // billing estimate for formats without real pages (DOCX, HTML, XLSX, TXT…)
const MAX_ITEM_CHARS = 3_000_000;     // keep dataset items well under Apify's 9 MB item limit

const UNSUPPORTED = {
    doc: 'Legacy Word .doc is not supported. Save it as .docx (File → Save as) and try again.',
    ppt: 'Legacy PowerPoint .ppt is not supported. Save it as .pptx and try again.',
    xls: 'Legacy Excel .xls is not supported. Save it as .xlsx and try again.',
    ole: 'Legacy Office format (.doc/.ppt/.xls) is not supported. Save it as .docx/.pptx/.xlsx.',
    odt: 'OpenDocument (.odt) is not supported yet. Export it as .docx or PDF.',
    odp: 'OpenDocument (.odp) is not supported yet. Export it as .pptx or PDF.',
    ods: 'OpenDocument (.ods) is not supported yet. Export it as .xlsx or CSV.',
    epub: 'EPUB is not supported yet. Convert it to PDF or HTML.',
    rtf: 'RTF is not supported. Save it as .docx.',
    zip: 'ZIP archives are not supported. Provide the documents inside it as separate files.',
    unknown: 'Unrecognised file type. Supported: PDF, DOCX, PPTX, XLSX, CSV, TSV, HTML, TXT, Markdown (and images with OCR).',
};

const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

const isPlainParagraph = (b) => !b.heading && !b.isTable && !/^\s*([-*+>|]|\d+\.|```|<!--)/.test(b.md);
const isOpenParagraph = (b) => isPlainParagraph(b) && !/[.!?:;…"”)\]]\s*$/.test(b.md);

/** Convert a downloaded file to { title, paged, totalPages, pages:[{page, md}] | markdown, warnings, ocrPages, scannedPages }. */
async function convert(type, buffer, ctx) {
    const { opts, beforeOcrPage } = ctx;
    switch (type) {
        case 'pdf': {
            const r = await convertPdf(buffer, { maxPages: opts.maxPagesPerDocument, ocr: opts.ocr, ocrLanguages: opts.ocrLanguages, beforeOcrPage });
            return {
                ...r, paged: true,
                ocrPages: r.pages.filter((p) => p.ocr).map((p) => p.page),
                scannedPages: r.pages.filter((p) => p.scanned).map((p) => p.page),
            };
        }
        case 'pptx': {
            const r = await convertPptx(buffer, { maxPages: opts.maxPagesPerDocument, includeNotes: opts.includeSpeakerNotes });
            return { ...r, paged: true };
        }
        case 'docx': return convertDocx(buffer);
        case 'xlsx': return convertXlsx(buffer);
        case 'csv': return convertCsv(buffer);
        case 'tsv': return convertCsv(buffer, { delimiter: '\t' });
        case 'html': return convertHtml(buffer);
        case 'md': case 'txt': return { title: '', markdown: tidyMarkdown(decodeText(buffer)), warnings: [] };
        case 'image': {
            if (!opts.ocr) throw new Error('This is an image. Enable "ocr" to extract its text.');
            if (!(await beforeOcrPage())) throw new Error('Spending limit reached before OCR.');
            const { markdown, confidence } = await ocrImage(buffer, opts.ocrLanguages);
            return { title: '', paged: true, totalPages: 1, pages: [{ page: 1, md: markdown, ocr: true, ocrConfidence: confidence }], ocrPages: [1], warnings: confidence < 60 ? [`Low OCR confidence (${confidence}%).`] : [] };
        }
        default: throw new Error(UNSUPPORTED[type] ?? UNSUPPORTED.unknown);
    }
}

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const opts = {
        outputFormat: input.outputFormat === 'text' ? 'text' : 'markdown',
        chunking: ['none', 'heading', 'fixed'].includes(input.chunking) ? input.chunking : 'none',
        chunkSize: Number(input.chunkSize ?? 800),
        chunkOverlap: Number(input.chunkOverlap ?? 100),
        chunkSizeUnit: input.chunkSizeUnit === 'characters' ? 'characters' : 'tokens',
        includePageNumbers: input.includePageNumbers ?? false,
        includeSpeakerNotes: input.includeSpeakerNotes ?? true,
        maxPagesPerDocument: Math.max(0, Number(input.maxPagesPerDocument ?? 0)),
        ocr: input.ocr ?? false,
        ocrLanguages: (Array.isArray(input.ocrLanguages) && input.ocrLanguages.length ? input.ocrLanguages : ['eng']),
        maxFileSizeMb: Number(input.maxFileSizeMb ?? 100),
        maxDocuments: Number(input.maxDocuments ?? 1000),
    };
    const badLang = opts.ocrLanguages.find((l) => !OCR_LANGUAGES.includes(l));
    if (badLang) throw new Error(`OCR language "${badLang}" is not available. Use: ${OCR_LANGUAGES.join(', ')}.`);
    if (opts.chunking !== 'none' && (!(opts.chunkSize >= 50) || opts.chunkSize > 100000)) throw new Error('chunkSize must be between 50 and 100000.');
    if (!(opts.chunkOverlap >= 0)) throw new Error('chunkOverlap must be 0 or more.');
    if (opts.chunking !== 'none' && opts.chunkOverlap > opts.chunkSize / 2) {
        log.warning(`chunkOverlap (${opts.chunkOverlap}) is more than half of chunkSize; using ${Math.floor(opts.chunkSize / 2)}.`);
        opts.chunkOverlap = Math.floor(opts.chunkSize / 2);
    }

    let sources = await collectSources(input);
    if (!sources.length) throw new Error('No documents to process. Add file links to "urls", key-value store keys to "keyValueStoreKeys", or a "datasetId" with URLs.');
    if (sources.length > opts.maxDocuments) {
        log.warning(`Limiting to the first ${opts.maxDocuments} of ${sources.length} documents (maxDocuments).`);
        sources = sources.slice(0, opts.maxDocuments);
    }

    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    const kvs = await Actor.openKeyValueStore();
    const unit = opts.chunkSizeUnit === 'tokens' ? countTokens : (s) => s.length;
    const measure = opts.outputFormat === 'text' ? (s) => unit(mdToText(s)) : unit;
    const render = (md) => (opts.outputFormat === 'text' ? mdToText(md) : tidyMarkdown(md));

    let stoppedByLimit = false;
    const beforeOcrPage = async () => {
        const r = await Actor.charge({ eventName: EVENT_OCR });
        if (isPpe && r.chargedCount < 1) { stoppedByLimit = true; return false; }
        return true;
    };

    const summary = { documentsTotal: sources.length, documentsSucceeded: 0, documentsFailed: 0, pagesProcessed: 0, ocrPages: 0, chunks: 0, failures: [] };
    log.info(`Processing ${sources.length} document(s): format=${opts.outputFormat}, chunking=${opts.chunking}${opts.ocr ? `, OCR (${opts.ocrLanguages.join('+')})` : ''}.`);

    for (let i = 0; i < sources.length; i++) {
        if (stoppedByLimit || (isPpe && chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_PAGE) < 1)) {
            log.warning(`Stopped before document ${i + 1}/${sources.length}: the run reached the spending limit you set.`);
            break;
        }
        const src = sources[i];
        const sourceUrl = src.url ?? `kvs://${src.storeId ?? 'default'}/${src.key}`;
        let fileName = src.key ?? (() => { try { return decodeURIComponent(new URL(src.url).pathname.split('/').pop()) || src.url; } catch { return src.url; } })();
        const started = Date.now();
        try {
            const dl = await fetchSource(src, { maxBytes: opts.maxFileSizeMb * 1e6 });
            fileName = dl.fileName;
            if (!dl.buffer.length) throw new Error('The file is empty.');
            const fileType = await detectType(dl.buffer, dl.fileName, dl.contentType);
            // Don't convert more pages than the remaining budget can pay for.
            const affordable = isPpe ? chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_PAGE) : Infinity;
            const docOpts = Number.isFinite(affordable) && (!opts.maxPagesPerDocument || affordable < opts.maxPagesPerDocument)
                ? { ...opts, maxPagesPerDocument: Math.max(1, affordable) } : opts;
            const doc = await convert(fileType, dl.buffer, { opts: docOpts, beforeOcrPage });
            const warnings = [...(doc.warnings ?? [])];
            if (docOpts !== opts && doc.paged && doc.totalPages > doc.pages.length) {
                warnings.push('The remaining pages were skipped: spending limit reached.');
                stoppedByLimit = true;
            }

            // Normalise to per-page Markdown. Non-paged formats are one "page" for structure, billed by length.
            let pageParts;
            let pages;
            if (doc.paged) {
                pageParts = doc.pages;
                pages = doc.pages.length;
            } else {
                let md = doc.markdown;
                if (opts.maxPagesPerDocument && md.length > opts.maxPagesPerDocument * CHARS_PER_PAGE) {
                    md = md.slice(0, opts.maxPagesPerDocument * CHARS_PER_PAGE);
                    warnings.push(`Text truncated to ~${opts.maxPagesPerDocument} pages (${opts.maxPagesPerDocument * CHARS_PER_PAGE} characters, maxPagesPerDocument).`);
                }
                pageParts = [{ page: null, md }];
                pages = Math.max(1, Math.ceil(md.length / CHARS_PER_PAGE));
            }
            if (!pageParts.some((p) => p.md && p.md.trim())) {
                const scanned = doc.scannedPages?.length;
                throw new Error(scanned
                    ? `No text layer: the document looks scanned (${scanned} image-only page(s)). Enable "ocr" to read it.`
                    : 'The document contains no extractable text.');
            }

            // Charge per page before producing output. If the budget covers only part of it, output only that part.
            const charge = await Actor.charge({ eventName: EVENT_PAGE, count: pages });
            if (isPpe && charge.chargedCount < pages) {
                stoppedByLimit = true;
                if (charge.chargedCount < 1) { log.warning(`Skipped "${fileName}": the run reached the spending limit you set.`); break; }
                if (doc.paged) pageParts = pageParts.slice(0, charge.chargedCount);
                else pageParts = [{ page: null, md: pageParts[0].md.slice(0, charge.chargedCount * CHARS_PER_PAGE) }];
                warnings.push(`Only ${charge.chargedCount} of ${pages} pages were output: spending limit reached.`);
                pages = charge.chargedCount;
            }

            // Blocks with page numbers (+ optional page markers) -> combined document -> chunks.
            const blocks = [];
            for (const p of pageParts) {
                if (opts.includePageNumbers && p.page !== null) blocks.push({ md: `<!-- page: ${p.page} -->`, heading: 0, page: p.page, marker: true });
                mdToBlocks(p.md).forEach((b, k) => {
                    // A paragraph cut by a page break continues on the next page: join the two halves.
                    const prev = blocks[blocks.length - 1];
                    if (k === 0 && prev && !prev.marker && isOpenParagraph(prev) && isPlainParagraph(b) && /^\p{Ll}/u.test(b.md)) {
                        prev.md = `${prev.md} ${b.md}`;
                        prev.pageEnd = p.page;
                    } else blocks.push({ ...b, page: p.page });
                });
            }
            const fullMd = blocks.map((b) => b.md).join('\n\n');
            const title = doc.title || blocks.find((b) => b.heading)?.headingText || fileName;

            const base = `${String(i + 1).padStart(4, '0')}-${slug(fileName)}`;
            await kvs.setValue(`${base}.md`, fullMd, { contentType: 'text/markdown; charset=utf-8' });
            const documentUrl = kvs.getPublicUrl(`${base}.md`);
            let textUrl;
            if (opts.outputFormat === 'text') {
                await kvs.setValue(`${base}.txt`, mdToText(fullMd), { contentType: 'text/plain; charset=utf-8' });
                textUrl = kvs.getPublicUrl(`${base}.txt`);
            }

            const chunks = chunkBlocks(blocks, { mode: opts.chunking, size: opts.chunkSize, overlap: opts.chunkOverlap, measure });
            const ocrPages = (doc.ocrPages ?? []).filter((p) => pageParts.some((x) => x.page === p));
            const docMeta = {
                title,
                totalPages: doc.totalPages ?? null,
                pagesEstimated: !doc.paged,
                ocrPages: ocrPages.length ? compactRanges(ocrPages) : undefined,
                scannedPagesWithoutText: doc.scannedPages?.length ? compactRanges(doc.scannedPages) : undefined,
                warnings: warnings.length ? warnings : undefined,
            };
            const items = chunks.map((c, idx) => {
                let text = render(c.md);
                let truncated = false;
                if (text.length > MAX_ITEM_CHARS) { text = text.slice(0, MAX_ITEM_CHARS); truncated = true; }
                return {
                    sourceUrl,
                    fileName,
                    fileType,
                    pages,
                    chunkIndex: idx,
                    chunkCount: chunks.length,
                    text,
                    tokenCount: countTokens(text),
                    charCount: text.length,
                    documentUrl,
                    ...(textUrl ? { textUrl } : {}),
                    metadata: {
                        ...docMeta,
                        pageStart: c.pageStart,
                        pageEnd: c.pageEnd,
                        headings: c.headings,
                        headingPath: c.headings.join(' > '),
                        ...(truncated ? { textTruncated: true, note: 'Text was too long for one dataset item; the full document is at documentUrl. Use chunking to split it.' } : {}),
                    },
                    status: 'ok',
                };
            });
            await Actor.pushData(items);

            summary.documentsSucceeded++;
            summary.pagesProcessed += pages;
            summary.ocrPages += ocrPages.length;
            summary.chunks += items.length;
            warnings.forEach((w) => log.warning(`${fileName}: ${w}`));
            log.info(`[${i + 1}/${sources.length}] ${fileName} (${fileType}): ${pages} page(s)${ocrPages.length ? `, ${ocrPages.length} OCR` : ''}, ${items.length} item(s) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
        } catch (err) {
            const error = err?.message || String(err);
            summary.documentsFailed++;
            summary.failures.push({ sourceUrl, error });
            log.error(`[${i + 1}/${sources.length}] ${fileName}: ${error}`);
            await Actor.pushData({ sourceUrl, fileName, status: 'failed', error, chunkIndex: null, text: '' });
        }
        if (stoppedByLimit) { log.warning('Stopping: the run reached the spending limit you set.'); break; }
    }

    await terminateOcr();
    summary.stoppedBySpendingLimit = stoppedByLimit;
    await kvs.setValue('OUTPUT', summary);
    log.info('Done.', { ...summary, failures: summary.failures.length });

    if (summary.documentsSucceeded === 0 && summary.documentsFailed > 0) {
        await Actor.fail(`All ${summary.documentsFailed} document(s) failed. First error: ${summary.failures[0].error}`);
    } else {
        await Actor.exit();
    }
} catch (err) {
    await terminateOcr();
    log.error(err.message);
    await Actor.fail(err.message);
}
