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
const PROFILE_LABEL = { browser: 'browser-like headers', plain: 'minimal API headers' };

/**
 * Store-agnostic session manager for a JSON API that lives next to a website (api.x / xapi.x): proxy session,
 * optional browser warm-up (cookies), retries with backoff, block detection and escalation
 * (other header profile → new IP → cookies from a real browser → requests from inside the browser).
 *
 * - `siteUrl`: the website (opened by the browser strategies).
 * - `apiUrl`: where the JSON API lives. Plain-HTTP sessions do NOT load the website first (unlike Coles/Woolworths,
 *   these APIs need no cookies, and the websites are the parts most likely to be bot-protected).
 */
export class StoreClient {
    constructor({
        store, label, siteUrl, apiUrl, proxyConfiguration = null, useBrowserForCookies = false, browserFallback = true,
        maxRetries = 4, requestDelayMs = 800, backoffMs = 1500, saveDebug = null, readySelector = null,
        httpProfiles = ['browser'], locale = 'en-AU', timezoneId = 'Australia/Sydney',
    }) {
        this.store = store;
        this.label = label;
        this.siteUrl = siteUrl.replace(/\/+$/, '');
        this.apiUrl = (apiUrl ?? siteUrl).replace(/\/+$/, '');
        this.proxyConfiguration = proxyConfiguration;
        this.browserFallback = browserFallback;
        this.maxRetries = maxRetries;
        this.requestDelayMs = requestDelayMs;
        this.backoffMs = backoffMs;
        this.saveDebugFn = saveDebug;
        this.readySelector = readySelector;
        this.httpProfiles = httpProfiles;
        this.profileIndex = 0;
        this.locale = locale;
        this.timezoneId = timezoneId;
        this.strategy = useBrowserForCookies ? 'browser-cookies' : 'http';
        this.transport = null;
        this.browser = null;
        this.ready = false;
        this.sessionNo = 0;
        this.blocksInSession = 0;
        this.nextRequestAt = 0;
        this.debugSaved = 0;
        this.stats = {
            requests: 0, retries: 0, blocks: 0, rateLimited: 0, sessions: 0, warmupFailures: 0, browserLaunches: 0,
            cookieRefreshes: 0, strategy: this.strategy, headerProfile: this.profile,
        };
    }

    get profile() {
        return this.httpProfiles[this.profileIndex] ?? 'browser';
    }

    tag(step) {
        return `[${this.label}]${step ? ` ${step}:` : ''}`;
    }

    describe() {
        return this.strategy === 'http' ? `${STRATEGY_LABEL.http}, ${PROFILE_LABEL[this.profile]}` : STRATEGY_LABEL[this.strategy];
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

    homeCheck(html, status) {
        const markers = findBlockMarkers(html);
        if (markers.length || status === 403 || status === 401 || status === 429) {
            throw new BlockedError(`website answered HTTP ${status} with ${markers.length ? markers.join(', ') : `a page titled "${pageTitle(html)}"`}`,
                { status, markers, html });
        }
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
        this.stats.lastExitIp = ip;
        log.info(`${this.tag()} Starting session #${this.sessionNo} (${this.describe()}, ${proxyInfo})${reason ? ` because ${reason}` : ''}…`);
        const started = Date.now();
        try {
            if (this.strategy === 'http') {
                this.transport = new HttpTransport({ proxyUrl, profile: this.profile, locale: this.locale });
            } else {
                this.stats.browserLaunches++;
                const b = new BrowserSession({
                    store: this.store, label: this.label, baseUrl: this.siteUrl, proxyUrl, readySelector: this.readySelector,
                    locale: this.locale, timezoneId: this.timezoneId,
                });
                this.browser = b;
                await b.open();
                const w = await b.warmup('/');
                if (!w.ready) {
                    await this.saveScreenshot();
                    throw new BlockedError(`the real website did not appear within 30 s (HTTP ${w.status}, "${pageTitle(w.html)}", URL ${w.finalUrl})`, { status: w.status, html: w.html });
                }
                this.homeCheck(w.html, w.status);
                if (this.strategy === 'browser-cookies') {
                    const t = new HttpTransport({ proxyUrl, userAgent: b.userAgent, locale: this.locale });
                    t.jar.setFromList(w.cookies);
                    this.transport = t;
                } else {
                    this.transport = b;
                }
                log.info(`${this.tag()} Website loaded in the browser (HTTP ${w.status}, "${pageTitle(w.html)}", ${w.ms} ms). Cookies: ${w.cookies.map((c) => c.name).join(', ') || 'none'}.`);
            }
            this.ready = true;
            if (this.strategy === 'http') log.info(`${this.tag()} Session #${this.sessionNo} ready (${Date.now() - started} ms).`);
        } catch (err) {
            this.stats.warmupFailures++;
            const key = await this.saveDebug('website', err.html);
            log.warning(`${this.tag('session start')} FAILED (${this.describe()}, ${proxyInfo}): ${err.message}${key ? ` — page saved to key-value store as ${key}` : ''}`);
            await this.closeSession();
            throw Object.assign(err, { blocked: err instanceof BlockedError || err.blocked, step: err.step ?? 'session start' });
        }
    }

    async saveScreenshot() {
        if (!this.browser?.page || !this.saveDebugFn) return;
        try {
            const png = await this.browser.page.screenshot({ type: 'png' });
            await this.saveDebug('screenshot', png, 'image/png');
        } catch { /* best effort */ }
    }

    /** Re-runs the website in the same browser to get fresh anti-bot cookies (same IP). */
    async refreshCookies() {
        if (!this.browser || this.strategy !== 'browser-cookies') return false;
        this.stats.cookieRefreshes++;
        try {
            const w = await this.browser.warmup('/');
            this.homeCheck(w.html, w.status);
            const t = new HttpTransport({ proxyUrl: this.transport?.proxyUrl ?? null, userAgent: this.browser.userAgent, locale: this.locale });
            t.jar.setFromList(w.cookies);
            this.transport = t;
            log.info(`${this.tag()} Re-acquired cookies in the browser (${w.cookies.length} cookies).`);
            return true;
        } catch (err) {
            log.warning(`${this.tag()} Re-acquiring cookies failed: ${err.message}`);
            return false;
        }
    }

    /** Decides what to do after a block: refresh cookies, other header profile, new IP, or a real browser. */
    async escalate(step) {
        this.blocksInSession++;
        if (this.strategy === 'browser-cookies' && this.blocksInSession === 1 && await this.refreshCookies()) return;
        if (this.strategy === 'http' && this.profileIndex < this.httpProfiles.length - 1) {
            const from = this.profile;
            this.profileIndex++;
            this.stats.headerProfile = this.profile;
            log.warning(`${this.tag(step)} Blocked with ${PROFILE_LABEL[from]}; retrying with ${PROFILE_LABEL[this.profile]} on a new IP.`);
            this.ready = false;
            return;
        }
        const canBrowse = this.browserFallback && this.strategy !== 'browser-fetch';
        if (canBrowse && this.stats.blocks >= 2) {
            const from = this.describe();
            this.strategy = 'browser-fetch';
            this.stats.strategy = this.strategy;
            log.warning(`${this.tag(step)} ${from} keeps getting blocked; switching to ${STRATEGY_LABEL[this.strategy]} on a new IP.`);
        } else {
            log.info(`${this.tag(step)} Rotating to a new session (new IP).`);
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

    /** Store hook: called on HTTP 401/403 "Invalid Client". Return true if a new API key was obtained. */
    async onApiKeyRejected() { return false; }

    /**
     * Requests JSON with retries. Returns the parsed JSON, or { notFound: true } for HTTP 404 when allowNotFound.
     * Throws RequestError (with status/blocked/markers/step) when all attempts fail.
     * `url`, `headers` and `body` may be functions so they are built from the CURRENT session (e.g. a new API key).
     */
    async requestJson({ step, url, method = 'GET', body, headers = {}, allowNotFound = false }) {
        let last = null;
        let target = typeof url === 'function' ? null : url;
        let keyRetried = false;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) this.stats.retries++;
            if (!this.ready) {
                try {
                    await this.startSession(attempt > 0 && last ? last.reason : null);
                } catch (err) {
                    last = { reason: `session start failed: ${err.message}`, status: err.status ?? null, blocked: Boolean(err.blocked), markers: err.markers ?? [], step: err.step ?? 'session start' };
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
                target = typeof url === 'function' ? url() : url;
                const h = typeof headers === 'function' ? headers() : headers;
                const b = typeof body === 'function' ? body() : body;
                res = await this.transport.request({ url: target, method, body: b, headers: h });
            } catch (err) {
                const reason = `${err.code ?? err.name ?? 'network error'}: ${String(err.message).split('\n')[0].slice(0, 200)}`;
                last = { reason, status: null, blocked: false, markers: [], step };
                log.warning(`${this.tag(step)} request failed (${reason}); attempt ${attempt + 1}/${this.maxRetries + 1}.`);
                // Proxy/connection problems: next attempt on a new IP.
                if (/proxy|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket|tunnel|Target closed|has been closed|timeout/i.test(reason)) this.ready = false;
                if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
                continue;
            }
            const cls = classifyResponse(res);
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
                last = { reason: cls.reason, status: 404, blocked: false, markers: [], step };
                throw new RequestError(`${step}: ${cls.reason} from ${target}`, last);
            }
            if (cls.apiKeyRejected) {
                last = { reason: cls.reason, status: res.status, blocked: false, markers: [], step, apiKeyRejected: true };
                log.warning(`${this.tag(step)} ${cls.reason}.`);
                if (!keyRetried && await this.onApiKeyRejected()) {
                    keyRetried = true;
                    attempt--; // does not count as a retry
                    continue;
                }
                throw new RequestError(`${step}: ${cls.reason}`, last);
            }
            last = { reason: cls.reason, status: res.status, blocked: Boolean(cls.blocked), markers: cls.markers ?? [], step };
            if (cls.blocked) {
                this.stats.blocks++;
                if (cls.rateLimited) this.stats.rateLimited++;
                const key = await this.saveDebug('blocked', res.text);
                log.warning(`${this.tag(step)} BLOCKED — ${cls.reason} (attempt ${attempt + 1}/${this.maxRetries + 1}, ${this.describe()}, session #${this.sessionNo}${this.stats.lastExitIp ? `, exit IP ${this.stats.lastExitIp}` : ''})${key ? `; response saved as ${key}` : ''}.`);
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
