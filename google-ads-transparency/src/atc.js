// Polite HTTP client for the public JSON RPC of adstransparency.google.com.
//
// Rules this client keeps (owner's rule: respect limits, never get around protections):
//  - one request at a time, with a pause between requests (requestDelayMs, at least 1 s);
//  - one IP for the whole run (one sticky proxy session); a block is never answered with a new IP;
//  - on a "sorry"/captcha page or HTTP 429 it waits (30 s, 60 s, 120 s...) and tries again on the same IP,
//    up to maxBlockWaitSecs in total; then it stops and reports the block. Captchas are never solved.
import { Impit } from 'impit';
import { log } from 'apify';
import { parseRpcJson, parseSuggestions, parseCreatives, parseCreativeDetail, SITE } from './parse.js';

export class BlockedError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const maskProxy = (u) => (u ? u.replace(/\/\/[^@/]*@/, '//***@') : 'none');

/** True when the answer is Google's rate-limit / captcha page rather than data. */
export function isBlockedAnswer({ status, url, text }) {
    if (status === 429) return true;
    if (/\/sorry\//.test(url ?? '')) return true;
    if (status >= 300 && status < 400) return true;
    return /our systems have detected unusual traffic|\/sorry\/index|recaptcha/i.test(String(text ?? '').slice(0, 3000));
}

export class AtcClient {
    constructor({ proxyConfiguration = null, requestDelayMs = 2000, maxBlockWaitSecs = 180, timeoutMs = 30_000, baseUrl = process.env.ATC_BASE_URL || SITE, firstWaitMs = Number(process.env.ATC_FIRST_WAIT_MS) || 30_000 }) {
        this.proxyConfiguration = proxyConfiguration;
        this.requestDelayMs = requestDelayMs;
        this.maxBlockWaitMs = maxBlockWaitSecs * 1000;
        this.firstWaitMs = firstWaitMs;
        this.timeoutMs = timeoutMs;
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.lastRequestAt = 0;
        this.impit = null;
        this.proxyUrl = null;
        this.blockedFor = 0;
        this.stats = { requests: 0, ok: 0, blockedAnswers: 0, waitedSecs: 0, httpErrors: 0, networkErrors: 0, badAnswers: 0 };
    }

    async init() {
        if (this.impit) return;
        // One sticky session = one IP for the whole run.
        this.proxyUrl = this.proxyConfiguration ? ((await this.proxyConfiguration.newUrl(`atc_${Math.random().toString(36).slice(2, 10)}`)) ?? null) : null;
        this.impit = new Impit({ browser: 'chrome', proxyUrl: this.proxyUrl ?? undefined, timeout: this.timeoutMs, followRedirects: false });
    }

    describe() {
        return `proxy=${maskProxy(this.proxyUrl)}, ${this.requestDelayMs / 1000}s between requests`;
    }

    async pace() {
        const wait = this.lastRequestAt + this.requestDelayMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastRequestAt = Date.now();
    }

    /** POST one RPC; returns the parsed JSON. Retries network errors twice and waits out blocks (same IP). */
    async rpc(path, freq) {
        await this.init();
        const url = `${this.baseUrl}/anji/_/rpc/${path}?authuser=`;
        const body = `f.req=${encodeURIComponent(JSON.stringify(freq))}`;
        let netErrors = 0;
        let waitMs = this.firstWaitMs;
        for (;;) {
            await this.pace();
            this.stats.requests++;
            let res;
            try {
                const r = await this.impit.fetch(url, {
                    method: 'POST',
                    body,
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded',
                        accept: '*/*',
                        origin: SITE,
                        referer: `${SITE}/`,
                        'x-same-domain': '1',
                        'accept-language': 'en-US,en;q=0.9',
                    },
                });
                res = { status: r.status, url: r.headers.get('location') || r.url || url, text: await r.text() };
            } catch (err) {
                this.stats.networkErrors++;
                if (++netErrors > 2) throw new Error(`Network error on ${path}: ${err.message}`);
                log.warning(`Network error on ${path} (${err.message}); retrying.`);
                continue;
            }
            if (isBlockedAnswer(res)) {
                this.stats.blockedAnswers++;
                if (this.blockedFor + waitMs > this.maxBlockWaitMs) {
                    throw new BlockedError('Google answered with its rate-limit page and the wait limit was reached. '
                        + 'The run stops instead of changing IP. Try again later, with fewer ads, or a longer pause between requests.');
                }
                log.warning(`Google asked to slow down (HTTP ${res.status}). Waiting ${Math.round(waitMs / 1000)} s, then retrying on the same IP.`);
                await sleep(waitMs);
                this.blockedFor += waitMs;
                this.stats.waitedSecs += Math.round(waitMs / 1000);
                waitMs *= 2;
                continue;
            }
            if (res.status >= 400) {
                this.stats.httpErrors++;
                if (res.status >= 500 && ++netErrors <= 2) {
                    log.warning(`HTTP ${res.status} on ${path}; retrying.`);
                    continue;
                }
                throw new Error(`HTTP ${res.status} on ${path}`);
            }
            try {
                const json = parseRpcJson(res.text);
                this.stats.ok++;
                return json;
            } catch (err) {
                this.stats.badAnswers++;
                throw err;
            }
        }
    }

    async suggestions(text) {
        return parseSuggestions(await this.rpc('SearchService/SearchSuggestions', { 1: text, 2: 10, 3: 10 }));
    }

    /**
     * One page of ads. Filter object "3": 12 = domain, 13 = advertiser IDs, 8 = geo IDs, 4 = format,
     * 6/7 = first/last day (YYYYMMDD, both needed). "4" at the top level is the next-page token.
     */
    async searchCreatives({ advertiserId = null, domain = null, geoId = null, formatCode = null, dates = null, pageSize = 40, pageToken = null }) {
        const filter = { 12: { 1: domain ?? '', 2: true } };
        if (advertiserId) filter[13] = { 1: [advertiserId] };
        if (geoId) filter[8] = [geoId];
        if (formatCode) filter[4] = formatCode;
        if (dates) {
            filter[6] = dates.from;
            filter[7] = dates.to;
        }
        const freq = { 2: pageSize, 3: filter, 7: { 1: 1, 2: 30, 3: 2 } };
        if (pageToken) freq[4] = pageToken;
        return parseCreatives(await this.rpc('SearchService/SearchCreatives', freq));
    }

    async creativeDetail(advertiserId, adId) {
        return parseCreativeDetail(await this.rpc('LookupService/GetCreativeById', { 1: advertiserId, 2: adId, 5: { 1: 1 } }));
    }
}
