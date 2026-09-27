// PDF -> Markdown with pdfjs-dist: line + paragraph reconstruction, font-size based headings,
// bullet lists, simple column-aligned tables, running header/footer removal, de-hyphenation,
// and scanned-page detection (+ optional OCR).
import { createRequire } from 'node:module';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { mdTable } from '../markdown.js';
import { ocrImage } from '../ocr.js';

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(PDFJS_DIR, 'legacy/build/pdf.worker.mjs');

const BULLET_RE = /^([•●▪◦■□➢►▶✓✔·*\-–—]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/;
const IMAGE_OPS = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
const OCR_DPI = 200;
const round = (n) => Math.round(n * 2) / 2;

/** Group text items into visual lines (content-stream order, so multi-column layouts stay in reading order). */
function buildLines(items) {
    const lines = [];
    let cur = null;
    for (const it of items) {
        if (typeof it.str !== 'string') continue;
        const [a, b, , d, x, y] = it.transform;
        const size = Math.hypot(a, b) || Math.abs(d) || it.height || 10;
        if (!it.str.trim() && !cur) continue;
        if (!cur || Math.abs(y - cur.y) > Math.max(2, Math.min(size, cur.size) * 0.5)) {
            if (cur) lines.push(cur);
            cur = { y, size, items: [] };
        }
        // Symbol-font bullets (Word/LibreOffice) come through as private-use characters.
        const str = /^[\uf000-\uf0ff]$/.test(it.str.trim()) ? '•' : it.str.replace(/[\ue000-\uf8ff]/g, '');
        cur.items.push({ x, w: it.width, str, size });
        if (it.str.trim()) cur.size = Math.max(cur.size, size);
    }
    if (cur) lines.push(cur);

    return lines.map((l) => {
        const its = l.items.filter((i) => i.str !== '').sort((p, q) => p.x - q.x);
        let text = '';
        const segments = [];
        let seg = null;
        let prevEnd = null;
        let chars = 0;
        const sizeChars = new Map();
        for (const i of its) {
            if (!i.str.trim()) { if (text && !/\s$/.test(text)) { text += ' '; if (seg) seg.text += ' '; } continue; }
            const gap = prevEnd === null ? 0 : i.x - prevEnd;
            if (prevEnd !== null && gap > i.size * 0.8 && i.str.trim()) {
                seg = null;
            }
            if (!seg && i.str.trim()) { seg = { x: i.x, text: '' }; segments.push(seg); }
            const needSpace = prevEnd !== null && gap > i.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(i.str);
            if (needSpace) { text += ' '; if (seg && seg.text) seg.text += ' '; }
            text += i.str;
            if (seg) seg.text += i.str;
            prevEnd = i.x + i.w;
            const n = i.str.replace(/\s/g, '').length;
            chars += n;
            sizeChars.set(round(i.size), (sizeChars.get(round(i.size)) ?? 0) + n);
        }
        // A lone bullet glyph followed by a gap is a list marker, not a table column.
        if (segments.length >= 2 && /^([•●▪◦■□➢►▶✓✔·*\-–—]|\d{1,3}[.)]|[a-zA-Z][.)])$/.test(segments[0].text.trim())) {
            segments[1] = { x: segments[0].x, text: `${segments[0].text.trim()} ${segments[1].text}` };
            segments.shift();
        }
        const size = [...sizeChars.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? round(l.size);
        return {
            y: l.y, x: its[0]?.x ?? 0, size, chars,
            text: text.replace(/\s+/g, ' ').trim(),
            segments: segments.map((s) => ({ x: s.x, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text),
        };
    }).filter((l) => l.text);
}

const normEdge = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const isPageNumber = (t) => /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(of|\/)\s*\d{1,4})?$/i.test(t.trim());

/** Remove running headers/footers (lines repeated at the top/bottom of many pages) and bare page numbers. */
function stripHeadersFooters(pages, bodySize) {
    const textPages = pages.filter((p) => p.lines?.length);
    const counts = new Map();
    const EDGE = 2;
    for (const p of textPages) {
        const edges = new Set([...p.lines.slice(0, EDGE), ...p.lines.slice(-EDGE)].map((l) => normEdge(l.text)));
        for (const e of edges) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const minRepeat = Math.max(3, Math.ceil(textPages.length * 0.5));
    for (const p of textPages) {
        const n = p.lines.length;
        p.lines = p.lines.filter((l, idx) => {
            const atEdge = idx < EDGE || idx >= n - EDGE;
            if (!atEdge) return true;
            if (isPageNumber(l.text)) return false;
            // Running headers/footers are short; long body lines are never treated as such.
            return textPages.length < 3 || l.text.length > 100 || l.size >= bodySize * 1.15 || (counts.get(normEdge(l.text)) ?? 0) < minRepeat;
        });
    }
}

const joinText = (a, b) => (/\p{Ll}-$/u.test(a) && /^\p{Ll}/u.test(b) ? a.slice(0, -1) + b : `${a} ${b}`);

/** Turn classified lines of one page into Markdown. */
function pageToMarkdown(lines, ctx) {
    const out = [];
    let para = null; // { kind: 'p'|'li'|'h', text, level, x, size }
    let prev = null;
    const flush = () => {
        if (!para) return;
        if (para.kind === 'h') out.push(`${'#'.repeat(para.level)} ${para.text}`);
        else if (para.kind === 'li') out.push(`${para.indent ? '  ' : ''}- ${para.text}`);
        else out.push(para.text);
        para = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];

        // Table: a run of >= 2 consecutive lines with the same number (>= 2) of widely separated segments.
        if (l.segments.length >= 2) {
            let j = i;
            while (j + 1 < lines.length && lines[j + 1].segments.length === l.segments.length
                && Math.abs(lines[j].y - lines[j + 1].y) < l.size * 3.5) j++;
            if (j > i) {
                flush();
                out.push({ table: mdTable(lines.slice(i, j + 1).map((r) => r.segments.map((s) => s.text))) });
                i = j;
                prev = lines[j];
                continue;
            }
        }

        const level = ctx.headingLevel(l);
        const gap = prev ? prev.y - l.y : 0;
        const indent = prev ? l.x - prev.x : 0;  // first-line indent starts a new paragraph (books, papers)
        const bigGap = !prev || gap < -1 || gap > ctx.lineGap * 1.3 || Math.abs(prev.size - l.size) > 1
            || (indent > l.size * 0.9 && indent < l.size * 4 && para?.kind === 'p');
        const bullet = l.text.match(BULLET_RE);

        if (level && l.text.length < 200) {
            if (para?.kind === 'h' && para.level === level && gap > 0 && gap < l.size * 1.3) para.text += ` ${l.text}`;
            else { flush(); para = { kind: 'h', level, text: l.text }; }
        } else if (bullet && l.text.length > bullet[0].length) {
            flush();
            const marker = bullet[1];
            const numbered = /\d|[a-zA-Z]/.test(marker);
            para = { kind: 'li', text: numbered ? l.text : l.text.slice(bullet[0].length), x: l.x, indent: ctx.listX !== null && l.x > ctx.listX + 12 };
            if (ctx.listX === null) ctx.listX = l.x;
        } else if (para && !bigGap && para.kind !== 'h') {
            para.text = joinText(para.text, l.text);
        } else if (para?.kind === 'li' && !bigGap) {
            para.text = joinText(para.text, l.text);
        } else {
            flush();
            para = { kind: 'p', text: l.text };
            ctx.listX = null;
        }
        prev = l;
    }
    flush();

    // Separate blocks with blank lines, but keep consecutive list items together.
    let md = '';
    for (let k = 0; k < out.length; k++) {
        const cur = out[k];
        const txt = typeof cur === 'string' ? cur : cur.table;
        const isLi = typeof cur === 'string' && /^\s*- /.test(cur);
        const prevLi = k > 0 && typeof out[k - 1] === 'string' && /^\s*- /.test(out[k - 1]);
        md += k === 0 ? txt : (isLi && prevLi ? `\n${txt}` : `\n\n${txt}`);
    }
    return md;
}

async function renderPageToPng(page) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(OCR_DPI / 72, 4000 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return canvas.toBuffer('image/png');
}

/**
 * @param {Buffer} buffer
 * @param {{maxPages:number, ocr:boolean, ocrLanguages:string[], beforeOcrPage:()=>Promise<boolean>}} opts
 * @returns {Promise<{title:string, totalPages:number, pages:{page:number, md:string, ocr?:boolean, scanned?:boolean}[], warnings:string[]}>}
 */
export async function convertPdf(buffer, opts) {
    const warnings = [];
    let doc;
    let task;
    try {
        task = pdfjs.getDocument({
            data: new Uint8Array(buffer),
            cMapUrl: `${path.join(PDFJS_DIR, 'cmaps')}/`,
            cMapPacked: true,
            standardFontDataUrl: `${path.join(PDFJS_DIR, 'standard_fonts')}/`,
            isEvalSupported: false,
            disableFontFace: true,
            useSystemFonts: false,
            verbosity: 0,
        });
        doc = await task.promise;
    } catch (err) {
        if (err?.name === 'PasswordException') throw new Error('The PDF is password-protected. Remove the password and try again.');
        throw new Error(`Could not open the PDF (${err?.message ?? err}). The file may be corrupted.`);
    }

    try {
        const totalPages = doc.numPages;
        const n = Math.min(totalPages, opts.maxPages || totalPages);
        if (n < totalPages) warnings.push(`Only the first ${n} of ${totalPages} pages were processed.`);
        let title = '';
        try { title = (await doc.getMetadata())?.info?.Title?.trim() ?? ''; } catch { /* no metadata */ }

        const pages = [];
        for (let p = 1; p <= n; p++) {
            const page = await doc.getPage(p);
            const content = await page.getTextContent({ disableNormalization: false });
            const lines = buildLines(content.items);
            const chars = lines.reduce((s, l) => s + l.chars, 0);
            const entry = { page: p, lines, chars };
            if (chars < 15) {
                const ops = await page.getOperatorList();
                if (ops.fnArray.some((f) => IMAGE_OPS.has(f))) entry.scanned = true;
            }
            if (entry.scanned && opts.ocr) {
                if (await opts.beforeOcrPage()) {
                    const png = await renderPageToPng(page);
                    const { markdown, confidence } = await ocrImage(png, opts.ocrLanguages);
                    entry.ocrMd = markdown;
                    entry.ocr = true;
                    entry.ocrConfidence = confidence;
                } else {
                    warnings.push(`Page ${p} is scanned but was not OCR'd: spending limit reached.`);
                }
            }
            pages.push(entry);
            page.cleanup();
        }

        const pre = new Map();
        for (const pg of pages) for (const l of pg.lines) pre.set(l.size, (pre.get(l.size) ?? 0) + l.chars);
        stripHeadersFooters(pages, [...pre.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 10);

        // Document-wide typography statistics.
        const sizeChars = new Map();
        const gaps = [];
        for (const pg of pages) {
            pg.lines.forEach((l, i) => {
                sizeChars.set(l.size, (sizeChars.get(l.size) ?? 0) + l.chars);
                const prev = pg.lines[i - 1];
                if (prev && prev.size === l.size) {
                    const g = prev.y - l.y;
                    if (g > 0 && g < l.size * 3) gaps.push(g);
                }
            });
        }
        const bodySize = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
        gaps.sort((a, b) => a - b);
        const lineGap = gaps[Math.floor(gaps.length / 2)] ?? bodySize * 1.2;
        const headingSizes = [...sizeChars.keys()].filter((s) => s >= bodySize * 1.15).sort((a, b) => b - a).slice(0, 4);
        const headingLevel = (l) => {
            const idx = headingSizes.indexOf(l.size);
            return idx === -1 ? 0 : idx + 1;
        };

        const out = pages.map((pg) => {
            if (pg.ocr) return { page: pg.page, md: pg.ocrMd, ocr: true, ocrConfidence: pg.ocrConfidence };
            const md = pageToMarkdown(pg.lines, { headingLevel, lineGap, listX: null });
            return { page: pg.page, md, scanned: !!pg.scanned };
        });
        const scanned = out.filter((p) => p.scanned).map((p) => p.page);
        if (scanned.length && !opts.ocr) {
            warnings.push(`${scanned.length} page(s) look scanned (image only, no text layer): ${compactRanges(scanned)}. Enable "ocr" to read them.`);
        }
        return { title, totalPages, pages: out, warnings };
    } finally {
        await task.destroy();
    }
}

export function compactRanges(nums) {
    const r = [];
    for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        r.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
        i = j;
    }
    return r.join(', ');
}
