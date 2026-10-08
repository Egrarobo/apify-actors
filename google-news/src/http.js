// Plain HTTP with a Chrome TLS fingerprint (impit). One session = one proxy IP; a 429 or a captcha starts a new session.
import { Impit } from 'impit';
import { log } from 'apify';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
// Google's cookie consent, pre-answered, so EU IPs get the feed instead of consent.google.com.
const CONSENT = 'CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg';

const rand = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const maskProxy = (u) => (u ? u.replace(/\/\/[^@/]*@/, '//***@') : 'none');

export class BlockedError extends Error {}

export class HttpClient {
    constructor({ proxyConfiguration = null, timeoutMs = 30000, maxRetries = 4, backoffMs = Number(process.env.GN_BACKOFF_MS ?? 2000), acceptLanguage = 'en-US,en;q=0.9' } = {}) {
        this.proxyConfiguration = proxyConfiguration;
        this.timeoutMs = timeoutMs;
        this.maxRetries = maxRetries;
        this.backoffMs = backoffMs;
        this.acceptLanguage = acceptLanguage;
        this.impit = null;
        this.proxyUrl = null;
        this.sessionId = null;
        this.stats = { requests: 0, retries: 0, sessions: 0, blocked: 0 };
    }

    async newSession() {
        this.sessionId = `gn_${rand()}`;
        this.proxyUrl = this.proxyConfiguration ? ((await this.proxyConfiguration.newUrl(this.sessionId)) ?? null) : null;
        this.impit = new Impit({ browser: 'chrome', proxyUrl: this.proxyUrl ?? undefined, timeout: this.timeoutMs, followRedirects: true, maxRedirects: 6 });
        this.stats.sessions++;
    }

    describe() {
        return `session=${this.sessionId} proxy=${maskProxy(this.proxyUrl)}`;
    }

    /** One request without retries. Returns { status, url, text }. */
    async once(url, { method = 'GET', body, headers = {} } = {}) {
        if (!this.impit) await this.newSession();
        this.stats.requests++;
        const res = await this.impit.fetch(url, {
            method,
            body,
            headers: { 'user-agent': UA, 'accept-language': this.acceptLanguage, cookie: CONSENT, ...headers },
        });
        const text = await res.text();
        return { status: res.status, url: res.url || url, text };
    }

    /**
     * Request with retries. `accept(res)` says whether the answer is usable; anything else is retried on a new IP.
     * Throws the last error after maxRetries + 1 attempts.
     */
    async request(url, opts = {}, accept = (r) => r.status === 200, label = 'request') {
        let lastErr;
        for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
            const t0 = Date.now();
            try {
                const res = await this.once(url, opts);
                const blocked = res.status === 429 || /\/sorry\/|consent\.google\./.test(res.url) || (res.status === 302 && /sorry/.test(res.text));
                if (blocked) {
                    this.stats.blocked++;
                    throw new BlockedError(`blocked (status=${res.status} at ${res.url.slice(0, 60)})`);
                }
                if (accept(res)) return res;
                throw new Error(`unexpected answer: status=${res.status} length=${res.text.length}`);
            } catch (err) {
                lastErr = err;
                const ms = Date.now() - t0;
                if (attempt > this.maxRetries) break;
                this.stats.retries++;
                const wait = Math.min(this.backoffMs * 2 ** (attempt - 1), Number(process.env.GN_BACKOFF_CAP_MS ?? 30000));
                log.warning(`[${label}] attempt ${attempt}/${this.maxRetries + 1} failed after ${ms}ms (${this.describe()}): ${err.message}. Retrying in ${wait}ms on a new IP.`);
                await sleep(wait);
                await this.newSession();
            }
        }
        throw lastErr;
    }
}
