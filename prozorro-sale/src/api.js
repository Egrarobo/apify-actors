import { log } from 'apify';

export const INSTANCES = {
    main: 'https://procedure.prozorro.sale',
    dgf: 'https://dgf-procedure.prozorro.sale',
};

/** The change feed returns at most 100 records per request. */
export const PAGE_SIZE = 100;

const USER_AGENT = 'apify-prozorro-sale-actor/1.0 (+https://apify.com)';
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class ApiError extends Error {
    constructor(message, status, path) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.path = path;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Small, polite client for the public Prozorro.Sale Procedure API (read-only, no key needed).
 * Requests are serialized with a minimum gap between them; 429 / 5xx / network errors are retried
 * with exponential backoff and the server's Retry-After header is honoured.
 */
export class ProzorroClient {
    constructor({ baseUrl, minIntervalMs = 300, maxRetries = 4, timeoutMs = 60_000 }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.minIntervalMs = minIntervalMs;
        this.maxRetries = maxRetries;
        this.timeoutMs = timeoutMs;
        this.queue = Promise.resolve();
        this.lastRequestAt = 0;
        this.stats = { requests: 0, retries: 0, bytes: 0 };
    }

    /** Serializes calls so we never hit the API with parallel bursts. */
    get(path) {
        const run = this.queue.then(() => this.#getWithRetry(path));
        this.queue = run.catch(() => {});
        return run;
    }

    async #getWithRetry(path) {
        const url = `${this.baseUrl}${path}`;
        let lastErr;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
            if (wait > 0) await sleep(wait);
            this.lastRequestAt = Date.now();
            this.stats.requests++;
            let res;
            try {
                res = await fetch(url, {
                    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (err) {
                lastErr = new ApiError(`Network error: ${err.cause?.code ?? err.message}`, undefined, path);
                await this.#backoff(attempt, null, lastErr);
                continue;
            }
            if (res.ok) {
                const text = await res.text();
                this.stats.bytes += text.length;
                try {
                    return JSON.parse(text);
                } catch {
                    throw new ApiError(`The API returned something that is not JSON (${text.slice(0, 120)}…)`, res.status, path);
                }
            }
            const body = (await res.text().catch(() => '')).slice(0, 300);
            lastErr = new ApiError(`HTTP ${res.status}${body ? `: ${body}` : ''}`, res.status, path);
            if (!RETRYABLE.has(res.status)) throw lastErr;
            await this.#backoff(attempt, res.headers.get('retry-after'), lastErr);
        }
        throw lastErr;
    }

    async #backoff(attempt, retryAfter, err) {
        if (attempt >= this.maxRetries) return;
        this.stats.retries++;
        let ms = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 400);
        const ra = Number(retryAfter);
        if (Number.isFinite(ra) && ra > 0) ms = Math.min(120_000, ra * 1000);
        log.warning(`Prozorro.Sale API: ${err.message} on ${err.path}. Retrying in ${(ms / 1000).toFixed(1)} s (attempt ${attempt + 2} of ${this.maxRetries + 1}).`);
        await sleep(ms);
    }

    /** Change feed: procedures with dateModified >= since, oldest first, max 100 per call. */
    feedByDateModified(since, limit = PAGE_SIZE) {
        return this.get(`/api/search/byDateModified/${encodeURIComponent(since)}?limit=${limit}`);
    }

    /** The (up to) 100 most recently modified procedures of one selling method, newest first. */
    feedBySellingMethod(sellingMethod, limit = PAGE_SIZE) {
        return this.get(`/api/search/bySellingMethod/${encodeURIComponent(sellingMethod)}?limit=${limit}`);
    }

    /** Lookup by the public auction ID shown on prozorro.sale, e.g. LRE001-UA-20260916-77195. */
    async byAuctionId(auctionId) {
        const data = await this.get(`/api/search/byAuctionId/${encodeURIComponent(auctionId)}`);
        return Array.isArray(data) ? data[0] ?? null : data;
    }

    /** Full procedure by its internal 24-character ID. */
    procedure(id) {
        return this.get(`/api/procedures/${encodeURIComponent(id)}`);
    }

    /** All selling methods known to this instance, e.g. ["landRental-english", ...]. */
    legalNames() {
        return this.get('/api/legal_names');
    }

    /** sellingMethod -> auction ID prefix (e.g. "landRental-english" -> "LRE"). */
    auctionPrefixes() {
        return this.get('/api/auction_prefixes');
    }
}

export const isProcedureId = (v) => /^[0-9a-f]{24}$/i.test(v);
export const isAuctionId = (v) => /^[A-Z]{2,5}\d{0,4}-[A-Z]{2}-\d{8}-\d+$/i.test(v);
