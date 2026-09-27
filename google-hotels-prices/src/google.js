// Google Hotels client: retries with new sessions/proxy IPs, detects consent and captcha pages,
// falls back from the search page to the RPC endpoint, and from HTTP to a real browser.
import { Actor, log } from 'apify';
import { HttpTransport, BrowserTransport } from './transport.js';
import { buildSearchUrl, buildRpcInner, buildRpcBody, buildRpcUrl, buildHotelUrl, RPC_ID } from './request.js';
import { classifyResponse, parseSearchHtml, parseSearchPayload, decodeBatchExecute, parseDetailPayload, parseDetailHtml, RpcDecodeError } from './parse.js';

export class BlockedError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_MS = Number(process.env.GH_BACKOFF_MS ?? 1500);
const MAX_DEBUG_PAGES = 5;

export class GoogleClient {
    constructor(cfg, proxyConfiguration) {
        this.cfg = cfg;
        this.proxyConfiguration = proxyConfiguration;
        const opts = { proxyConfiguration, timeoutMs: cfg.requestTimeoutSecs * 1000, language: cfg.language, country: cfg.country, baseUrl: cfg.baseUrl };
        this.http = new HttpTransport(opts);
        this.browserOpts = opts;
        this.browser = null;
        this.useBrowserOnly = cfg.useBrowser === 'always';
        this.stats = { requests: 0, retries: 0, ok: 0, consentPages: 0, captchaPages: 0, blocked: 0, httpErrors: 0, networkErrors: 0, noData: 0, browserRequests: 0, sessionsCreated: 0, switchedToBrowser: false };
        this.debugSaved = 0;
        this.pathFailures = new Map(); // detail path → consecutive failures
        this.pathSuccess = new Set();
        this.stickySearchMethod = null;
    }

    async close() {
        await this.http.close();
        await this.browser?.close();
    }

    getBrowser() {
        if (!this.browser) this.browser = new BrowserTransport(this.browserOpts);
        return this.browser;
    }

    async saveDebug(label, res) {
        if (!this.cfg.saveDebugPages || this.debugSaved >= MAX_DEBUG_PAGES) return;
        this.debugSaved++;
        const key = `DEBUG-${this.debugSaved}-${label.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40)}`;
        const isHtml = /<html|<!doctype/i.test(res.text.slice(0, 500));
        await Actor.setValue(key, `<!-- status=${res.status} url=${res.url} -->\n${res.text}`, { contentType: isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' }).catch(() => {});
        log.info(`[debug] Saved the response for "${label}" to the key-value store as ${key} (status ${res.status}, ${res.text.length} bytes).`);
    }

    /**
     * Sends a request with retries. `interpret(res)` returns { ok: true, value } when data was found,
     * { ok: false, retry: bool, reason } otherwise. Throws BlockedError when all attempts fail.
     */
    async attempt(transport, label, req, interpret) {
        const maxAttempts = this.cfg.maxRetries + 1;
        let lastReason = 'no attempt';
        for (let i = 1; i <= maxAttempts; i++) {
            if (i > 1) {
                this.stats.retries++;
                await transport.newSession();
                this.stats.sessionsCreated++;
                await sleep(Math.min(BACKOFF_MS * 2 ** (i - 2), 20_000) * (0.75 + Math.random() * 0.5));
            }
            this.stats.requests++;
            if (transport.name === 'browser') this.stats.browserRequests++;
            const t0 = Date.now();
            let res;
            try {
                res = await transport.request(req);
            } catch (err) {
                this.stats.networkErrors++;
                lastReason = `network error: ${err.message.split('\n')[0]}`;
                log.warning(`[${label}] attempt ${i}/${maxAttempts} via ${transport.describe()}: ${lastReason}`);
                continue;
            }
            const ms = Date.now() - t0;
            const cls = classifyResponse(res);
            let out = { ok: false, retry: true, reason: 'not parsed' };
            if (res.status === 200) {
                try {
                    out = interpret(res);
                } catch (err) {
                    out = { ok: false, retry: false, reason: `parse error: ${err.message}` };
                }
            }
            const diag = `status=${res.status} ${ms}ms bytes=${res.text.length} consent=${cls.consent ? 'YES' : 'no'} captcha=${cls.captcha ? 'YES' : 'no'}`
                + `${res.url && res.url !== req.url ? ` finalUrl=${res.url.slice(0, 100)}` : ''}`;
            if (out.ok) {
                this.stats.ok++;
                log.info(`[${label}] attempt ${i}/${maxAttempts} via ${transport.name}: ${diag} → ${out.summary ?? 'ok'}`);
                return out.value;
            }
            if (cls.captcha) this.stats.captchaPages++;
            else if (cls.consent) this.stats.consentPages++;
            else if (cls.kind === 'blocked') this.stats.blocked++;
            else if (cls.kind === 'http-error') this.stats.httpErrors++;
            else this.stats.noData++;
            lastReason = cls.captcha ? 'captcha / "unusual traffic" page' : cls.consent ? 'cookie consent page' : cls.kind !== 'ok' ? `HTTP ${res.status}` : out.reason;
            log.warning(`[${label}] attempt ${i}/${maxAttempts} via ${transport.describe()}: ${diag} → ${lastReason}`);
            if (i === 1 || i === maxAttempts) await this.saveDebug(label, res);
            // 404/400 or a well-formed "no data" answer will not change with another IP.
            if (cls.kind === 'http-error' && res.status < 500 && res.status !== 408) break;
            if (cls.kind === 'ok' && res.status === 200 && out.retry === false) break;
        }
        throw new BlockedError(lastReason);
    }

    /** Runs `fn(transport)` over HTTP, then in the browser if allowed and HTTP failed. */
    async withFallback(label, fn) {
        if (!this.useBrowserOnly) {
            try {
                return await fn(this.http);
            } catch (err) {
                if (!(err instanceof BlockedError) || this.cfg.useBrowser === 'never') throw err;
                log.warning(`[${label}] HTTP failed (${err.message}). Switching to a real Chrome browser for the rest of the run.`);
                this.useBrowserOnly = true;
                this.stats.switchedToBrowser = true;
            }
        }
        return fn(this.getBrowser());
    }

    // ── Search ────────────────────────────────────────────────────────────────────────────
    searchViaPage(transport, q, pageToken, label) {
        const url = buildSearchUrl(this.cfg.baseUrl, { ...this.params(), query: q, pageToken });
        return this.attempt(transport, label, { url }, (res) => {
            const r = parseSearchHtml(res.text, { nights: this.cfg.nights });
            const summary = `parser=${r.parserPath} blobs=[${r.blobKeys.join(',')}] hotels=${r.hotels.length} nextPage=${r.nextPageToken ? 'yes' : 'no'} total=${r.totalResults ?? '?'}`;
            if (r.hotels.length || r.locationRecognized === false) return { ok: true, value: { ...r, method: 'page', transport: transport.name }, summary };
            return { ok: false, retry: true, reason: `no hotel data in page (${summary})` };
        });
    }

    searchViaRpc(transport, q, pageToken, label) {
        const url = buildRpcUrl(this.cfg.baseUrl, this.params());
        const body = buildRpcBody(buildRpcInner({ ...this.params(), query: q, pageToken }));
        return this.attempt(transport, label, { url, method: 'POST', body, headers: this.rpcHeaders() }, (res) => {
            let tree;
            try {
                tree = decodeBatchExecute(res.text, RPC_ID);
            } catch (err) {
                if (err instanceof RpcDecodeError) return { ok: false, retry: true, reason: err.message };
                throw err;
            }
            const r = parseSearchPayload(tree, { nights: this.cfg.nights });
            const summary = `parser=rpc:${RPC_ID} hotels=${r.hotels.length} nextPage=${r.nextPageToken ? 'yes' : 'no'} total=${r.totalResults ?? '?'}`;
            if (r.hotels.length || r.locationRecognized === false) return { ok: true, value: { ...r, parserPath: `rpc:${RPC_ID}`, method: 'rpc', transport: transport.name }, summary };
            return { ok: false, retry: false, reason: `RPC answered but contained no hotels (${summary})` };
        });
    }

    /** One results page. method 'auto' = search page, then RPC, then (via withFallback) the browser. */
    async searchPage(q, { pageToken = null, pageNo = 1 } = {}) {
        const label = `search "${q.slice(0, 40)}" p${pageNo}`;
        // A method that had to be used as a fallback stays the first choice (the page cursor format differs too).
        const method = this.cfg.searchMethod === 'auto' ? (this.stickySearchMethod ?? (this.cfg.childrenAges.length ? 'rpc' : 'page')) : this.cfg.searchMethod;
        return this.withFallback(label, async (t) => {
            const first = method === 'rpc' ? this.searchViaRpc.bind(this) : this.searchViaPage.bind(this);
            const second = method === 'rpc' ? this.searchViaPage.bind(this) : this.searchViaRpc.bind(this);
            try {
                return await first(t, q, pageToken, `${label} ${method}/${t.name}`);
            } catch (err) {
                if (!(err instanceof BlockedError) || this.cfg.searchMethod !== 'auto') throw err;
                // The page cursor format differs between the two methods; only page 1 can switch.
                if (pageToken) throw err;
                const alt = method === 'rpc' ? 'page' : 'rpc';
                log.warning(`[${label}] ${method} method failed (${err.message}); trying the ${alt} method.`);
                const r = await second(t, q, pageToken, `${label} ${alt}/${t.name}`);
                this.stickySearchMethod = alt;
                log.info(`The ${alt} method works; using it for the rest of the run.`);
                return r;
            }
        });
    }

    // ── Hotel details and offers ─────────────────────────────────────────────────────────
    detailViaRpc(transport, entityId, query, label) {
        const url = buildRpcUrl(this.cfg.baseUrl, this.params());
        const body = buildRpcBody(buildRpcInner({ ...this.params(), query: query || 'hotels', entityId }));
        return this.attempt(transport, label, { url, method: 'POST', body, headers: this.rpcHeaders() }, (res) => {
            let tree;
            try {
                tree = decodeBatchExecute(res.text, RPC_ID);
            } catch (err) {
                if (err instanceof RpcDecodeError) return { ok: false, retry: true, reason: err.message };
                throw err;
            }
            const hotel = parseDetailPayload(tree, { nights: this.cfg.nights, entityId });
            if (!hotel) return { ok: false, retry: false, reason: 'RPC answered but contained no hotel' };
            return { ok: true, value: { hotel, parserPath: `rpc:${RPC_ID}` }, summary: `parser=rpc:${RPC_ID} offers=${hotel.offers.length}` };
        });
    }

    detailViaEntityPage(transport, entityId, query, label) {
        const url = buildHotelUrl({ ...this.params(), entityId, query }).replace('https://www.google.com', this.cfg.baseUrl);
        return this.attempt(transport, label, { url }, (res) => {
            const r = parseDetailHtml(res.text, { nights: this.cfg.nights, entityId });
            const summary = `parser=${r.parserPath} blobs=[${r.blobKeys.join(',')}] offers=${r.hotel?.offers.length ?? 0}`;
            if (r.hotel) return { ok: true, value: r, summary };
            return { ok: false, retry: true, reason: `no hotel data in entity page (${summary})` };
        });
    }

    /** Full hotel with per-provider offers. Tries the RPC, then the hotel's prices page. */
    async hotelDetail(entityId, query) {
        const label = `offers ${entityId.slice(0, 14)}…`;
        return this.withFallback(label, async (t) => {
            const paths = [['rpc', this.detailViaRpc.bind(this)], ['entity-page', this.detailViaEntityPage.bind(this)]];
            let lastErr;
            for (const [name, fn] of paths) {
                const key = `${t.name}:${name}`;
                // Skip a path that failed 3 times in a row and never worked in this run.
                if ((this.pathFailures.get(key) ?? 0) >= 3 && !this.pathSuccess.has(key)) continue;
                try {
                    const r = await fn(t, entityId, query, `${label} ${name}/${t.name}`);
                    this.pathFailures.set(key, 0);
                    this.pathSuccess.add(key);
                    return r;
                } catch (err) {
                    if (!(err instanceof BlockedError)) throw err;
                    this.pathFailures.set(key, (this.pathFailures.get(key) ?? 0) + 1);
                    lastErr = err;
                }
            }
            throw lastErr ?? new BlockedError('all detail methods are disabled after repeated failures');
        });
    }

    params() {
        const c = this.cfg;
        return { checkIn: c.checkIn, checkOut: c.checkOut, adults: c.adults, childrenAges: c.childrenAges, currency: c.currency, language: c.language, country: c.country };
    }

    rpcHeaders() {
        return { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1', origin: this.cfg.baseUrl, referer: `${this.cfg.baseUrl}/travel/search` };
    }
}
