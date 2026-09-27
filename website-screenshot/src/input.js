import { Actor, log } from 'apify';
import { normalizeUrl, getPath } from './utils.js';

export const DEVICES = {
    desktop: { width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ua: 'desktop' },
    laptop: { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false, ua: 'desktop' },
    tablet: { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ua: 'tablet' },
    mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, ua: 'mobile' },
};

/** User agents that match the real Chromium engine (so sites serve the right layout and do not see "HeadlessChrome"). */
export function userAgentFor(kind, chromeMajor) {
    const v = `${chromeMajor}.0.0.0`;
    if (kind === 'mobile') return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Mobile Safari/537.36`;
    if (kind === 'tablet') return `Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
}

const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'];
const FORMATS = ['png', 'jpeg', 'webp'];

const num = (v, def, min, max, name) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isFinite(x) || x < min || x > max) throw new Error(`"${name}" must be a number between ${min} and ${max} (got ${JSON.stringify(v)}).`);
    return x;
};
const list = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new Error(`"${name}" must be a list.`);
    return v.map((s) => String(s ?? '').trim()).filter(Boolean);
};

/** Validates the input and returns normalized options. Throws a readable error for bad settings. */
export function parseOptions(input) {
    const device = String(input.device ?? 'desktop').toLowerCase();
    if (!DEVICES[device] && device !== 'custom') throw new Error(`"device" must be one of: ${[...Object.keys(DEVICES), 'custom'].join(', ')}.`);
    const preset = DEVICES[device] ?? DEVICES.desktop;
    const custom = device === 'custom';
    const width = Math.round(num(custom ? input.width : undefined, custom ? 1280 : preset.width, 200, 7680, 'width'));
    const height = Math.round(num(custom ? input.height : undefined, custom ? 800 : preset.height, 200, 4320, 'height'));
    const deviceScaleFactor = num(input.scaleFactor, preset.deviceScaleFactor, 0.5, 4, 'scaleFactor');

    const format = String(input.format ?? 'png').toLowerCase();
    if (!FORMATS.includes(format)) throw new Error(`"format" must be one of: ${FORMATS.join(', ')}.`);
    const waitUntil = String(input.waitUntil ?? 'load');
    if (!WAIT_UNTIL.includes(waitUntil)) throw new Error(`"waitUntil" must be one of: ${WAIT_UNTIL.join(', ')}.`);

    const opts = {
        device,
        width,
        height,
        deviceScaleFactor,
        isMobile: custom ? false : preset.isMobile,
        hasTouch: custom ? false : preset.hasTouch,
        uaKind: custom ? 'desktop' : preset.ua,
        userAgent: String(input.userAgent ?? '').trim() || null,
        fullPage: input.fullPage === true,
        format,
        quality: Math.round(num(input.quality, 80, 1, 100, 'quality')),
        waitUntil,
        delaySecs: num(input.delaySecs, 1, 0, 60, 'delaySecs'),
        waitForSelector: String(input.waitForSelector ?? '').trim() || null,
        clipSelector: String(input.clipSelector ?? '').trim() || null,
        scrollToBottom: input.scrollToBottom !== false,
        hideCookieBanners: input.hideCookieBanners !== false,
        hideSelectors: list(input.hideSelectors, 'hideSelectors'),
        blockAds: input.blockAds !== false,
        darkMode: input.darkMode === true,
        savePdf: input.savePdf === true,
        maxHeight: Math.round(num(input.maxHeight, 15000, 0, 100000, 'maxHeight')),
        timeoutSecs: num(input.timeoutSecs, 60, 5, 600, 'timeoutSecs'),
        maxConcurrency: Math.round(num(input.maxConcurrency, 3, 1, 20, 'maxConcurrency')),
        retries: Math.round(num(input.retries, 2, 0, 5, 'retries')),
        outputZip: input.outputZip === true,
    };
    if (opts.format === 'webp' && opts.maxHeight === 0) opts.maxHeight = 16383; // hard limit of the WebP format
    return opts;
}

const MAX_URLS = 100000;

/**
 * Collects URLs from `urls` (strings or {url} objects) and from a dataset (`startUrlsDatasetId` + `urlField`).
 * Returns valid, de-duplicated jobs plus the invalid entries (reported in the output, never charged).
 */
export async function collectUrls(input) {
    const raw = [];
    const urls = input.urls ?? [];
    if (typeof urls === 'string') raw.push(...urls.split(/\s+/));
    else if (Array.isArray(urls)) {
        for (const u of urls) raw.push(u && typeof u === 'object' ? (u.url ?? u.requestUrl ?? '') : u);
    } else throw new Error('"urls" must be a list of web addresses.');

    const datasetId = String(input.startUrlsDatasetId ?? '').trim();
    if (datasetId) {
        const field = String(input.urlField ?? 'url').trim() || 'url';
        const before = raw.length;
        await readDatasetUrls(datasetId, field, raw);
        const added = raw.length - before;
        log.info(`Read ${added} URL value(s) from dataset "${datasetId}" (field "${field}").`);
        if (!added) log.warning(`Dataset "${datasetId}" has no values in field "${field}". Check "URL field in dataset".`);
    }

    const jobs = [];
    const invalid = [];
    const seen = new Set();
    let duplicates = 0;
    for (const r of raw) {
        const original = typeof r === 'string' ? r.trim() : JSON.stringify(r);
        if (!original) continue;
        const url = typeof r === 'string' ? normalizeUrl(r) : null;
        if (!url) {
            invalid.push({ url: original, error: 'Invalid URL: expected a web address such as https://example.com.' });
            continue;
        }
        if (seen.has(url)) {
            duplicates++;
            continue;
        }
        seen.add(url);
        jobs.push({ index: jobs.length, url, inputUrl: original });
    }
    if (duplicates) log.info(`Skipped ${duplicates} duplicate URL(s).`);
    if (jobs.length > MAX_URLS) {
        log.warning(`Only the first ${MAX_URLS} URLs are processed in one run (${jobs.length} given).`);
        jobs.length = MAX_URLS;
    }
    return { jobs, invalid, duplicates };
}

async function readDatasetUrls(datasetId, field, out) {
    const pushValue = (v) => {
        if (Array.isArray(v)) v.forEach(pushValue);
        else if (v && typeof v === 'object' && v.url) out.push(String(v.url));
        else if (typeof v === 'string' && v.trim()) out.push(v);
    };
    const LIMIT = 1000;
    if (Actor.isAtHome()) {
        const client = Actor.apifyClient.dataset(datasetId);
        const info = await client.get();
        if (!info) throw new Error(`Dataset "${datasetId}" was not found. Use the dataset ID (or name) from Apify Console → Storage, and make sure your account can access it.`);
        for (let offset = 0; offset < MAX_URLS; offset += LIMIT) {
            const { items } = await client.listItems({ offset, limit: LIMIT, fields: [field.split('.')[0]], clean: true });
            items.forEach((it) => pushValue(getPath(it, field)));
            if (items.length < LIMIT) break;
        }
    } else {
        const ds = await Actor.openDataset(datasetId);
        for (let offset = 0; offset < MAX_URLS; offset += LIMIT) {
            const { items } = await ds.getData({ offset, limit: LIMIT });
            items.forEach((it) => pushValue(getPath(it, field)));
            if (items.length < LIMIT) break;
        }
    }
}
