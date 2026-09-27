// Resolves and downloads the latest official ASP company file.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { log } from 'apify';

export const CKAN_PACKAGE_IDS = [
    'a1f38191-f35c-4180-8d80-297851a08f60',
    '11736-date-din-registrul-de-stat-al-unitatilor-de-drept-privind-intreprinderile-inregistrate-in-repu',
];
export const CKAN_API = 'https://dataset.gov.md/api/3/action/package_show?id=';
export const ASP_OPEN_DATA_PAGES = [
    'https://www.asp.gov.md/ro/date-deschise/date-statistice',
    'https://www.asp.gov.md/en/date-deschise/date-statistice',
];
const aspGuess = (year) => `https://www.asp.gov.md/sites/default/files/date-deschise/date-statistice/${year}/rsud/company.xlsx`;

const UA = 'Mozilla/5.0 (compatible; ApifyActor moldova-company-registry-lookup; +https://apify.com)';

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
    return fetch(url, { redirect: 'follow', ...opts, headers: { 'user-agent': UA, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(ms) });
}

/** "Informații la data de 29.01.2024", "2024.01.29-company.xlsx", "company-2024.05.14.xlsx" -> "2024-01-29" */
export function dateFromText(s) {
    if (!s) return null;
    let m = String(s).match(/(\d{1,2})[._-](\d{1,2})[._-](20\d{2})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = String(s).match(/(20\d{2})[._-](\d{1,2})[._-](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return null;
}

const isoDay = (d) => (d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString().slice(0, 10) : null);

async function head(url) {
    try {
        let res = await fetchWithTimeout(url, { method: 'HEAD' }, 20000);
        if (res.status === 405 || res.status === 403) res = await fetchWithTimeout(url, { headers: { range: 'bytes=0-0' } }, 20000);
        if (!res.ok && res.status !== 206) return null;
        res.body?.cancel?.().catch(() => {});
        const type = res.headers.get('content-type') ?? '';
        if (/text\/html/i.test(type)) return null;
        return {
            lastModified: res.headers.get('last-modified'),
            etag: res.headers.get('etag'),
            size: Number(res.headers.get('content-length')) || null,
        };
    } catch {
        return null;
    }
}

async function fromCkan() {
    for (const id of CKAN_PACKAGE_IDS) {
        try {
            const res = await fetchWithTimeout(CKAN_API + encodeURIComponent(id));
            if (!res.ok) continue;
            const json = await res.json();
            const resources = (json?.result?.resources ?? []).filter((r) => /xlsx|csv/i.test(`${r.format} ${r.url}`));
            if (!resources.length) continue;
            const scored = resources.map((r) => ({
                url: r.url,
                dataDate: dateFromText(r.name) ?? dateFromText(r.url) ?? isoDay(r.last_modified ?? r.created),
                via: 'dataset.gov.md CKAN',
            })).filter((r) => r.url && r.dataDate);
            scored.sort((a, b) => b.dataDate.localeCompare(a.dataDate));
            if (scored[0]) return scored[0];
        } catch (e) {
            log.debug(`CKAN lookup failed for ${id}: ${e.message}`);
        }
    }
    return null;
}

async function fromAspPage() {
    const found = new Set();
    for (const page of ASP_OPEN_DATA_PAGES) {
        try {
            const res = await fetchWithTimeout(page);
            if (!res.ok) continue;
            const html = await res.text();
            for (const m of html.matchAll(/href=["']([^"']*rsud\/company[^"']*\.(?:xlsx|csv))["']/gi)) {
                found.add(new URL(m[1], page).href);
            }
            if (found.size) break;
        } catch (e) {
            log.debug(`ASP page lookup failed for ${page}: ${e.message}`);
        }
    }
    const y = new Date().getUTCFullYear();
    if (!found.size) [aspGuess(y), aspGuess(y - 1)].forEach((u) => found.add(u));
    const out = [];
    for (const url of found) {
        const h = await head(url);
        if (h) out.push({ url, dataDate: isoDay(h.lastModified) ?? dateFromText(url), lastModified: h.lastModified, via: 'asp.gov.md' });
    }
    out.sort((a, b) => String(b.dataDate).localeCompare(String(a.dataDate)));
    return out[0] ?? null;
}

/** Finds the newest official file. Checks both the ASP website and the national open data portal. */
export async function resolveLatestSource() {
    const [ckan, asp] = await Promise.all([fromCkan(), fromAspPage()]);
    const candidates = [asp, ckan].filter(Boolean);
    if (!candidates.length) {
        throw new Error('Could not find the official company file on asp.gov.md or dataset.gov.md (both unreachable or changed). '
            + 'Try again later, or pass a direct link in "sourceFileUrl".');
    }
    candidates.sort((a, b) => String(b.dataDate ?? '').localeCompare(String(a.dataDate ?? '')));
    log.info(`Latest official file: ${candidates[0].url} (data date ${candidates[0].dataDate ?? 'unknown'}, via ${candidates[0].via})`);
    return candidates[0];
}

export async function describeSource(url) {
    if (isLocal(url)) {
        const p = localPath(url);
        if (!fs.existsSync(p)) throw new Error(`Local source file not found: ${p}`);
        const st = fs.statSync(p);
        return { url, lastModified: st.mtime.toUTCString(), dataDate: dateFromText(path.basename(p)) ?? isoDay(st.mtime) };
    }
    const h = await head(url);
    return { url, lastModified: h?.lastModified ?? null, etag: h?.etag ?? null, dataDate: dateFromText(url) ?? isoDay(h?.lastModified) };
}

export const isLocal = (u) => /^file:\/\//i.test(u) || u.startsWith('/') || u.startsWith('./') || u.startsWith('../');
const localPath = (u) => (/^file:\/\//i.test(u) ? new URL(u).pathname : path.resolve(u));

/** Downloads (or copies) the file to a temp path. Returns { filePath, kind: 'xlsx'|'csv', bytes }. */
export async function downloadSource(url, tmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true });
    if (isLocal(url)) {
        const p = localPath(url);
        if (!fs.existsSync(p)) throw new Error(`Local source file not found: ${p}`);
        return { filePath: p, kind: detectKind(p, fs.readFileSync(p).subarray(0, 4)), bytes: fs.statSync(p).size };
    }
    const target = path.join(tmpDir, `source-${Date.now()}`);
    log.info(`Downloading ${url} …`);
    const res = await fetchWithTimeout(url, {}, 15 * 60 * 1000);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error(`Expected a spreadsheet but got an HTML page from ${url}. The link may have moved.`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(target));
    const bytes = fs.statSync(target).size;
    const fd = fs.openSync(target, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    log.info(`Downloaded ${(bytes / 1048576).toFixed(1)} MB.`);
    return { filePath: target, kind: detectKind(url, magic), bytes };
}

function detectKind(name, magic) {
    if (magic?.[0] === 0x50 && magic?.[1] === 0x4b) return 'xlsx'; // ZIP container
    if (/\.csv(\?|$)/i.test(name)) return 'csv';
    if (magic?.[0] === 0xd0 && magic?.[1] === 0xcf) throw new Error('The source is an old .xls (binary Excel) file, which is not supported. Use the .xlsx or .csv version.');
    return 'csv';
}
