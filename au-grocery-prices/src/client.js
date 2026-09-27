import { log } from 'apify';
import { HttpTransport, lookupExitIp } from './http.js';
import { BrowserSession } from './browser.js';
import { classifyResponse, findBlockMarkers, BlockedError } from './blocks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pageTitle = (html) => (String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);

export class RequestError extends Error {
    constructor(message, info = {}) {
        super(message);
        this.name = 'RequestError';
        Object.assign(this, info);
    }
}

const STRATEGY_LABEL = {
    http: 'plain HTTP',
    'browser-cookies': 'HTTP with browser cookies',
    'browser-fetch': 'requests from inside a real browser',
};

/**
 * Store-agnostic session manager: proxy session, warm-up (cookies), retries with backoff, block detection and
 * escalation (refresh cookies → new IP → real browser). Store subclasses implement parseHome() and the endpoints.
 */
export class StoreClient {
    constructor({
        store, label, baseUrl, proxyConfiguration = null, useBrowserForCookies = false, browserFallback = true,
        maxRetries = 4, requestDelayMs = 800, backoffMs = 1500, saveDebug = null, readySelector = null,
    }) {
        this.store = store;
        this.label = label;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.proxyConfiguration = proxyConfiguration;
        this.browserFallback = browserFallback;
        this.maxRetries = maxRetries;
        this.requestDelayMs = requestDelayMs;
        this.backoffMs = backoffMs;
        this.saveDebugFn = saveDebug;
        this.readySelector = readySelector;
        this.strategy = useBrowserForCookies ? 'browser-cookies' : 'http';
        this.initialStrategy = this.strategy;
        this.transport = null;
        this.browser = null;
        this.ready = false;
        this.sessionNo = 0;
        this.blocksInSession = 0;
        this.nextRequestAt = 0;
        this.debugSaved = 0;
        this.home = null;
        this.stats = { requests: 0, retries: 0, blocks: 0, rateLimited: 0, sessions: 0, warmupFailures: 0, browserLaunches: 0, cookieRefreshes: 0, strategy: this.strategy };
    }

    tag(step) {
        return `[${this.label}]${step ? ` ${step}:` : ''}`;
    }

    async saveDebug(kind, content, contentType = 'text/html; charset=utf-8') {
        if (!this.saveDebugFn || this.debugSaved >= 4 || !content) return null;
        this.debugSaved++;
        const key = `DEBUG-${this.store}-${kind}-${this.debugSaved}`;
        try {
            await this.saveDebugFn(key, content, contentType);
            return key;
        } catch {
            return null;
        }
    }

    async closeSession() {
        this.ready = false;
        const b = this.browser;
        this.browser = null;
        this.transport = null;
        if (b) await b.close();
    }

    async newProxyUrl() {
        if (!this.proxyConfiguration) return null;
        const id = `${this.store}${Date.now().toString(36)}${this.sessionNo}`;
        return this.proxyConfiguration.newUrl(id);
    }

    /** Store-specific: validates the homepage HTML and extracts what later requests need. Throw BlockedError if blocked. */
    parseHome() { return {}; }

    homeCheck(html, status, finalUrl) {
        const markers = findBlockMarkers(this.store, html);
        if (String(finalUrl ?? '').toLowerCase().includes('/unauthorisederror')) markers.push('Woolworths /unauthorisederror redirect');
        if (markers.length || status === 403 || status === 401 || status === 429) {
            throw new BlockedError(`homepage answered HTTP ${status} with ${markers.length ? markers.join(', ') : `a page titled "${pageTitle(html)}"`}`,
                { status, markers, html });
        }
        return this.parseHome(html);
    }

    async startSession(reason) {
        await this.closeSession();
        this.sessionNo++;
        this.stats.sessions++;
        this.blocksInSession = 0;
        const proxyUrl = await this.newProxyUrl();
        // The exit IP makes block reports actionable (which IP / how many distinct IPs were refused).
        const ip = proxyUrl ? await lookupExitIp(proxyUrl) : null;
        const proxyInfo = proxyUrl ? `proxy session #${this.sessionNo}${ip ? `, exit IP ${ip}` : ''}` : 'no proxy';
        log.info(`${this.tag()} Starting session #${this.sessionNo} (${STRATEGY_LABEL[this.strategy]}, ${proxyInfo})${reason ? ` because ${reason}` : ''}…`);
        const started = Date.now();
        try {
            if (this.strategy === 'http') {
                const t = new HttpTransport({ proxyUrl });
                const res = await t.request({ url: `${this.baseUrl}/`, headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
                this.stats.requests++;
                this.home = this.homeCheck(res.text, res.status, res.finalUrl);
                this.transport = t;
                log.info(`${this.tag()} Homepage loaded over HTTP (HTTP ${res.status}, "${pageTitle(res.text)}", ${Date.now() - started} ms). Cookies: ${t.jar.names().join(', ') || 'none'}.${this.describeHome()}`);
            } else {
                this.stats.browserLaunches++;
                const b = new BrowserSession({ store: this.store, label: this.label, baseUrl: this.baseUrl, proxyUrl, readySelector: this.readySelector });
                this.browser = b;
                await b.open();
                const w = await b.warmup('/');
                if (!w.ready) {
                    await this.saveScreenshot();
                    throw new BlockedError(`the real homepage did not appear within 30 s (HTTP ${w.status}, "${pageTitle(w.html)}", URL ${w.finalUrl}${findBlockMarkers(this.store, w.html).length ? `, ${findBlockMarkers(this.store, w.html).join(', ')}` : ''})`, { status: w.status, html: w.html });
                }
                this.home = this.homeCheck(w.html, w.status, w.finalUrl);
                if (this.strategy === 'browser-cookies') {
                    const t = new HttpTransport({ proxyUrl, userAgent: b.userAgent });
                    t.jar.setFromList(w.cookies);
                    this.transport = t;
                } else {
                    this.transport = b;
                }
                log.info(`${this.tag()} Homepage loaded in the browser (HTTP ${w.status}, "${pageTitle(w.html)}", ${w.ms} ms). Cookies: ${w.cookies.map((c) => c.name).join(', ') || 'none'}.${this.describeHome()}`);
            }
            this.ready = true;
        } catch (err) {
            this.stats.warmupFailures++;
            const key = await this.saveDebug('homepage', err.html);
            const msg = `${this.tag('session start')} FAILED (${STRATEGY_LABEL[this.strategy]}, ${proxyInfo}): ${err.message}${key ? ` — page saved to key-value store as ${key}` : ''}`;
            log.warning(msg);
            await this.closeSession();
            throw Object.assign(err, { blocked: err instanceof BlockedError || err.blocked, step: 'session start' });
        }
    }

    describeHome() { return ''; }

    async saveScreenshot() {
        if (!this.browser?.page || !this.saveDebugFn) return;
        try {
            const png = await this.browser.page.screenshot({ type: 'png' });
            await this.saveDebug('screenshot', png, 'image/png');
        } catch { /* best effort */ }
    }

    /** Re-runs the homepage in the same browser to get fresh anti-bot cookies (same IP). */
    async refreshCookies() {
        if (!this.browser || this.strategy !== 'browser-cookies') return false;
        this.stats.cookieRefreshes++;
        try {
            const w = await this.browser.warmup('/');
            this.home = this.homeCheck(w.html, w.status, w.finalUrl);
            const t = new HttpTransport({ proxyUrl: this.transport?.proxyUrl ?? null, userAgent: this.browser.userAgent });
            t.jar.setFromList(w.cookies);
            this.transport = t;
            log.info(`${this.tag()} Re-acquired cookies in the browser (${w.cookies.length} cookies).`);
            return true;
        } catch (err) {
            log.warning(`${this.tag()} Re-acquiring cookies failed: ${err.message}`);
            return false;
        }
    }

    /** Decides what to do after a block: refresh cookies, new IP, or switch to a real browser. */
    async escalate(step) {
        this.blocksInSession++;
        if (this.strategy === 'browser-cookies' && this.blocksInSession === 1 && await this.refreshCookies()) return;
        const canBrowse = this.browserFallback && this.strategy !== 'browser-fetch';
        if (canBrowse && this.stats.blocks >= 2) {
            const from = this.strategy;
            this.strategy = 'browser-fetch';
            this.stats.strategy = this.strategy;
            log.warning(`${this.tag(step)} ${STRATEGY_LABEL[from]} keeps getting blocked; switching to ${STRATEGY_LABEL[this.strategy]} on a new IP.`);
        } else {
            log.info(`${this.tag(step)} Rotating to a new session (new IP and cookies).`);
        }
        this.ready = false;
    }

    async throttle() {
        const now = Date.now();
        const wait = Math.max(0, this.nextRequestAt - now);
        const gap = this.requestDelayMs * (0.7 + Math.random() * 0.6);
        this.nextRequestAt = Math.max(now, this.nextRequestAt) + gap;
        if (wait) await sleep(wait);
    }

    backoff(attempt, extra = 0) {
        return Math.min(30_000, this.backoffMs * 2 ** attempt) * (0.75 + Math.random() * 0.5) + extra;
    }

    /** Makes sure a working session exists (with retries and escalation); throws RequestError if impossible. */
    async ensureSession(step) {
        if (this.ready) return;
        let last = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) this.stats.retries++;
            try {
                await this.startSession(last ? last.reason : null);
                return;
            } catch (err) {
                last = { reason: `session start failed: ${err.message}`, status: err.status ?? null, blocked: Boolean(err.blocked), markers: err.markers ?? [], step: 'session start' };
                if (err.blocked) {
                    this.stats.blocks++;
                    await this.escalate('session start');
                }
                if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
            }
        }
        throw new RequestError(`${step}: could not open ${this.label} (${last?.reason ?? 'unknown error'})`, last ?? {});
    }

    /**
     * Requests JSON with retries. Returns the parsed JSON, or { notFound: true } for HTTP 404 when allowNotFound.
     * Throws RequestError (with status/blocked/markers/step) when all attempts fail.
     */
    async requestJson({ step, url, method = 'GET', body, headers = {}, allowNotFound = false }) {
        let last = null;
        let target = typeof url === 'function' ? null : url;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) this.stats.retries++;
            if (!this.ready) {
                try {
                    await this.startSession(attempt > 0 && last ? last.reason : null);
                } catch (err) {
                    last = { reason: `session start failed: ${err.message}`, status: err.status ?? null, blocked: Boolean(err.blocked), markers: err.markers ?? [], step: 'session start' };
                    if (err.blocked) {
                        this.stats.blocks++;
                        await this.escalate('session start');
                    }
                    if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
                    continue;
                }
            }
            await this.throttle();
            let res;
            try {
                this.stats.requests++;
                // `url`/`headers` may be functions so they are built from the CURRENT session (e.g. Coles buildId).
                target = typeof url === 'function' ? url() : url;
                const h = typeof headers === 'function' ? headers() : headers;
                res = await this.transport.request({ url: target, method, body, headers: h });
            } catch (err) {
                const reason = `${err.code ?? err.name ?? 'network error'}: ${String(err.message).split('\n')[0].slice(0, 200)}`;
                last = { reason, status: null, blocked: false, markers: [], step };
                log.warning(`${this.tag(step)} request failed (${reason}); attempt ${attempt + 1}/${this.maxRetries + 1}.`);
                // Proxy/connection problems: next attempt on a new IP.
                if (/proxy|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket|tunnel|Target closed|has been closed/i.test(reason)) this.ready = false;
                if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
                continue;
            }
            const cls = classifyResponse(this.store, res);
            if (cls.ok) {
                try {
                    const data = JSON.parse(res.text);
                    this.blocksInSession = 0;
                    return data;
                } catch {
                    last = { reason: `HTTP ${res.status} but the body is not valid JSON`, status: res.status, blocked: false, markers: [], step };
                    log.warning(`${this.tag(step)} ${last.reason}; retrying.`);
                    if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
                    continue;
                }
            }
            if (cls.notFound) {
                if (allowNotFound) return { notFound: true, status: 404 };
                last = { reason: 'HTTP 404', status: 404, blocked: false, markers: [], step };
                throw new RequestError(`${step}: HTTP 404 from ${target}`, last);
            }
            last = { reason: cls.reason, status: res.status, blocked: Boolean(cls.blocked), markers: cls.markers ?? [], step };
            if (cls.blocked) {
                this.stats.blocks++;
                if (cls.rateLimited) this.stats.rateLimited++;
                const key = await this.saveDebug('blocked', res.text);
                log.warning(`${this.tag(step)} BLOCKED — ${cls.reason} (attempt ${attempt + 1}/${this.maxRetries + 1}, ${STRATEGY_LABEL[this.strategy]}, session #${this.sessionNo})${key ? `; response saved as ${key}` : ''}.`);
                if (cls.rateLimited) {
                    if (attempt < this.maxRetries) await sleep(this.backoff(attempt + 2));
                } else {
                    await this.escalate(step);
                    if (attempt < this.maxRetries) await sleep(this.backoff(Math.max(0, attempt - 1)));
                }
                continue;
            }
            if (cls.retryable) {
                log.warning(`${this.tag(step)} ${cls.reason}; retrying (attempt ${attempt + 1}/${this.maxRetries + 1}).`);
                if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
                continue;
            }
            throw new RequestError(`${step}: ${cls.reason} from ${target}`, last);
        }
        const attempts = this.maxRetries + 1;
        throw new RequestError(`${step}: gave up after ${attempts} attempt${attempts === 1 ? '' : 's'} (last: ${last?.reason ?? 'unknown'})`, last ?? {});
    }

    async close() {
        await this.closeSession();
    }
}
