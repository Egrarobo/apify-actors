import { gotScraping } from 'got-scraping';

/** Tiny cookie jar keyed by name (one site per jar is enough here). */
export class CookieJar {
    constructor() {
        this.map = new Map();
    }

    set(name, value) {
        if (name) this.map.set(name, value);
    }

    setFromHeaders(setCookie) {
        const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        for (const line of list) {
            const [pair] = String(line).split(';');
            const i = pair.indexOf('=');
            if (i > 0) this.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
        }
    }

    setFromList(cookies) {
        for (const c of cookies ?? []) this.set(c.name, c.value);
    }

    names() {
        return [...this.map.keys()];
    }

    header() {
        return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    get size() {
        return this.map.size;
    }
}

/**
 * Plain HTTP transport (got-scraping: browser-like TLS and headers) that carries the session's cookies and,
 * when the cookies came from a browser, that browser's exact User-Agent.
 *
 * profile 'browser' (default): generated Chrome headers. profile 'plain': only the headers the caller passes
 * (API clients such as apps send few headers; some JSON APIs reject browser headers without browser cookies).
 */
export class HttpTransport {
    constructor({ proxyUrl = null, userAgent = null, timeoutMs = 30_000, profile = 'browser', locale = 'en-AU' } = {}) {
        this.kind = 'http';
        this.proxyUrl = proxyUrl;
        this.userAgent = userAgent;
        this.timeoutMs = timeoutMs;
        this.profile = profile;
        this.locale = locale;
        this.jar = new CookieJar();
    }

    async request({ url, method = 'GET', body, headers = {} }) {
        const h = { ...headers };
        if (this.profile === 'plain' && !this.userAgent) {
            // No generated browser identity at all.
        } else if (this.userAgent) {
            // Cookies came from a real browser: present exactly that browser's identity (no generated headers that
            // could contradict it).
            const major = this.userAgent.match(/Chrome\/(\d+)/)?.[1];
            h['user-agent'] = this.userAgent;
            h['accept-language'] ??= `${this.locale},en;q=0.9`;
            if (major) {
                h['sec-ch-ua'] ??= `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not?A_Brand";v="99"`;
                h['sec-ch-ua-mobile'] ??= '?0';
                h['sec-ch-ua-platform'] ??= /Windows/.test(this.userAgent) ? '"Windows"' : /Mac OS/.test(this.userAgent) ? '"macOS"' : '"Linux"';
            }
        }
        const cookie = this.jar.header();
        if (cookie) h.cookie = cookie;
        if (body !== undefined && body !== null && typeof body !== 'string') h['content-type'] ??= 'application/json';
        const res = await gotScraping({
            url,
            method,
            body: body === undefined || body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
            headers: h,
            proxyUrl: this.proxyUrl ?? undefined,
            throwHttpErrors: false,
            followRedirect: true,
            timeout: { request: this.timeoutMs },
            retry: { limit: 0 },
            useHeaderGenerator: !this.userAgent && this.profile !== 'plain',
            headerGeneratorOptions: {
                browsers: [{ name: 'chrome', minVersion: 124 }],
                devices: ['desktop'],
                operatingSystems: ['windows'],
                locales: [this.locale, 'en'],
            },
        });
        this.jar.setFromHeaders(res.headers['set-cookie']);
        return {
            status: res.statusCode,
            contentType: res.headers['content-type'] ?? '',
            text: res.body ?? '',
            finalUrl: res.url,
        };
    }

    async close() { /* nothing to close */ }
}

/** Best-effort public IP of a proxy session (for the log). Never throws. */
export async function lookupExitIp(proxyUrl) {
    try {
        const res = await gotScraping({ url: 'https://api.ipify.org?format=json', proxyUrl, timeout: { request: 8000 }, retry: { limit: 0 }, throwHttpErrors: false, responseType: 'json' });
        return res.body?.ip ?? null;
    } catch {
        return null;
    }
}
