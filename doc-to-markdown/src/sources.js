// Input collection (URLs, key-value store files, dataset of URLs), share-link normalisation,
// download with limits, and file-type detection.
import path from 'node:path';
import { Actor, log } from 'apify';
import JSZip from 'jszip';

const UA = 'Mozilla/5.0 (compatible; ApifyDocToMarkdown/1.0; +https://apify.com)';

/** Convert common share links (Google Drive/Docs, Dropbox, OneDrive/SharePoint, GitHub, Box) to direct downloads. */
export function toDirectUrl(raw) {
    let url;
    try { url = new URL(String(raw).trim()); } catch { return String(raw).trim(); }
    const h = url.hostname.replace(/^www\./, '');

    if (h === 'drive.google.com') {
        const id = url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] || url.searchParams.get('id');
        if (id) return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    }
    if (h === 'docs.google.com') {
        const m = url.pathname.match(/\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
        if (m && !/\/export/.test(url.pathname)) {
            const fmt = { document: 'docx', spreadsheets: 'xlsx', presentation: 'pptx' }[m[1]];
            return m[1] === 'presentation'
                ? `https://docs.google.com/presentation/d/${m[2]}/export/pptx`
                : `https://docs.google.com/${m[1]}/d/${m[2]}/export?format=${fmt}`;
        }
    }
    if (h === 'dropbox.com') {
        url.searchParams.set('dl', '1');
        return url.toString();
    }
    if (h === '1drv.ms' || h === 'onedrive.live.com') {
        const b64 = Buffer.from(url.toString()).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
        return `https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`;
    }
    if (h.endsWith('.sharepoint.com') && !url.searchParams.has('download')) {
        url.searchParams.set('download', '1');
        return url.toString();
    }
    if (h === 'github.com') {
        const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
    }
    if (h === 'app.box.com' && /^\/s\//.test(url.pathname)) {
        return `https://app.box.com/shared/static/${url.pathname.split('/')[2]}`;
    }
    return url.toString();
}

/** Collect all documents to process from the input. */
export async function collectSources(input) {
    const sources = [];
    const seen = new Set();
    const add = (s) => {
        const key = s.url ?? `kvs:${s.storeId ?? ''}/${s.key}`;
        if (seen.has(key)) return;
        seen.add(key);
        sources.push(s);
    };

    for (const u of input.urls ?? []) {
        const url = typeof u === 'string' ? u : u?.url;
        if (url && String(url).trim()) add({ url: String(url).trim() });
    }
    for (const k of input.keyValueStoreKeys ?? input.files ?? []) {
        const key = typeof k === 'string' ? k : k?.key;
        if (!key) continue;
        // "storeId/key" or just "key" (default: input.keyValueStoreId or this run's store).
        const m = String(key).match(/^([\w~.-]{5,})\/(.+)$/);
        add(m && !input.keyValueStoreId ? { storeId: m[1], key: m[2] } : { storeId: input.keyValueStoreId || null, key: String(key) });
    }
    if (input.datasetId) {
        const field = input.datasetUrlField || 'url';
        const ds = await Actor.openDataset(input.datasetId, { forceCloud: Actor.isAtHome() });
        const { items } = await ds.getData({ clean: true, limit: 100000 });
        let n = 0;
        for (const it of items) {
            const url = it?.[field];
            if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) { add({ url: url.trim() }); n++; }
        }
        if (!n) log.warning(`Dataset ${input.datasetId}: no items with a URL in the "${field}" field.`);
    }
    return sources;
}

function fileNameFrom(res, url) {
    const cd = res?.headers.get('content-disposition') || '';
    const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
    const plainName = cd.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1];
    let name = star ? decodeURIComponent(star.replace(/"/g, '')) : plainName;
    if (!name) {
        try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { /* ignore */ }
    }
    return (name || 'document').trim();
}

/** Download a source. Returns { buffer, fileName, contentType, finalUrl }. */
export async function fetchSource(src, { maxBytes, timeoutMs = 120000 }) {
    if (src.key) {
        const store = src.storeId ? await Actor.openKeyValueStore(src.storeId, { forceCloud: Actor.isAtHome() }) : await Actor.openKeyValueStore();
        const value = await store.getValue(src.key);
        if (value === null || value === undefined) throw new Error(`Key-value store record "${src.key}" not found${src.storeId ? ` in store ${src.storeId}` : ''}.`);
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
        if (buffer.length > maxBytes) throw new Error(`File is larger than the ${Math.round(maxBytes / 1e6)} MB limit (maxFileSizeMb).`);
        return { buffer, fileName: src.key, contentType: typeof value === 'string' ? 'text/plain' : '', finalUrl: null };
    }

    let url;
    try { url = new URL(toDirectUrl(src.url)); } catch { throw new Error(`Invalid URL: "${src.url}".`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`Unsupported URL protocol "${url.protocol}". Use http(s).`);

    let res;
    try {
        res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        const code = err?.cause?.code;
        const known = { ENOTFOUND: 'host not found', EAI_AGAIN: 'host not found', ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset by the server', UND_ERR_CONNECT_TIMEOUT: 'connection timed out', CERT_HAS_EXPIRED: 'the site\'s TLS certificate has expired' };
        const reason = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : (known[code] ? `${known[code]} (${code})` : (code || err?.cause?.message || err.message));
        throw new Error(`Download failed: ${reason}.`);
    }
    if (!res.ok) {
        const hint = [401, 403].includes(res.status) ? ' The file is private: share it as "Anyone with the link can view".' : '';
        throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}.${hint}`);
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error(`File is ${Math.round(len / 1e6)} MB, larger than the ${Math.round(maxBytes / 1e6)} MB limit (maxFileSizeMb).`);

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`File is larger than the ${Math.round(maxBytes / 1e6)} MB limit (maxFileSizeMb).`);
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const contentType = res.headers.get('content-type') || '';
    const host = url.hostname;
    if (/google\.com$/.test(host) && /text\/html/.test(contentType) && /accounts\.google\.com|ServiceLogin|drive-viewer|Google Drive - Virus scan/i.test(buffer.subarray(0, 50000).toString('utf8'))) {
        throw new Error('Google returned a login or warning page instead of the file. Share it as "Anyone with the link can view".');
    }
    return { buffer, fileName: fileNameFrom(res, res.url || url.toString()), contentType, finalUrl: res.url || url.toString() };
}

const EXT_TYPES = {
    pdf: 'pdf', docx: 'docx', docm: 'docx', pptx: 'pptx', pptm: 'pptx', xlsx: 'xlsx', xlsm: 'xlsx',
    csv: 'csv', tsv: 'tsv', html: 'html', htm: 'html', xhtml: 'html', txt: 'txt', md: 'md', markdown: 'md', text: 'txt',
    json: 'txt', xml: 'txt', log: 'txt', rtf: 'rtf',
    png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', tif: 'image', tiff: 'image',
    doc: 'doc', ppt: 'ppt', xls: 'xls', odt: 'odt', odp: 'odp', ods: 'ods', epub: 'epub',
};

/** Detect the file type from magic bytes, then content type, then extension. */
export async function detectType(buffer, fileName, contentType) {
    const b = buffer;
    const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (b.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
    if (b[0] === 0x50 && b[1] === 0x4b) {
        try {
            const zip = await JSZip.loadAsync(b);
            if (zip.file('word/document.xml')) return 'docx';
            if (zip.file('ppt/presentation.xml')) return 'pptx';
            if (zip.file('xl/workbook.xml')) return 'xlsx';
            const mime = await zip.file('mimetype')?.async('string');
            if (mime?.includes('opendocument.text')) return 'odt';
            if (mime?.includes('opendocument.presentation')) return 'odp';
            if (mime?.includes('opendocument.spreadsheet')) return 'ods';
            if (mime?.includes('epub')) return 'epub';
        } catch { /* not a zip */ }
        return EXT_TYPES[ext] || 'zip';
    }
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return EXT_TYPES[ext] && ['doc', 'ppt', 'xls'].includes(EXT_TYPES[ext]) ? EXT_TYPES[ext] : 'ole';
    if ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 4).toString() === 'RIFF'
        || (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d) || b.subarray(0, 2).toString() === 'BM') return 'image';
    if (b.subarray(0, 5).toString() === '{\\rtf') return 'rtf';

    const ct = contentType.toLowerCase();
    if (EXT_TYPES[ext] && !['image', 'pdf', 'docx', 'pptx', 'xlsx'].includes(EXT_TYPES[ext])) return EXT_TYPES[ext];
    if (ct.includes('text/html') || ct.includes('xhtml')) return 'html';
    if (ct.includes('text/csv')) return 'csv';
    if (ct.includes('tab-separated')) return 'tsv';
    if (ct.includes('markdown')) return 'md';
    if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml')) return 'txt';
    const head = b.subarray(0, 1000).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
    // Treat as text if it decodes as UTF-8 without control characters.
    const sample = b.subarray(0, 4096).toString('utf8');
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(sample) && !sample.includes('�')) return 'txt';
    return 'unknown';
}
