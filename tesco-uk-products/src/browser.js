import { existsSync } from 'node:fs';
import { log } from 'apify';

let playwrightModule = null;
async function loadChromium() {
    playwrightModule ??= await import('playwright');
    return playwrightModule.chromium;
}

// Launch flag measured by 2scraper/woolworths-scraper (2026-09-16) on an Akamai-protected grocery site: without it
// navigator.webdriver is true and the site treats the page as a bot.
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];

function proxyForPlaywright(proxyUrl) {
    if (!proxyUrl) return undefined;
    const u = new URL(proxyUrl);
    return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
    };
}

async function launch({ proxyUrl, headless }) {
    const chromium = await loadChromium();
    const base = { headless, args: LAUNCH_ARGS, proxy: proxyForPlaywright(proxyUrl) };
    const candidates = [];
    const envPath = process.env.BROWSER_EXECUTABLE_PATH || process.env.APIFY_CHROME_EXECUTABLE_PATH;
    if (envPath) candidates.push({ label: `executable ${envPath}`, opts: { ...base, executablePath: envPath } });
    candidates.push({ label: 'Playwright Chromium', opts: base });
    for (const p of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium']) {
        if (existsSync(p) && p !== envPath) candidates.push({ label: `executable ${p}`, opts: { ...base, executablePath: p } });
    }
    const errors = [];
    for (const c of candidates) {
        try {
            const browser = await chromium.launch(c.opts);
            return { browser, label: c.label, headless };
        } catch (err) {
            errors.push(`${c.label}: ${String(err.message).split('\n')[0]}`);
        }
    }
    if (!headless) {
        // No working virtual display (Xvfb): headless is less stealthy but better than nothing.
        log.warning(`Headful browser could not start (${errors[0]}); trying headless.`);
        return launch({ proxyUrl, headless: true });
    }
    throw new Error(`Could not start a browser. ${errors.join(' | ')}`);
}

/**
 * One real browser session on one proxy IP. Opens the store homepage (runs the anti-bot JavaScript, collects
 * cookies), then can either hand over cookies + User-Agent to the HTTP transport or fetch JSON from inside the
 * page (same TLS fingerprint and cookies as a real visitor).
 */
export class BrowserSession {
    constructor({
        store, label = store, baseUrl, proxyUrl = null, readySelector = null, navTimeoutMs = 60_000, saveDebug = null,
        locale = 'en-AU', timezoneId = 'Australia/Sydney',
    }) {
        this.kind = 'browser';
        this.store = store;
        this.label = label;
        this.baseUrl = baseUrl;
        this.proxyUrl = proxyUrl;
        this.readySelector = readySelector;
        this.navTimeoutMs = navTimeoutMs;
        this.saveDebug = saveDebug;
        this.locale = locale;
        this.timezoneId = timezoneId;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.userAgent = null;
        this.headless = !process.env.DISPLAY || process.env.FORCE_HEADLESS === '1';
    }

    async open() {
        const { browser, label, headless } = await launch({ proxyUrl: this.proxyUrl, headless: this.headless });
        this.browser = browser;
        this.headless = headless;
        // Headless Chrome announces itself as "HeadlessChrome" — a giveaway. Present a normal Chrome UA instead.
        const major = String(browser.version()).split('.')[0];
        const userAgent = this.headless ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` : undefined;
        this.context = await browser.newContext({
            userAgent,
            locale: this.locale,
            timezoneId: this.timezoneId,
            viewport: { width: 1366, height: 768 },
        });
        // Save bandwidth (proxy traffic): images, fonts and media are not needed for the anti-bot scripts.
        await this.context.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (t === 'image' || t === 'media' || t === 'font') return route.abort();
            return route.continue();
        });
        this.page = await this.context.newPage();
        this.userAgent = await this.page.evaluate(() => navigator.userAgent).catch(() => null);
        log.info(`[${this.label}] Browser started (${label}, ${this.headless ? 'headless' : 'headful via virtual display'}).`);
        return this;
    }

    /** Loads the homepage and waits for the real site (not a challenge page). Returns { status, html, cookies, finalUrl }. */
    async warmup(path = '/') {
        if (!this.page) await this.open();
        const url = new URL(path, this.baseUrl).href;
        const started = Date.now();
        let status = 0;
        let navError = null;
        try {
            const res = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.navTimeoutMs });
            status = res?.status() ?? 0;
        } catch (err) {
            navError = err;
        }
        let ready = false;
        if (!navError && this.readySelector) {
            // An Imperva/Akamai challenge page runs its script and then reloads into the real page.
            ready = await this.page.waitForSelector(this.readySelector, { state: 'attached', timeout: 30_000 }).then(() => true, () => false);
        } else if (!navError) {
            ready = true;
        }
        // Give the bot-protection sensor scripts a moment to post and set their cookies.
        await this.page.waitForTimeout(2500).catch(() => {});
        const html = await this.page.content().catch(() => '');
        const finalUrl = this.page.url();
        const cookies = await this.context.cookies().catch(() => []);
        const ms = Date.now() - started;
        if (navError) throw Object.assign(new Error(`Browser could not open ${url}: ${String(navError.message).split('\n')[0]}`), { status, html, finalUrl, cookies });
        return { status, html, cookies, finalUrl, ready, ms };
    }

    async request({ url, method = 'GET', body, headers = {} }) {
        if (!this.page) throw new Error('Browser session is not open.');
        const payload = body === undefined || body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
        const h = { ...headers };
        delete h['user-agent'];
        delete h.cookie;
        if (payload !== null) h['content-type'] ??= 'application/json';
        // The JSON API lives on another host than the page (api.* / xapi.*). Try with cookies first (like the site),
        // then without if the API does not allow credentialed cross-origin requests.
        const res = await this.page.evaluate(async ([u, m, b, hh]) => {
            const go = async (credentials) => {
                const r = await fetch(u, { method: m, headers: hh, body: b ?? undefined, credentials });
                return { status: r.status, contentType: r.headers.get('content-type') ?? '', text: await r.text(), finalUrl: r.url };
            };
            try {
                return await go('include');
            } catch {
                return go('omit');
            }
        }, [url, method, payload, h]);
        return res;
    }

    async cookies() {
        return this.context ? this.context.cookies() : [];
    }

    async close() {
        const b = this.browser;
        this.browser = null;
        this.context = null;
        this.page = null;
        if (b) await b.close().catch(() => {});
    }
}
