// Recognises anti-bot answers so the log can say exactly what happened.
//
// Coles is fronted by Imperva (Incapsula + "reese84" Advanced Bot Protection). Markers verified from
// abhinav-pandey29/coles-scraper (src/fetcher.py: "Incapsula", "Pardon Our Interruption") and the cookie
// names seen in diabolical-ninja/coles-mcp (visid_incap_*, incap_ses_*, nlbi_*, reese84).
// Woolworths is fronted by Akamai. Markers verified by 2scraper/woolworths-scraper (product_parser.py, measured
// 2026-09-16): "Access Denied", "You don't have permission", "edgesuite"; plus the client-side redirect to
// /unauthorisederror. The word "akamai" is deliberately NOT a marker: it appears on every page Woolworths serves.

const MARKERS = {
    coles: [
        ['Pardon Our Interruption', 'Imperva "Pardon Our Interruption" challenge page'],
        ['_Incapsula_Resource', 'Imperva/Incapsula challenge script'],
        ['Incapsula incident', 'Imperva/Incapsula incident page'],
        ['Incapsula', 'Imperva/Incapsula page'],
        ['/reese84', 'Imperva reese84 bot-protection script'],
        ['captcha', 'captcha'],
        ['Access Denied', '"Access Denied" page'],
    ],
    woolworths: [
        ['Access Denied', 'Akamai "Access Denied" page'],
        ["You don't have permission", 'Akamai "You don\'t have permission" page'],
        ['edgesuite', 'Akamai edgesuite error reference'],
        ['/unauthorisederror', 'Woolworths /unauthorisederror redirect'],
        ['captcha', 'captcha'],
    ],
};

const unescape = (s) => s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Which anti-bot markers a (non-JSON) body carries. Only the first 8 kB are inspected. */
export function findBlockMarkers(store, text) {
    const head = unescape(String(text ?? '').slice(0, 8192));
    const found = [];
    for (const [needle, label] of MARKERS[store] ?? []) {
        if (head.toLowerCase().includes(needle.toLowerCase()) && !found.includes(label)) found.push(label);
    }
    // "Incapsula" is a substring of the more specific markers; keep the most specific one only.
    if (found.length > 1) return found.filter((l) => l !== 'Imperva/Incapsula page');
    return found;
}

/**
 * Classifies one response that was expected to be JSON.
 * Returns { ok, blocked, reason, markers, retryable }.
 */
export function classifyResponse(store, { status, contentType = '', text = '', finalUrl = '' }) {
    const ct = String(contentType).toLowerCase();
    const trimmed = String(text).trimStart();
    const looksJson = ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
    const markers = looksJson ? [] : findBlockMarkers(store, text);
    if (String(finalUrl).toLowerCase().includes('/unauthorisederror')) markers.push('Woolworths /unauthorisederror redirect');

    if (status >= 200 && status < 300 && looksJson && !markers.length) return { ok: true };
    if (status === 404) return { ok: false, notFound: true, reason: 'HTTP 404', markers, retryable: false };
    if (status === 429) return { ok: false, blocked: true, rateLimited: true, reason: 'HTTP 429 (rate limited)', markers, retryable: true };
    if (markers.length || status === 403 || status === 401 || status === 406 || (status >= 200 && status < 300 && !looksJson)) {
        const what = markers.length ? markers.join(', ') : (looksJson ? 'no block page' : `an HTML page instead of JSON (${ct || 'no content-type'})`);
        return { ok: false, blocked: true, reason: `HTTP ${status}, ${what}`, markers, retryable: true };
    }
    if (status >= 500 || status === 408 || status === 0) return { ok: false, reason: `HTTP ${status}`, markers, retryable: true };
    return { ok: false, reason: `HTTP ${status}`, markers, retryable: false };
}

export class BlockedError extends Error {
    constructor(message, info = {}) {
        super(message);
        this.name = 'BlockedError';
        Object.assign(this, info);
    }
}
