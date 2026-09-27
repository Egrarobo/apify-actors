// Two ways to talk to Google: plain HTTP with a Chrome TLS fingerprint (impit), or a real Chrome (Playwright).
// Both expose request({ url, method, body, headers }) → { status, url, text } and newSession() (new proxy IP).
import { Impit } from 'impit';
import { log } from 'apify';
import { CONSENT_COOKIES, consentCookieHeader } from './request.js';

const rand = () => Math.random().toString(36).slice(2, 10);
export const maskProxy = (u) => (u ? u.replace(/\/\/[^@/]*@/, '//***@') : 'none');

async function newProxyUrl(proxyConfiguration, sessionId) {
    if (!proxyConfiguration) return null;
    return (await proxyConfiguration.newUrl(sessionId)) ?? null;
}

export class HttpTransport {
    constructor({ proxyConfiguration, timeoutMs, language, country }) {
        this.name = 'http';
        this.proxyConfiguration = proxyConfiguration;
        this.timeoutMs = timeoutMs;
        this.acceptLanguage = `${language}-${country.toUpperCase()},${language};q=0.9,en;q=0.8`;
        this.impit = null;
        this.sessionId = null;
        this.proxyUrl = null;
    }

    async newSession() {
        this.sessionId = `gh_${rand()}`;
        this.proxyUrl = await newProxyUrl(this.proxyConfiguration, this.sessionId);
        this.impit = new Impit({ browser: 'chrome', proxyUrl: this.proxyUrl ?? undefined, timeout: this.timeoutMs, followRedirects: true, maxRedirects: 8 });
    }

    async request({ url, method = 'GET', body, headers = {} }) {
        if (!this.impit) await this.newSession();
        const res = await this.impit.fetch(url, {
            method,
            body,
            headers: {
                'accept-language': this.acceptLanguage,
                accept: method === 'GET' ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : '*/*',
                cookie: consentCookieHeader(),
                ...headers,
            },
        });
        const text = await res.text();
        return { status: res.status, url: res.url || url, text };
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
    constructor({ proxyConfiguration, timeoutMs, language, country, baseUrl }) {
        this.name = 'browser';
        this.proxyConfiguration = proxyConfiguration;
        this.timeoutMs = timeoutMs;
        this.locale = `${language}-${country.toUpperCase()}`;
        this.baseUrl = baseUrl;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.sessionId = null;
        this.proxyUrl = null;
        this.consentClicks = 0;
    }

    async launch() {
        if (this.browser) return;
        const { chromium } = await import('playwright');
        // No background traffic (component updates, sync, etc.): saves proxy bandwidth and avoids extra Google hits.
        const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-background-networking', '--disable-component-update',
            '--disable-sync', '--no-first-run', '--no-default-browser-check', '--disable-features=OptimizationHints,MediaRouter,Translate'];
        // CHROME_PATH for local runs; then Playwright's own browser; then the Chrome shipped in the Apify image.
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
        this.sessionId = `gh_${rand()}`;
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
        // Images, fonts and media are not needed: saves proxy traffic.
        await this.context.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(this.timeoutMs);
    }

    /** Clicks through Google's cookie consent page if it is shown. Returns true when a button was clicked. */
    async handleConsent() {
        const page = this.page;
        const onConsent = () => /consent\./i.test(page.url()) || /\/consent/i.test(new URL(page.url()).pathname);
        if (!onConsent()) {
            const txt = await page.content().catch(() => '');
            if (!/Before you continue|consent\.google\.[a-z.]+\/save/i.test(txt)) return false;
        }
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

    async ensureOrigin() {
        const origin = new URL(this.baseUrl).origin;
        if (!this.page.url().startsWith(origin)) {
            await this.page.goto(`${origin}/travel/hotels`, { waitUntil: 'domcontentloaded' });
            await this.handleConsent();
        }
    }

    async request({ url, method = 'GET', body, headers = {} }) {
        if (!this.page) await this.newSession();
        if (method === 'GET') {
            let resp = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
            if (await this.handleConsent()) {
                // After consent Google redirects back; make sure we are on the requested page.
                if (!this.page.url().startsWith(url.split('?')[0])) resp = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
                else resp = null;
            }
            return { status: resp ? resp.status() : 200, url: this.page.url(), text: await this.page.content() };
        }
        // RPC POST from inside the page (same origin, same cookies as a real visitor).
        await this.ensureOrigin();
        return this.page.evaluate(async ({ u, b, h }) => {
            const r = await fetch(u, { method: 'POST', body: b, headers: h, credentials: 'include' });
            return { status: r.status, url: r.url, text: await r.text() };
        }, { u: url, b: body, h: headers });
    }

    describe() {
        return `browser session=${this.sessionId} proxy=${maskProxy(this.proxyUrl)}`;
    }

    async close() {
        await this.browser?.close().catch(() => {});
        this.browser = null;
    }
}
