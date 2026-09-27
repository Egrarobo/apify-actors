import { log } from 'apify';

export const DEFAULT_API_BASE_URL = 'https://public.mtender.gov.md';
export const PORTAL_BASE_URL = 'https://mtender.gov.md';

const FEED_PATHS = {
    all: '/tenders/',
    contractNotices: '/tenders/cn',
    plans: '/tenders/plan',
};

const USER_AGENT = 'Apify-MTender-Actor/1.0 (+https://apify.com)';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export class NotFoundError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MTender OCIDs look like "ocds-b3wdp1-MD-1612345678901". Also accepts portal / API URLs and
 * stage OCIDs ("…-EV-1612345678999"), which are reduced to the contracting process OCID.
 */
export function parseOcid(value) {
    const s = String(value ?? '').trim();
    if (!s) return null;
    const m = s.match(/ocds-[a-z0-9]+-[A-Z]{2}-\d{6,}/i);
    if (!m) return null;
    // Normalise the case of the fixed parts ("ocds-b3wdp1-MD-…"), keep the rest.
    const parts = m[0].split('-');
    parts[0] = 'ocds';
    parts[1] = parts[1].toLowerCase();
    parts[2] = parts[2].toUpperCase();
    return parts.join('-');
}

/**
 * Small polite HTTP client for the public MTender OCDS API:
 * bounded concurrency, a minimum gap between request starts, retries with exponential backoff
 * (honouring Retry-After) on network errors, 429/5xx, empty bodies and the HTTP 200 error bodies
 * MTender is known to return ({"name":"Error", ...}).
 */
export class MTenderClient {
    constructor({ baseUrl = DEFAULT_API_BASE_URL, concurrency = 4, minDelayMs = 150, maxRetries = 5, timeoutMs = 45_000, backoffBaseMs = 1000 } = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.concurrency = concurrency;
        this.minDelayMs = minDelayMs;
        this.maxRetries = maxRetries;
        this.timeoutMs = timeoutMs;
        this.backoffBaseMs = backoffBaseMs;
        this.active = 0;
        this.queue = [];
        this.nextStartAt = 0;
        this.stats = { requests: 0, retries: 0, failures: 0 };
    }

    async slot() {
        if (this.active >= this.concurrency) await new Promise((r) => this.queue.push(r));
        this.active++;
        const now = Date.now();
        const wait = Math.max(0, this.nextStartAt - now);
        this.nextStartAt = Math.max(now, this.nextStartAt) + this.minDelayMs;
        if (wait) await sleep(wait);
    }

    release() {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
    }

    async getJson(path, { allowNotFound = false, maxEmptyRetries = Infinity } = {}) {
        const url = `${this.baseUrl}${path}`;
        let lastErr;
        let emptyCount = 0;
        let attempts = 0;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) this.stats.retries++;
            attempts++;
            let retryAfterMs = 0;
            await this.slot();
            try {
                this.stats.requests++;
                const res = await fetch(url, {
                    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
                const text = await res.text();
                if (res.status === 404) {
                    if (allowNotFound) return null;
                    throw new NotFoundError(`MTender answered 404 for ${path}`);
                }
                if (!res.ok) {
                    const err = new Error(`MTender answered HTTP ${res.status} for ${path}${text ? `: ${text.slice(0, 200)}` : ''}`);
                    err.retryable = RETRYABLE_STATUS.has(res.status);
                    err.status = res.status;
                    const ra = res.headers.get('retry-after');
                    if (ra) retryAfterMs = Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - Date.now());
                    throw err;
                }
                if (!text.trim()) {
                    const err = new Error(`MTender returned an empty response for ${path}`);
                    err.retryable = true;
                    err.emptyBody = true;
                    throw err;
                }
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    const err = new Error(`MTender returned invalid JSON for ${path}`);
                    err.retryable = true;
                    throw err;
                }
                // MTender sometimes answers 200 with a serialized upstream error.
                if (data && data.name === 'Error' && (data.message || data.stack)) {
                    const err = new Error(`MTender upstream error for ${path}: ${String(data.message ?? '').slice(0, 200)}`);
                    err.retryable = true;
                    throw err;
                }
                return data;
            } catch (err) {
                if (err instanceof NotFoundError) throw err;
                let retryable = err.retryable ?? true; // network errors, timeouts
                if (err.emptyBody && ++emptyCount > maxEmptyRetries) retryable = false;
                if (err.retryable === undefined && err.name !== 'TimeoutError') {
                    // fetch() network failure: surface the real reason (ECONNREFUSED, ENOTFOUND, …)
                    const code = err.cause?.code ?? err.cause?.message ?? err.message;
                    lastErr = new Error(`Could not connect to MTender at ${this.baseUrl} (${code})`);
                } else lastErr = err;
                if (!retryable || attempt === this.maxRetries) break;
                const backoff = Math.min(60_000, this.backoffBaseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
                const delay = Math.min(120_000, Math.max(backoff, retryAfterMs));
                // Rate limited: slow down every request, not only this one.
                if (err.status === 429) this.nextStartAt = Math.max(this.nextStartAt, Date.now() + delay);
                log.debug(`Retrying ${path} in ${Math.round(delay)} ms (${err.message})`);
                await sleep(delay);
            } finally {
                this.release();
            }
        }
        this.stats.failures++;
        const msg = lastErr?.name === 'TimeoutError' ? `MTender did not answer within ${this.timeoutMs / 1000} s for ${path}` : lastErr?.message;
        const err = new Error(`${msg} (gave up after ${attempts} attempt${attempts === 1 ? '' : 's'})`);
        err.cause = lastErr;
        err.emptyBody = lastErr?.emptyBody;
        throw err;
    }

    /**
     * Walks a feed forward in time. The feed is ascending by date and paged with an `offset` timestamp;
     * every response echoes the next offset. Yields { entries: [{ ocid, date }], offset, nextOffset }.
     */
    async* feed({ feed = 'all', since, until }) {
        const path = FEED_PATHS[feed];
        if (!path) throw new Error(`Unknown feed "${feed}".`);
        let offset = since;
        const untilMs = until ? Date.parse(until) : Infinity;
        for (let page = 0; ; page++) {
            let data;
            try {
                // An empty body at the end of the feed is normal; retry it only once.
                data = await this.getJson(`${path}?offset=${encodeURIComponent(offset)}`, { maxEmptyRetries: 1 });
            } catch (err) {
                // The last page is an empty object or (sometimes) an empty body.
                if (err.emptyBody) return;
                throw err;
            }
            const entries = Array.isArray(data?.data) ? data.data.filter((e) => e && typeof e.ocid === 'string') : [];
            if (!entries.length) return;
            const inRange = entries.filter((e) => !(Date.parse(e.date) > untilMs));
            let nextOffset = typeof data.offset === 'string' && data.offset ? data.offset : entries[entries.length - 1].date;
            if (!nextOffset || nextOffset === offset) {
                // Defensive: never loop on the same cursor.
                const t = Date.parse(entries[entries.length - 1].date);
                nextOffset = Number.isFinite(t) ? new Date(t + 1).toISOString() : null;
            }
            yield { entries: inRange, offset, nextOffset, reachedUntil: inRange.length < entries.length };
            if (inRange.length < entries.length || !nextOffset) return;
            if (Number.isFinite(untilMs) && Date.parse(nextOffset) > untilMs) return;
            offset = nextOffset;
        }
    }

    /** Record package of one contracting process, or null when it does not exist. */
    async getRecordPackage(ocid) {
        const data = await this.getJson(`/tenders/${encodeURIComponent(ocid)}`, { allowNotFound: true });
        if (!data || !Array.isArray(data.records) || !data.records.length) return null;
        return data;
    }
}

export const portalUrl = (ocid) => `${PORTAL_BASE_URL}/tenders/${ocid}`;
