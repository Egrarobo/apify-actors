// Polite HTTP client: browser-like headers (got-scraping), optional Apify Proxy, retries with backoff,
// and a clear error when a Kazakh government host refuses or drops connections (often geo-blocking).
import { gotScraping } from 'got-scraping';
import { log } from 'apify';

export class SourceUnavailableError extends Error {
    constructor(sourceName, host, detail) {
        super(`${sourceName} (${host}) is not reachable from this run: ${detail}. `
            + 'Kazakh government portals often block or drop connections from IP addresses outside Kazakhstan. '
            + 'Enable "Proxy configuration" with Apify Proxy (a RESIDENTIAL proxy with country KZ usually works), or try again later.');
        this.name = 'SourceUnavailableError';
        this.sourceName = sourceName;
        this.host = host;
    }
}

const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524]);
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'ERR_GOT_REQUEST_ERROR', 'ENOTFOUND', 'UND_ERR_SOCKET']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttpClient({ proxyConfiguration = null, timeoutSecs = 30, maxRetries = 3, baseDelayMs = 1000 } = {}) {
    let sessionCounter = 0;

    /**
     * GET a URL and parse JSON. Returns { status, json } for 2xx and 404; throws SourceUnavailableError
     * after retries on network errors / blocking statuses, or a plain Error for other failures.
     */
    async function getJson(url, { sourceName, headers = {} } = {}) {
        const host = new URL(url).host;
        let lastDetail = 'unknown error';
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
                log.debug(`Retrying ${host} in ${delay} ms (attempt ${attempt + 1}/${maxRetries + 1}): ${lastDetail}`);
                await sleep(delay);
            }
            // A new proxy session (= new IP) per attempt, so a blocked IP is not reused.
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl(`kz${Date.now() % 100000}_${sessionCounter++}`) : undefined;
            let res;
            try {
                res = await gotScraping({
                    url,
                    proxyUrl,
                    headers: { accept: 'application/json, text/javascript, */*; q=0.01', ...headers },
                    headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 110 }], devices: ['desktop'], locales: ['ru-RU', 'kk-KZ', 'en-US'], operatingSystems: ['windows'] },
                    timeout: { request: timeoutSecs * 1000 },
                    retry: { limit: 0 },
                    throwHttpErrors: false,
                    followRedirect: true,
                    responseType: 'text',
                });
            } catch (e) {
                lastDetail = `${e.code ?? e.name}: ${e.message}`.slice(0, 300);
                if (NETWORK_CODES.has(e.code) || e.name === 'TimeoutError' || e.name === 'RequestError') continue;
                throw new Error(`Request to ${host} failed: ${lastDetail}`);
            }
            const status = res.statusCode;
            if (status === 404) return { status, json: safeJson(res.body) };
            if (status >= 200 && status < 300) {
                const json = safeJson(res.body);
                if (json === undefined) {
                    // An HTML page instead of JSON is typically a block page, captcha or maintenance page.
                    lastDetail = `HTTP ${status} but the response is not JSON (${snippet(res.body)})`;
                    continue;
                }
                return { status, json };
            }
            lastDetail = `HTTP ${status}${res.body ? ` (${snippet(res.body)})` : ''}`;
            if (status === 429) {
                const ra = Number(res.headers['retry-after']);
                if (ra > 0 && ra <= 60) await sleep(ra * 1000);
            }
            if (RETRY_STATUS.has(status)) continue;
            throw new Error(`${sourceName ?? host} returned ${lastDetail}.`);
        }
        throw new SourceUnavailableError(sourceName ?? host, host, lastDetail);
    }

    return { getJson };
}

function safeJson(body) {
    if (typeof body !== 'string') return body;
    const t = body.trim();
    if (!t || !(t.startsWith('{') || t.startsWith('['))) return undefined;
    try {
        return JSON.parse(t);
    } catch {
        return undefined;
    }
}

function snippet(body) {
    return String(body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'empty body';
}
