// Two ways to talk to an ACA portal, both with the same request() interface:
//   HttpTransport    got-scraping (browser-like TLS + headers) with its own cookie jar. Fast and cheap.
//   BrowserTransport a real Chrome (Playwright): pages are opened with page.goto and form posts are sent with
//                    fetch() from inside the page, so cookies, TLS fingerprint and any anti-bot tokens are a real
//                    browser's. Used when plain HTTP is blocked. Its cookies can also be handed to HttpTransport.
import { existsSync } from 'node:fs';
import { log } from 'apify';
import { gotScraping } from 'got-scraping';

export class CookieJar {
    constructor() {
        this.map = new Map();
    }

    setFromHeaders(setCookie) {
        const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        for (const line of list) {
            const [pair] = String(line).split(';');
            const i = pair.indexOf('=');
            if (i > 0) this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }

    setFromList(cookies) {
        for (const c of cookies ?? []) this.map.set(c.name, c.value);
    }

    names() {
        return [...this.map.keys()];
    }

    header() {
        return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

export class HttpTransport {
    constructor({ proxyUrl = null, userAgent = null, timeoutMs = 45_000 } = {}) {
        this.kind = 'http';
        this.proxyUrl = proxyUrl;
        this.userAgent = userAgent;
        this.timeoutMs = timeoutMs;
        this.jar = new CookieJar();
    }

    async request({ url, method = 'GET', body = null, headers = {}, referer = null }) {
        const h = { accept: HTML_ACCEPT, 'accept-language': 'en-US,en;q=0.9', ...headers };
        if (this.userAgent) h['user-agent'] = this.userAgent;
        if (referer) h.referer = referer;
        if (body !== null) {
            h['content-type'] ??= 'application/x-www-form-urlencoded';
            try {
                h.origin ??= new URL(url).origin;
            } catch { /* ignore */ }
        }
        const cookie = this.jar.header();
        if (cookie) h.cookie = cookie;
        // Redirects are followed by hand so cookies set on the way (ASP.NET_SessionId) are kept.
        let current = url;
        let m = method;
        let b = body;
        for (let hop = 0; hop < 6; hop++) {
            const res = await gotScraping({
                url: current,
                method: m,
                body: b ?? undefined,
                headers: { ...h, cookie: this.jar.header() || undefined },
                proxyUrl: this.proxyUrl ?? undefined,
                throwHttpErrors: false,
                followRedirect: false,
                timeout: { request: this.timeoutMs },
                retry: { limit: 0 },
                useHeaderGenerator: !this.userAgent,
                headerGeneratorOptions: { browsers: [{ name: 'chrome', minVersion: 124 }], devices: ['desktop'], operatingSystems: ['windows'], locales: ['en-US'] },
                responseType: 'buffer',
            });
            this.jar.setFromHeaders(res.headers['set-cookie']);
            const loc = res.headers.location;
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
                current = new URL(loc, current).href;
                if (res.statusCode !== 307 && res.statusCode !== 308) {
                    m = 'GET';
                    b = null;
                    delete h['content-type'];
                }
                continue;
            }
            const buf = res.body ?? Buffer.alloc(0);
            return {
                status: res.statusCode,
                contentType: String(res.headers['content-type'] ?? ''),
                disposition: String(res.headers['content-disposition'] ?? ''),
                text: buf.toString('utf8'),
                finalUrl: current,
            };
        }
        throw new Error(`Too many redirects starting at ${url}`);
    }

    async close() { /* nothing to close */ }
}

// ─────────────────────────────── browser ───────────────────────────────

let chromiumPromise = null;
const loadChromium = () => {
    chromiumPromise ??= import('playwright').then((m) => m.chromium);
    return chromiumPromise;
};

function proxyForPlaywright(proxyUrl) {
    if (!proxyUrl) return undefined;
    const u = new URL(proxyUrl);
    return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
    };
}

async function launchBrowser({ proxyUrl, headless }) {
    const chromium = await loadChromium();
    const base = { headless, args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'], proxy: proxyForPlaywright(proxyUrl) };
    const candidates = [];
    const envPath = process.env.BROWSER_EXECUTABLE_PATH || process.env.APIFY_CHROME_EXECUTABLE_PATH;
    if (envPath) candidates.push({ label: `executable ${envPath}`, opts: { ...base, executablePath: envPath } });
    candidates.push({ label: 'Playwright Chromium', opts: base });
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
        if (existsSync(p) && p !== envPath) candidates.push({ label: `executable ${p}`, opts: { ...base, executablePath: p } });
    }
    const errors = [];
    for (const c of candidates) {
        try {
            return { browser: await chromium.launch(c.opts), label: c.label, headless };
        } catch (err) {
            errors.push(`${c.label}: ${String(err.message).split('\n')[0]}`);
        }
    }
    if (!headless) return launchBrowser({ proxyUrl, headless: true });
    throw new Error(`Could not start a browser (${errors.join(' | ')})`);
}

export class BrowserTransport {
    constructor({ proxyUrl = null, navTimeoutMs = 60_000 } = {}) {
        this.kind = 'browser';
        this.proxyUrl = proxyUrl;
        this.navTimeoutMs = navTimeoutMs;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.userAgent = null;
        this.headless = !process.env.DISPLAY || process.env.FORCE_HEADLESS === '1';
    }

    async open() {
        const { browser, label, headless } = await launchBrowser({ proxyUrl: this.proxyUrl, headless: this.headless });
        this.browser = browser;
        this.headless = headless;
        const major = String(browser.version()).split('.')[0];
        this.context = await browser.newContext({
            // Headless Chrome announces "HeadlessChrome" in its UA; present a normal Chrome UA instead.
            userAgent: headless ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : undefined,
            locale: 'en-US',
            viewport: { width: 1366, height: 900 },
        });
        await this.context.route('**/*', (route) => {
            const t = route.request().resourceType();
            return t === 'image' || t === 'media' || t === 'font' ? route.abort() : route.continue();
        });
        this.page = await this.context.newPage();
        // Status of the latest main-frame navigation (a challenge page answers 403, then reloads into the real 200 page).
        this.page.on('response', (r) => {
            try {
                if (r.request().isNavigationRequest() && r.frame() === this.page.mainFrame()) this.lastNavStatus = r.status();
            } catch { /* ignore */ }
        });
        this.userAgent = await this.page.evaluate(() => navigator.userAgent).catch(() => null);
        log.info(`Browser started (${label}, ${headless ? 'headless' : 'headful via virtual display'}).`);
        return this;
    }

    /** GET = real navigation (runs anti-bot JavaScript); POST = fetch() from inside the page. */
    async request({ url, method = 'GET', body = null }) {
        if (!this.page) await this.open();
        if (method === 'GET') {
            this.lastNavStatus = null;
            const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs });
            // A challenge page reloads itself into the real page; give it a moment.
            let html = await this.page.content();
            if (/Just a moment|cf_chl_opt|_Incapsula_Resource/.test(html.slice(0, 12_000))) {
                await this.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
                await this.page.waitForTimeout(3000);
                html = await this.page.content();
            }
            return { status: this.lastNavStatus ?? res?.status() ?? 0, contentType: 'text/html', disposition: '', text: html, finalUrl: this.page.url() };
        }
        return this.page.evaluate(async ([u, m, b]) => {
            const r = await fetch(u, { method: m, body: b ?? undefined, credentials: 'include', headers: b ? { 'content-type': 'application/x-www-form-urlencoded' } : {} });
            return { status: r.status, contentType: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '', text: await r.text(), finalUrl: r.url };
        }, [url, method, body]);
    }

    async cookies() {
        return this.context ? this.context.cookies() : [];
    }

    async screenshot() {
        return this.page ? this.page.screenshot({ type: 'png' }).catch(() => null) : null;
    }

    async close() {
        const b = this.browser;
        this.browser = null;
        this.page = null;
        this.context = null;
        if (b) await b.close().catch(() => {});
    }
}

/** Best-effort public IP of a proxy session, for the log. Never throws. */
export async function lookupExitIp(proxyUrl) {
    try {
        const res = await gotScraping({ url: 'https://api.ipify.org?format=json', proxyUrl, timeout: { request: 8000 }, retry: { limit: 0 }, throwHttpErrors: false, responseType: 'json' });
        return res.body?.ip ?? null;
    } catch {
        return null;
    }
}
