// Two ways to talk to Google Trends: plain HTTP with a Chrome TLS fingerprint (impit) and a cookie jar,
// or a real Chrome (Playwright) that fetches from inside a trends.google.com page.
// Both expose request({ url, method, body, headers }) → { status, url, text, headers } and newSession() (new proxy IP + cookies).
import { Impit } from 'impit';
import { log } from 'apify';
import { CONSENT_COOKIES } from './request.js';

const rand = () => Math.random().toString(36).slice(2, 10);
export const maskProxy = (u) => (u ? u.replace(/\/\/[^@/]*@/, '//***@') : 'none');

async function newProxyUrl(proxyConfiguration, sessionId) {
    if (!proxyConfiguration) return null;
    return (await proxyConfiguration.newUrl(sessionId)) ?? null;
}

/** Minimal cookie jar for one session (one target site): name → value. */
export class CookieJar {
    constructor(initial = {}) {
        this.cookies = new Map(Object.entries(initial));
    }

    setCookie(setCookie) {
        const first = String(setCookie).split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) return;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (/;\s*max-age=0\b|;\s*expires=thu, 01[- ]jan[- ]1970/i.test(setCookie)) this.cookies.delete(name);
        else this.cookies.set(name, value);
    }

    getCookieString() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    has(name) {
        return this.cookies.has(name);
    }
}

export class HttpTransport {
    constructor({ proxyConfiguration, timeoutMs, language }) {
        this.name = 'http';
        this.proxyConfiguration = proxyConfiguration;
        this.timeoutMs = timeoutMs;
        const lang = language.split('-')[0];
        this.acceptLanguage = language.includes('-') ? `${language},${lang};q=0.9,en;q=0.8` : `${language},en;q=0.8`;
        this.impit = null;
        this.sessionId = null;
        this.proxyUrl = null;
        this.jar = null;
        this.requestsInSession = 0;
    }

    async newSession() {
        this.sessionId = `gt_${rand()}`;
        this.proxyUrl = await newProxyUrl(this.proxyConfiguration, this.sessionId);
        this.jar = new CookieJar(CONSENT_COOKIES);
        this.requestsInSession = 0;
        // Redirects are followed by hand so that cookies set on the way (consent, NID) are kept.
        this.impit = new Impit({ browser: 'chrome', proxyUrl: this.proxyUrl ?? undefined, timeout: this.timeoutMs, followRedirects: false });
    }

    get hasNid() {
        return !!this.jar?.has('NID');
    }

    async request({ url, method = 'GET', body, headers = {} }) {
        if (!this.impit) await this.newSession();
        this.requestsInSession++;
        let current = url;
        let m = method;
        let b = body;
        for (let hop = 0; hop < 6; hop++) {
            const res = await this.impit.fetch(current, {
                method: m,
                body: b,
                headers: {
                    'accept-language': this.acceptLanguage,
                    accept: 'application/json, text/plain, */*',
                    cookie: this.jar.getCookieString(),
                    ...headers,
                },
            });
            const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
            for (const c of setCookies) this.jar.setCookie(c);
            const loc = res.headers.get('location');
            if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
                await res.text().catch(() => '');
                current = new URL(loc, current).toString();
                if (res.status !== 307 && res.status !== 308) {
                    m = 'GET';
                    b = undefined;
                }
                continue;
            }
            const text = await res.text();
            return { status: res.status, url: current, text, headers: { 'retry-after': res.headers.get('retry-after'), 'content-type': res.headers.get('content-type') } };
        }
        throw new Error('too many redirects');
    }

    describe() {
        return `http session=${this.sessionId} proxy=${maskProxy(this.proxyUrl)}`;
    }

    async close() {}
}

const CONSENT_BUTTONS = [
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Tout accepter")',
    'button:has-text("Aceptar todo")',
    'button:has-text("Accetta tutto")',
    'form[action*="/save"] button',
    'input[type="submit"][value*="ccept"]',
];

export class BrowserTransport {
    constructor({ proxyConfiguration, timeoutMs, language, baseUrl, geo }) {
        this.name = 'browser';
        this.proxyConfiguration = proxyConfiguration;
        this.timeoutMs = timeoutMs;
        this.locale = language.includes('-') ? language : `${language}-US`;
        this.language = language;
        this.baseUrl = baseUrl;
        this.geo = geo;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.sessionId = null;
        this.proxyUrl = null;
        this.consentClicks = 0;
        this.hasNid = true; // the browser page itself collects cookies
    }

    async launch() {
        if (this.browser) return;
        const { chromium } = await import('playwright');
        const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-background-networking', '--disable-component-update',
            '--disable-sync', '--no-first-run', '--no-default-browser-check', '--disable-features=OptimizationHints,MediaRouter,Translate'];
        const candidates = [process.env.CHROME_PATH, undefined, process.env.APIFY_CHROME_EXECUTABLE_PATH].filter((p, i, a) => p !== '' && a.indexOf(p) === i);
        let lastErr;
        for (const executablePath of candidates) {
            try {
                this.browser = await chromium.launch({ headless: true, args, executablePath });
                log.info(`[browser] Chrome started (${executablePath ?? 'Playwright default'}).`);
                return;
            } catch (err) {
                lastErr = err;
                log.warning(`[browser] Could not start Chrome at ${executablePath ?? 'Playwright default'}: ${err.message.split('\n')[0]}`);
            }
        }
        throw lastErr;
    }

    async newSession() {
        await this.launch();
        if (this.context) await this.context.close().catch(() => {});
        this.sessionId = `gt_${rand()}`;
        this.proxyUrl = await newProxyUrl(this.proxyConfiguration, this.sessionId);
        let proxy;
        if (this.proxyUrl) {
            const p = new URL(this.proxyUrl);
            proxy = { server: `${p.protocol}//${p.host}`, username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) };
        }
        this.context = await this.browser.newContext({ locale: this.locale, proxy, viewport: { width: 1366, height: 900 } });
        const host = new URL(this.baseUrl).hostname;
        const domain = host.endsWith('google.com') ? '.google.com' : host;
        await this.context.addCookies(Object.entries(CONSENT_COOKIES).map(([name, value]) => ({ name, value, domain, path: '/' })));
        await this.context.route('**/*', (route) => (['image', 'media', 'font', 'stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(this.timeoutMs);
        this.onOrigin = false;
    }

    async handleConsent() {
        const page = this.page;
        let onConsent = /consent\./i.test(page.url()) || /\/consent/i.test(new URL(page.url()).pathname);
        if (!onConsent) {
            const txt = await page.content().catch(() => '');
            onConsent = /Before you continue|consent\.google\.[a-z.]+\/save/i.test(txt);
        }
        if (!onConsent) return false;
        for (const sel of CONSENT_BUTTONS) {
            const btn = page.locator(sel).first();
            if (await btn.count().catch(() => 0)) {
                log.info(`[browser] Google consent page detected at ${page.url().slice(0, 80)} → clicking ${sel}`);
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: this.timeoutMs }).catch(() => {}),
                    btn.click(),
                ]);
                this.consentClicks++;
                return true;
            }
        }
        log.warning('[browser] Consent page detected but no accept/reject button was found.');
        return false;
    }

    /** Opens a Trends page once per session so that requests are same-origin and carry Google's cookies. */
    async ensureOrigin() {
        if (this.onOrigin) return;
        const u = new URL('/trends/explore', this.baseUrl);
        u.searchParams.set('geo', (this.geo || 'US').split('-')[0]);
        u.searchParams.set('hl', this.language);
        await this.page.goto(u.toString(), { waitUntil: 'domcontentloaded' }).catch((err) => log.warning(`[browser] Opening ${u} failed: ${err.message.split('\n')[0]}`));
        if (await this.handleConsent()) await this.page.goto(u.toString(), { waitUntil: 'domcontentloaded' }).catch(() => {});
        this.onOrigin = true;
    }

    async request({ url, method = 'GET', body, headers = {} }) {
        if (!this.page) await this.newSession();
        await this.ensureOrigin();
        return this.page.evaluate(async ({ u, m, b, h }) => {
            const r = await fetch(u, { method: m, body: b, headers: h, credentials: 'include' });
            return { status: r.status, url: r.url, text: await r.text(), headers: { 'retry-after': r.headers.get('retry-after'), 'content-type': r.headers.get('content-type') } };
        }, { u: url, m: method, b: body, h: headers });
    }

    describe() {
        return `browser session=${this.sessionId} proxy=${maskProxy(this.proxyUrl)}`;
    }

    async close() {
        await this.browser?.close().catch(() => {});
        this.browser = null;
    }
}
