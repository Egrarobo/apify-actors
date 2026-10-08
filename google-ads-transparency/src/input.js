// Input parsing and validation.
import { geoIdFromCountry } from './regions.js';
import { FORMAT_CODES } from './parse.js';

export class InputError extends Error {}

export const BLOCKED_PROXY_GROUPS = ['RESIDENTIAL', 'GOOGLE_SERP'];

const AR_ID = /^AR\d{10,}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Classifies one search entry:
 *  - "AR0123..." or a Transparency Center advertiser link → advertiser ID
 *  - "nike.com", "https://www.nike.com/shoes" → domain
 *  - anything else → advertiser name (resolved with the Center's own search suggestions)
 */
export function classifyQuery(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const ar = s.match(/\b(AR\d{10,})\b/);
    if (ar && (AR_ID.test(s) || /adstransparency\.google\./i.test(s))) return { type: 'advertiserId', value: ar[1], input: s };
    let host = s;
    if (/^[a-z]+:\/\//i.test(s) || /^www\./i.test(s) || /^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(s)) {
        try {
            host = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname;
        } catch {
            host = s;
        }
    }
    host = host.replace(/^www\./i, '').toLowerCase();
    if (!/\s/.test(s) && DOMAIN.test(host)) return { type: 'domain', value: host, input: s };
    return { type: 'advertiserName', value: s, input: s };
}

const ymd = (d) => Number(d.toISOString().slice(0, 10).replace(/-/g, ''));
const parseDate = (s, field) => {
    const str = String(s).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str) || Number.isNaN(Date.parse(`${str}T00:00:00Z`))) throw new InputError(`"${field}" must be a date like 2026-09-01 (got "${s}")`);
    return new Date(`${str}T00:00:00Z`);
};

/** period + optional dates → { from, to } as YYYYMMDD numbers, or null for "any time". */
export function resolvePeriod({ period = 'anytime', startDate, endDate }, now = new Date()) {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const daysAgo = (n) => new Date(today.getTime() - n * 86_400_000);
    switch (period) {
        case 'anytime':
        case undefined:
        case null:
        case '':
            return null;
        case 'last7days':
            return { from: ymd(daysAgo(6)), to: ymd(today) };
        case 'last30days':
            return { from: ymd(daysAgo(29)), to: ymd(today) };
        case 'last90days':
            return { from: ymd(daysAgo(89)), to: ymd(today) };
        case 'custom': {
            if (!startDate) throw new InputError('"period" is "custom": please set "startDate" (and optionally "endDate").');
            const from = parseDate(startDate, 'startDate');
            const to = endDate ? parseDate(endDate, 'endDate') : today;
            if (to < from) throw new InputError('"endDate" is before "startDate".');
            return { from: ymd(from), to: ymd(to) };
        }
        default:
            throw new InputError(`Unknown "period" "${period}". Use anytime, last7days, last30days, last90days or custom.`);
    }
}

/** Removes Apify proxy groups billed per GB or per request (the Actor pays for them under pay-per-event). */
export function limitProxy(proxy) {
    const groups = Array.isArray(proxy?.apifyProxyGroups) ? proxy.apifyProxyGroups : [];
    const isBlocked = (g) => BLOCKED_PROXY_GROUPS.includes(String(g).toUpperCase());
    const removedGroups = groups.filter(isBlocked).map((g) => String(g).toUpperCase());
    if (!removedGroups.length) return { proxy, removedGroups };
    const kept = groups.filter((g) => !isBlocked(g));
    const out = { ...proxy, apifyProxyGroups: kept };
    if (!kept.length) delete out.apifyProxyGroups;
    return { proxy: out, removedGroups };
}

const intIn = (v, def, min, max, field) => {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`"${field}" must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);
    return n;
};

/** Pause between two requests to the Transparency Center: at least 1 s, so a run stays at human browsing speed. */
export const MIN_DELAY_SECS = 1;
const delayMs = (v) => {
    if (v === undefined || v === null || v === '') return 2000;
    const n = Number(v);
    if (!Number.isFinite(n) || n < MIN_DELAY_SECS || n > 30) throw new InputError(`"requestDelaySecs" must be from ${MIN_DELAY_SECS} to 30 (got ${JSON.stringify(v)})`);
    return Math.round(n * 1000);
};

export function parseInput(input = {}, now = new Date()) {
    const rawQueries = [
        ...(Array.isArray(input.searchTerms) ? input.searchTerms : []),
        ...(Array.isArray(input.domains) ? input.domains : []),
        ...(Array.isArray(input.advertiserIds) ? input.advertiserIds : []),
    ].flatMap((x) => String(x ?? '').split('\n')).map((s) => s.trim()).filter(Boolean);
    const seen = new Set();
    const queries = [];
    for (const r of rawQueries) {
        const q = classifyQuery(r);
        const key = q && `${q.type}:${q.value.toLowerCase()}`;
        if (q && !seen.has(key)) {
            seen.add(key);
            queries.push(q);
        }
    }
    if (!queries.length) throw new InputError('Add at least one domain (nike.com), advertiser name (Nike) or advertiser ID (AR16735076323512287233) in "searchTerms".');
    if (queries.length > 100) throw new InputError(`At most 100 search terms per run (got ${queries.length}).`);

    const regionRaw = String(input.region ?? 'anywhere').trim() || 'anywhere';
    const geoId = geoIdFromCountry(regionRaw);
    if (geoId === undefined) throw new InputError(`Unknown "region" "${regionRaw}". Use a 2-letter country code such as US, GB, DE, or "anywhere".`);
    const region = geoId === null ? 'anywhere' : regionRaw.toUpperCase();

    const format = String(input.format ?? 'all').toLowerCase();
    if (format !== 'all' && !FORMAT_CODES[format]) throw new InputError(`Unknown "format" "${input.format}". Use all, text, image or video.`);

    return {
        queries,
        region,
        geoId,
        period: input.period ?? 'anytime',
        dates: resolvePeriod(input, now),
        format,
        formatCode: format === 'all' ? null : FORMAT_CODES[format],
        maxAdsPerQuery: intIn(input.maxAdsPerQuery, 50, 1, 100_000, 'maxAdsPerQuery'),
        includeDetails: input.includeDetails !== false,
        requestDelayMs: delayMs(input.requestDelaySecs),
        maxBlockWaitSecs: intIn(input.maxBlockWaitSecs, 180, 0, 900, 'maxBlockWaitSecs'),
        proxyConfiguration: input.proxyConfiguration ?? null,
    };
}
