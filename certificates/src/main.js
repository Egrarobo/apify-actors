import fs from 'node:fs';
import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import Papa from 'papaparse';
import { TEMPLATES } from './templates.js';

const FONTS_CSS = fs.readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');
const EVENT = 'document-generated';

const PAGE_SIZES = {
    A4: { w: 297, h: 210 },
    Letter: { w: 279.4, h: 215.9 },
};

const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Replaces {{field}} with the (escaped) value from ctx. Unknown fields become empty.
const fill = (text, ctx, escape = true) => String(text ?? '').replace(/\{\{\s*([\w.\- ]+?)\s*\}\}/g, (_, k) => {
    const v = ctx[k] ?? ctx[k.toLowerCase()] ?? '';
    return escape ? esc(v) : String(v);
});

const TRANSLIT = {
    ă: 'a', â: 'a', î: 'i', ș: 's', ş: 's', ț: 't', ţ: 't', а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
    ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
    ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', є: 'e', і: 'i', ї: 'i', ґ: 'g',
};
const asciiSlug = (s) => String(s).toLowerCase().split('').map((c) => TRANSLIT[c] ?? c).join('')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
const zipSafe = (s) => String(s).replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 120) || 'document';

const toCsvUrl = (url) => {
    const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
    if (!m || /\/export\?|output=csv|format=csv/.test(url)) return url;
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
};

const parseCsv = (text) => {
    const res = Papa.parse(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
    return res.data;
};

async function loadRecords(input) {
    if (Array.isArray(input.records) && input.records.length) return input.records;
    if (input.csvText && input.csvText.trim()) return parseCsv(input.csvText);
    if (input.csvUrl) {
        const url = toCsvUrl(input.csvUrl.trim());
        const res = await fetch(url, { redirect: 'follow' });
        const text = await res.text();
        if (!res.ok || /^\s*<!DOCTYPE html|<html/i.test(text)) {
            throw new Error(`Could not download the table from ${input.csvUrl}. For Google Sheets, set sharing to "Anyone with the link can view".`);
        }
        return parseCsv(text);
    }
    if (input.datasetId) {
        const ds = await Actor.openDataset(input.datasetId, { forceCloud: true });
        return (await ds.getData({ clean: true })).items;
    }
    throw new Error('No data. Provide "records", "csvText", "csvUrl" or "datasetId".');
}

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const {
        template = 'certificate-classic',
        nameField = 'name',
        title = 'Certificate',
        subtitle = 'of completion',
        body = 'This certificate is awarded for successfully completing {{course}}.',
        date = '',
        issuer = '',
        logoUrl = '',
        accentColor = '#1f4e8c',
        signature1Name = '', signature1Title = '',
        signature2Name = '', signature2Title = '',
        customHtml = '', customCss = '',
        pageSize = 'A4', orientation = 'landscape',
        addQrCode = false, verifyUrlTemplate = '',
        certificateIdPrefix = '',
        fileNameTemplate = '{{name}}',
        outputZip = true, mergeIntoOnePdf = false,
        maxDocuments = 1000,
    } = input;

    if (template === 'custom' && !customHtml) throw new Error('Template "custom" needs "customHtml".');
    if (template !== 'custom' && !TEMPLATES[template]) throw new Error(`Unknown template "${template}".`);
    if (!/^#?[0-9a-fA-F]{3,8}$|^[a-zA-Z]+$/.test(accentColor)) throw new Error('accentColor must be a hex color like #1f4e8c.');
    const accent = accentColor.startsWith('#') || /^[a-zA-Z]+$/.test(accentColor) ? accentColor : `#${accentColor}`;

    let records = await loadRecords(input);
    const skipped = records.filter((r) => !String(r?.[nameField] ?? '').trim()).length;
    records = records.filter((r) => String(r?.[nameField] ?? '').trim());
    if (skipped) log.warning(`Skipped ${skipped} row(s) with an empty "${nameField}" column.`);
    if (!records.length) throw new Error(`No rows with a value in the "${nameField}" column. Check the column name.`);
    if (records.length > maxDocuments) {
        log.warning(`Limiting to the first ${maxDocuments} of ${records.length} rows (maxDocuments).`);
        records = records.slice(0, maxDocuments);
    }

    const size = PAGE_SIZES[pageSize] ?? PAGE_SIZES.A4;
    const [wMm, hMm] = orientation === 'portrait' ? [size.h, size.w] : [size.w, size.h];
    const pageCss = `@page { size: ${wMm}mm ${hMm}mm; margin: 0; } .page { width: ${wMm}mm !important; height: ${hMm}mm !important; }`;

    const isPpe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    const kvs = await Actor.openKeyValueStore();
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], executablePath: process.env.CHROME_PATH || undefined });
    const page = await browser.newPage({ viewport: { width: Math.round(wMm * 3.78), height: Math.round(hMm * 3.78) } });

    const zip = outputZip ? new JSZip() : null;
    const merged = mergeIntoOnePdf ? await PDFDocument.create() : null;
    const usedNames = new Map();
    let generated = 0;

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const charge = await Actor.charge({ eventName: EVENT });
        if (isPpe && charge.chargedCount < 1) {
            log.warning(`Stopped after ${generated} documents: the run reached the spending limit you set.`);
            break;
        }

        const certificateId = String(rec.certificateId ?? rec.certificate_id ?? `${certificateIdPrefix}${String(i + 1).padStart(4, '0')}`);
        const ctx = { title, subtitle, body, date, issuer, ...rec, certificateId, index: i + 1 };
        ctx.name = rec[nameField];

        let qrDataUrl = '';
        if (addQrCode && verifyUrlTemplate) {
            qrDataUrl = await QRCode.toDataURL(fill(verifyUrlTemplate, ctx, false), { margin: 0, width: 300 });
        }

        let html;
        let css;
        if (template === 'custom') {
            html = fill(customHtml, { ...ctx, qrDataUrl });
            css = fill(customCss, ctx);
        } else {
            const t = TEMPLATES[template];
            const d = {
                name: esc(ctx.name),
                title: fill(ctx.title, ctx), subtitle: fill(ctx.subtitle, ctx), body: fill(ctx.body, ctx),
                date: fill(ctx.date, ctx), issuer: fill(ctx.issuer, ctx),
                logoUrl: esc(rec.logoUrl ?? logoUrl),
                signature1Name: esc(signature1Name), signature1Title: esc(signature1Title),
                signature2Name: esc(signature2Name), signature2Title: esc(signature2Title),
                certificateId: (addQrCode || certificateIdPrefix || rec.certificateId) ? esc(certificateId) : '',
                qrDataUrl,
            };
            html = t.html(d);
            css = t.css(accent) + customCss;
        }

        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${FONTS_CSS}</style><style>${css}</style><style>${pageCss}</style></head><body>${html}</body></html>`, { waitUntil: 'load', timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });

        let base = zipSafe(fill(fileNameTemplate, ctx, false));
        const n = (usedNames.get(base) ?? 0) + 1;
        usedNames.set(base, n);
        if (n > 1) base = `${base} (${n})`;

        const key = `${String(i + 1).padStart(4, '0')}-${asciiSlug(base)}.pdf`;
        await kvs.setValue(key, pdf, { contentType: 'application/pdf' });
        zip?.file(`${base}.pdf`, pdf);
        if (merged) {
            const src = await PDFDocument.load(pdf);
            (await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
        }

        await Actor.pushData({
            name: ctx.name,
            fileName: `${base}.pdf`,
            certificateId: certificateId,
            pdfUrl: kvs.getPublicUrl(key),
        });
        generated++;
        if (generated % 25 === 0) log.info(`Generated ${generated}/${records.length}`);
    }

    await browser.close();

    const output = { documentsGenerated: generated, skippedRows: skipped };
    if (zip && generated) {
        await kvs.setValue('all-documents.zip', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { contentType: 'application/zip' });
        output.zipUrl = kvs.getPublicUrl('all-documents.zip');
    }
    if (merged && generated) {
        await kvs.setValue('all-documents-merged.pdf', Buffer.from(await merged.save()), { contentType: 'application/pdf' });
        output.mergedPdfUrl = kvs.getPublicUrl('all-documents-merged.pdf');
    }
    await kvs.setValue('OUTPUT', output);
    log.info(`Done: ${generated} documents.`, output);
    await Actor.exit();
} catch (err) {
    log.error(err.message);
    await Actor.fail(err.message);
}
