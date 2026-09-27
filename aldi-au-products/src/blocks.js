// Recognises anti-bot answers so the log can say exactly what happened.
//
// It is not public which bot protection fronts api.aldi.com.au / www.aldi.com.au, so the common vendors' block
// pages are recognised: Akamai ("Access Denied" / "You don't have permission" / edgesuite reference — markers
// verified for an Akamai-fronted grocer by 2scraper/woolworths-scraper), Cloudflare ("Just a moment...",
// "cf-chl", "Attention Required") and Imperva/Incapsula. aldiscount (ByteSizedMarius, Aug 2026) treats an HTML
// body where JSON was expected as "blocked or wrong host" for the same ALDI SÜD API platform.

const MARKERS = [
    ['Access Denied', 'Akamai "Access Denied" page'],
    ["You don't have permission", 'Akamai "You don\'t have permission" page'],
    ['edgesuite', 'Akamai edgesuite error reference'],
    ['Just a moment...', 'Cloudflare "Just a moment" challenge'],
    ['cf-chl', 'Cloudflare challenge script'],
    ['Attention Required', 'Cloudflare "Attention Required" page'],
    ['_Incapsula_Resource', 'Imperva/Incapsula challenge script'],
    ['Pardon Our Interruption', 'Imperva "Pardon Our Interruption" page'],
    ['captcha', 'captcha'],
];

const unescape = (s) => s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Which anti-bot markers a (non-JSON) body carries. Only the first 8 kB are inspected. */
export function findBlockMarkers(text) {
    const head = unescape(String(text ?? '').slice(0, 8192));
    const found = [];
    for (const [needle, label] of MARKERS) {
        if (head.toLowerCase().includes(needle.toLowerCase()) && !found.includes(label)) found.push(label);
    }
    return found;
}

/**
 * First API error message of an {"errors":[{code,message}]} body (ALDI API envelope, see aldiscount util.go) or of a
 * GraphQL batch answer [{"errors":[{message}]}] (Tesco xapi).
 */
export function apiErrorOf(text) {
    try {
        const parsed = JSON.parse(text);
        const j = Array.isArray(parsed) ? parsed[0] : parsed;
        const e = Array.isArray(j?.errors) ? j.errors[0] : null;
        if (!e) return null;
        return `${e.code ? `[${e.code}] ` : ''}${e.message ?? e.detail ?? 'API error'}`.slice(0, 300);
    } catch {
        return null;
    }
}

/**
 * Classifies one response that was expected to be JSON.
 * Returns { ok, blocked, notFound, rateLimited, reason, markers, retryable }.
 */
export function classifyResponse({ status, contentType = '', text = '' }) {
    const ct = String(contentType).toLowerCase();
    const trimmed = String(text).trimStart();
    const looksJson = ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
    const markers = looksJson ? [] : findBlockMarkers(text);
    const apiError = looksJson ? apiErrorOf(text) : null;

    if (status >= 200 && status < 300 && looksJson && !markers.length) return { ok: true };
    if (status === 404) return { ok: false, notFound: true, reason: `HTTP 404${apiError ? ` ${apiError}` : ''}`, markers, retryable: false };
    // Tesco xapi answers 403 "Invalid Client" when the public x-apikey is wrong/rotated (basketeer errors.ts,
    // open-supermarkets evaluated.md). That is not a bot block: a new IP won't help, a new key will.
    if ((status === 401 || status === 403) && /invalid client/i.test(String(text).slice(0, 2000))) {
        return { ok: false, apiKeyRejected: true, reason: `HTTP ${status} "Invalid Client" (the API key was rejected)`, markers, retryable: false };
    }
    if (status === 429) return { ok: false, blocked: true, rateLimited: true, reason: 'HTTP 429 (rate limited)', markers, retryable: true };
    if (markers.length || ((status === 403 || status === 401 || status === 406) && !apiError) || (status >= 200 && status < 300 && !looksJson)) {
        const what = markers.length ? markers.join(', ') : (looksJson ? 'no block page' : `an HTML page instead of JSON (${ct || 'no content-type'})`);
        return { ok: false, blocked: true, reason: `HTTP ${status}, ${what}`, markers, retryable: true };
    }
    if (status >= 500 || status === 408 || status === 0) return { ok: false, reason: `HTTP ${status}${apiError ? ` ${apiError}` : ''}`, markers, retryable: true };
    return { ok: false, reason: `HTTP ${status}${apiError ? ` ${apiError}` : looksJson ? ` ${trimmed.slice(0, 200)}` : ''}`, markers, retryable: false };
}

export class BlockedError extends Error {
    constructor(message, info = {}) {
        super(message);
        this.name = 'BlockedError';
        Object.assign(this, info);
    }
}
