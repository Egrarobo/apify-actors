// Google Trends client: polite throttling, retries with exponential backoff on 429 / captcha / network errors,
// a fresh session (new proxy IP + new NID cookie) on every retry, two ways to get widget tokens
// (/api/explore, then the embeddable-widget pages) and a real-browser fallback.
import { Actor, log } from 'apify';
import { HttpTransport, BrowserTransport } from './transport.js';
import {
    buildExploreReq, buildExploreUrl, buildEmbedUrl, buildWidgetDataUrl, buildWarmupUrl, buildRssUrl, buildTrendingRequest,
    widgetDataPath, TRENDING_RPC_ID, TRENDING_CATEGORIES,
} from './request.js';
import {
    classifyResponse, parseGoogleJson, parseExplore, selectWidgets, parseEmbedHtml, parseTimeline, parseGeo, parseRelated,
    parseTrendingRss, parseBatchExecute, parseTrendingRows, DecodeError,
} from './parse.js';

export class BlockedError extends Error {}
/** The widget token was refused (HTTP 401/400): a new explore request is needed. */
export class TokenError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF_MS = Number(process.env.GT_BACKOFF_MS ?? 2000);
const BACKOFF_CAP_MS = Number(process.env.GT_BACKOFF_CAP_MS ?? 30_000);
const MAX_DEBUG_PAGES = 5;
// With the browser fallback on, HTTP is abandoned after this many 429 / captcha answers in a row (each on a new IP).
// Before: up to 6 explore + 3 embed attempts with 2-30 s backoffs, i.e. ~70 s lost per run on datacenter IPs.
const HTTP_BLOCKS_BEFORE_BROWSER = Number(process.env.GT_HTTP_BLOCKS_BEFORE_BROWSER ?? 2);

export class TrendsClient {
    constructor(cfg, proxyConfiguration) {
        this.cfg = cfg;
        const opts = { proxyConfiguration, timeoutMs: cfg.requestTimeoutSecs * 1000, language: cfg.language, baseUrl: cfg.baseUrl, geo: cfg.geo };
        this.http = new HttpTransport(opts);
        this.browserOpts = opts;
        this.browser = null;
        this.useBrowserOnly = cfg.useBrowser === 'always';
        this.stats = {
            requests: 0, ok: 0, retries: 0, rateLimited: 0, captchaPages: 0, consentPages: 0, httpErrors: 0, networkErrors: 0, badData: 0,
            tokenRefused: 0, sessionsCreated: 0, warmups: 0, browserRequests: 0, secondPasses: 0, switchedToBrowser: false, tokenSource: null, byEndpoint: {},
        };
        this.debugSaved = 0;
        this.lastRequestAt = 0;
        this.tokenPath = null; // 'explore' | 'embed' once one worked (sticky)
        this.warmedSession = null;
        this.httpBlockStreak = 0; // consecutive 429 / captcha answers over HTTP
        this.httpGivenUp = false; // HTTP is rate-limited: go straight to the browser
    }

    /** Counts a 429 / captcha over HTTP; true when HTTP should be abandoned for the browser. */
    noteHttpBlocked(transport) {
        if (transport.name !== 'http' || this.cfg.useBrowser !== 'fallback') return false;
        this.httpBlockStreak++;
        if (this.httpBlockStreak >= HTTP_BLOCKS_BEFORE_BROWSER) this.httpGivenUp = true;
        return this.httpGivenUp;
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

    /** Keeps at least `requestDelayMs` (±25% jitter) between two requests to Google. */
    async throttle() {
        const gap = this.cfg.requestDelayMs * (0.75 + Math.random() * 0.5);
        const wait = this.lastRequestAt + gap - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastRequestAt = Date.now();
    }

    /** First request of an HTTP session: a Trends page that sets the NID cookie (like pytrends). Failures are only logged. */
    async warmup(transport) {
        if (transport.name !== 'http' || this.warmedSession === transport.sessionId) return;
        this.warmedSession = transport.sessionId;
        const url = buildWarmupUrl(this.cfg.baseUrl, { geo: this.cfg.geo, hl: this.cfg.language });
        await this.throttle();
        this.stats.requests++;
        this.stats.warmups++;
        const t0 = Date.now();
        try {
            const res = await transport.request({ url, headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
            const cls = classifyResponse(res);
            const note = cls.captcha || cls.consent || cls.rateLimited ? ` (${cls.kind})` : '';
            log.info(`[warmup] ${transport.describe()}: status=${res.status} ${Date.now() - t0}ms NID cookie=${transport.hasNid ? 'yes' : 'no'}${note}`);
            if (cls.captcha || cls.rateLimited) throw new BlockedError(cls.captcha ? 'captcha page on the first request' : 'HTTP 429 on the first request');
        } catch (err) {
            if (err instanceof BlockedError) throw err;
            log.warning(`[warmup] ${transport.describe()}: ${err.message.split('\n')[0]} (continuing without the NID cookie)`);
        }
    }

    /**
     * Sends a request with retries. `interpret(res)` returns { ok: true, value, summary } or { ok: false, retry, reason }.
     * Every retry uses a new session (new proxy IP and cookies) after an exponential backoff.
     */
    async attempt(transport, label, req, interpret, { maxRetries = this.cfg.maxRetries } = {}) {
        const maxAttempts = maxRetries + 1;
        let lastReason = 'no attempt';
        let retryAfterMs = 0;
        for (let i = 1; i <= maxAttempts; i++) {
            if (transport.name === 'http' && this.httpGivenUp) {
                throw new BlockedError(`${lastReason === 'no attempt' ? 'HTTP 429 Too Many Requests (Google rate limit)' : lastReason}; `
                    + `HTTP was rate-limited ${this.httpBlockStreak} times in a row, not retrying it`);
            }
            if (i > 1) {
                this.stats.retries++;
                const backoff = Math.min(BACKOFF_MS * 2 ** (i - 2), BACKOFF_CAP_MS) * (0.75 + Math.random() * 0.5);
                const wait = Math.max(backoff, Math.min(retryAfterMs, BACKOFF_CAP_MS * 2));
                log.info(`[${label}] waiting ${(wait / 1000).toFixed(1)}s, then retrying with a new session (new IP and cookies).`);
                await sleep(wait);
                await transport.newSession();
                this.stats.sessionsCreated++;
            }
            let res;
            const t0 = Date.now();
            try {
                if (!transport.sessionId) {
                    await transport.newSession();
                    this.stats.sessionsCreated++;
                }
                await this.warmup(transport);
                await this.throttle();
                this.stats.requests++;
                if (transport.name === 'browser') this.stats.browserRequests++;
                res = await transport.request(req);
            } catch (err) {
                if (err instanceof BlockedError) {
                    this.stats.rateLimited++;
                    lastReason = err.message;
                    this.noteHttpBlocked(transport);
                } else {
                    this.stats.networkErrors++;
                    lastReason = `network error: ${err.message.split('\n')[0]}`;
                }
                log.warning(`[${label}] attempt ${i}/${maxAttempts} via ${transport.describe()}: ${lastReason}`);
                continue;
            }
            const ms = Date.now() - t0;
            const ep = new URL(req.url).pathname.replace(/^\/trends\/api\/widgetdata\//, '').replace(/^\/trends\/api\//, '');
            const cls = classifyResponse(res);
            let out = { ok: false, retry: true, reason: 'not parsed' };
            if (res.status === 200 && cls.kind === 'ok') {
                try {
                    out = interpret(res);
                } catch (err) {
                    out = { ok: false, retry: !(err instanceof DecodeError) || /HTML instead of JSON|empty/.test(err.message), reason: `parser: ${err.message}` };
                }
            }
            const diag = `status=${res.status} ${ms}ms bytes=${res.text.length} consent=${cls.consent ? 'YES' : 'no'} captcha=${cls.captcha ? 'YES' : 'no'}`
                + `${res.url && res.url !== req.url ? ` finalUrl=${res.url.slice(0, 90)}` : ''}`;
            const epStats = (this.stats.byEndpoint[ep] ??= { requests: 0, ok: 0, rateLimited: 0 });
            epStats.requests++;
            if (out.ok) {
                if (transport.name === 'http') this.httpBlockStreak = 0;
                this.stats.ok++;
                epStats.ok++;
                log.info(`[${label}] attempt ${i}/${maxAttempts} via ${transport.name}: ${diag} → ${out.summary ?? 'ok'}`);
                return out.value;
            }
            if (cls.captcha) this.stats.captchaPages++;
            else if (cls.consent) this.stats.consentPages++;
            else if (cls.rateLimited) {
                this.stats.rateLimited++;
                epStats.rateLimited++;
            } else if (cls.kind !== 'ok') this.stats.httpErrors++;
            else this.stats.badData++;
            const ra = Number(res.headers?.['retry-after']);
            retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0;
            lastReason = cls.captcha ? 'captcha / "unusual traffic" page' : cls.consent ? 'cookie consent page'
                : cls.rateLimited ? 'HTTP 429 Too Many Requests (Google rate limit)' : cls.kind !== 'ok' ? `HTTP ${res.status}` : out.reason;
            log.warning(`[${label}] attempt ${i}/${maxAttempts} via ${transport.describe()}: ${diag} → ${lastReason}`);
            if (i === 1 || i === maxAttempts) await this.saveDebug(label, res);
            if ((cls.captcha || cls.rateLimited) && this.noteHttpBlocked(transport)) {
                throw new BlockedError(`${lastReason}; HTTP was rate-limited ${this.httpBlockStreak} times in a row, not retrying it`);
            }
            // A refused widget token needs a new explore request, not the same request again.
            if (req.isWidgetData && (res.status === 401 || res.status === 400)) {
                this.stats.tokenRefused++;
                throw new TokenError(`widget token refused (HTTP ${res.status})`);
            }
            if (cls.kind === 'http-error' && res.status < 500 && res.status !== 408) break;
            if (cls.kind === 'ok' && out.retry === false) break;
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

    common() {
        return { hl: this.cfg.language, tz: this.cfg.tz };
    }

    headersFor(kind) {
        const referer = `${this.cfg.baseUrl}/trends/explore`;
        if (kind === 'html') return { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', referer };
        return { accept: 'application/json, text/plain, */*', referer };
    }

    // ── widget tokens ─────────────────────────────────────────────────────────────────────

    async exploreViaApi(t, terms, label) {
        try {
            return await this.exploreViaApiOnce(t, terms, label, this.exploreMethod ?? 'GET');
        } catch (err) {
            // trendsearch (2026) sends GET, pytrends sends POST with the same query string: switch if one is refused.
            if (!(err instanceof BlockedError) || !/HTTP (405|404)/.test(err.message)) throw err;
            const other = (this.exploreMethod ?? 'GET') === 'GET' ? 'POST' : 'GET';
            log.warning(`[${label}] explore via ${this.exploreMethod ?? 'GET'} answered ${err.message}; trying ${other}.`);
            const r = await this.exploreViaApiOnce(t, terms, label, other);
            this.exploreMethod = other;
            return r;
        }
    }

    exploreViaApiOnce(t, terms, label, method) {
        const req = buildExploreReq({ terms, geo: this.cfg.geo, time: this.cfg.time, category: this.cfg.category, gprop: this.cfg.gprop });
        const url = buildExploreUrl(this.cfg.baseUrl, { ...this.common(), req });
        return this.attempt(t, `${label} explore${method === 'POST' ? ':post' : ''}/${t.name}`, { url, method, headers: this.headersFor('json') }, (res) => {
            const widgets = parseExplore(parseGoogleJson(res.text));
            const sel = selectWidgets(widgets, terms);
            const userType = sel.timeseries?.request?.userConfig?.userType;
            const summary = `parser=explore widgets=[${widgets.map((w) => w.id).join(',')}]${userType ? ` userType=${userType}` : ''}`;
            if (!sel.timeseries && !sel.geo.size && !sel.relatedQueries.size) return { ok: false, retry: true, reason: `explore answered without usable widgets (${summary})` };
            return { ok: true, value: { widgets: sel, source: `explore/${t.name}` }, summary };
        });
    }

    /** Fallback token source: one embeddable-widget page per widget (trendspy). */
    async exploreViaEmbed(t, terms, label, need) {
        const sel = { timeseries: null, comparedGeo: null, geo: new Map(), relatedQueries: new Map(), relatedTopics: new Map() };
        const one = async (widgetId, forTerms) => {
            const req = buildExploreReq({ terms: forTerms, geo: this.cfg.geo, time: this.cfg.time, category: this.cfg.category, gprop: this.cfg.gprop });
            const url = buildEmbedUrl(this.cfg.baseUrl, widgetId, { ...this.common(), req });
            return this.attempt(t, `${label} embed:${widgetId}${forTerms.length === 1 && terms.length > 1 ? ` "${forTerms[0]}"` : ''}/${t.name}`, { url, headers: this.headersFor('html') }, (res) => {
                const w = parseEmbedHtml(res.text);
                const userType = w.request?.userConfig?.userType ?? '';
                if (/OVER_QUOTA/.test(userType)) return { ok: false, retry: true, reason: `embed widget over quota (${userType})` };
                return { ok: true, value: { ...w, id: w.id ?? widgetId }, summary: `parser=embed widget=${w.id ?? widgetId} type=${w.type ?? '?'}${userType ? ` userType=${userType}` : ''}` };
            }, { maxRetries: Math.max(1, Math.floor(this.cfg.maxRetries / 2)) });
        };
        if (need.timeline) sel.timeseries = await one('TIMESERIES', terms);
        for (const term of terms) {
            if (need.region) sel.geo.set(term, await one('GEO_MAP', [term]));
            if (need.queries) sel.relatedQueries.set(term, await one('RELATED_QUERIES', [term]));
            if (need.topics) sel.relatedTopics.set(term, await one('RELATED_TOPICS', [term]));
        }
        return { widgets: sel, source: `embed/${t.name}` };
    }

    /** Widget tokens for a group of terms: /api/explore first, the embed pages when explore is blocked. */
    async getWidgets(terms, label, need) {
        return this.withFallback(label, async (t) => {
            const order = this.tokenPath === 'embed' ? ['embed', 'explore'] : ['explore', 'embed'];
            let lastErr;
            for (const path of order) {
                if (path === 'embed' && !this.cfg.useEmbedFallback) continue;
                if (path === 'embed' && t.name === 'http' && this.httpGivenUp) continue; // straight to the browser
                try {
                    const r = path === 'explore' ? await this.exploreViaApi(t, terms, label) : await this.exploreViaEmbed(t, terms, label, need);
                    if (this.tokenPath !== path) {
                        if (this.tokenPath) log.info(`Widget tokens now come from the ${path} endpoint (the ${this.tokenPath} endpoint failed).`);
                        this.tokenPath = path;
                        this.stats.tokenSource = path;
                    }
                    return r;
                } catch (err) {
                    if (!(err instanceof BlockedError)) throw err;
                    lastErr = err;
                    if (path === 'explore' && this.cfg.useEmbedFallback && !(t.name === 'http' && this.httpGivenUp)) log.warning(`[${label}] explore failed (${err.message}); trying the embeddable widget pages.`);
                }
            }
            throw lastErr;
        });
    }

    // ── widget data ───────────────────────────────────────────────────────────────────────

    widgetData(t, widget, label, interpret, requestOverride) {
        const url = buildWidgetDataUrl(this.cfg.baseUrl, widget, { ...this.common(), request: requestOverride ?? widget.request });
        return this.attempt(t, `${label}/${t.name}`, { url, headers: this.headersFor('json'), isWidgetData: true }, (res) => {
            const json = parseGoogleJson(res.text);
            return interpret(json);
        });
    }

    fetchTimeline(t, widget, count, label) {
        const resolution = widget.request?.resolution ?? '';
        return this.widgetData(t, widget, `${label} multiline`, (json) => {
            const r = parseTimeline(json, count, { resolution });
            const partial = r.series[0]?.filter((p) => p.isPartial).length ?? 0;
            return { ok: true, value: { ...r, resolution, timeResolved: widget.request?.time ?? null }, summary: `parser=multiline points=${r.series[0]?.length ?? 0} series=${count} resolution=${resolution || '?'} partial=${partial}` };
        });
    }

    fetchRegions(t, widget, label) {
        const request = { ...widget.request };
        const resolution = this.cfg.regionResolution || (this.cfg.geo ? 'REGION' : 'COUNTRY');
        request.resolution = resolution;
        request.includeLowSearchVolumeGeos = this.cfg.includeLowSearchVolumeRegions;
        return this.widgetData(t, widget, `${label} comparedgeo`, (json) => {
            const regions = parseGeo(json, { idx: 0 });
            return { ok: true, value: { regions, resolution }, summary: `parser=comparedgeo resolution=${resolution} regions=${regions.length}` };
        }, request);
    }

    fetchRelated(t, widget, label, topics) {
        return this.widgetData(t, widget, `${label} relatedsearches:${topics ? 'topics' : 'queries'}`, (json) => {
            const r = parseRelated(json, { topics });
            return { ok: true, value: r, summary: `parser=relatedsearches ${topics ? 'topics' : 'queries'} top=${r.top.length} rising=${r.rising.length}` };
        });
    }

    /**
     * Everything requested for one comparison group. Returns per-term results and per-term errors;
     * a part that fails does not stop the other parts. Tokens are refreshed when Google refuses them.
     */
    async runGroup(terms, label) {
        const need = {
            timeline: this.cfg.interestOverTime,
            region: this.cfg.interestByRegion,
            queries: this.cfg.relatedQueries,
            topics: this.cfg.relatedTopics,
        };
        const res = { terms: new Map(terms.map((x) => [x, { errors: [] }])), timeline: null, tokenSource: null, groupError: null };
        let widgets;
        const refresh = async () => {
            const r = await this.getWidgets(terms, label, need);
            widgets = r.widgets;
            res.tokenSource = r.source;
        };
        try {
            await refresh();
        } catch (err) {
            if (!(err instanceof BlockedError)) throw err;
            res.groupError = `Google Trends refused the comparison: ${err.message}`;
            for (const v of res.terms.values()) v.errors.push(res.groupError);
            return res;
        }

        /** Runs one widget request; on a refused token, fetches fresh tokens once and retries. */
        const run = async (what, pick, fetcher, onErr) => {
            for (let round = 0; round < 2; round++) {
                const w = pick();
                if (!w) {
                    onErr(`${what}: Google did not return this widget`);
                    return null;
                }
                try {
                    return await this.withFallback(label, (t) => fetcher(t, w));
                } catch (err) {
                    if (err instanceof TokenError && round === 0) {
                        log.warning(`[${label}] ${what}: ${err.message}; requesting fresh tokens.`);
                        try {
                            await refresh();
                        } catch (e) {
                            if (!(e instanceof BlockedError)) throw e;
                            onErr(`${what}: ${e.message}`);
                            return null;
                        }
                        continue;
                    }
                    if (!(err instanceof BlockedError) && !(err instanceof TokenError)) throw err;
                    onErr(`${what}: ${err.message}`);
                    return null;
                }
            }
            return null;
        };

        /** One pass over the parts still missing; returns the errors of this pass per term. */
        const collect = async () => {
            const errs = new Map(terms.map((x) => [x, []]));
            if (need.timeline && !res.timeline) {
                res.timeline = await run('interest over time', () => widgets.timeseries, (t, w) => this.fetchTimeline(t, w, terms.length, label),
                    (e) => { for (const v of errs.values()) v.push(e); });
            }
            for (const term of terms) {
                const slot = res.terms.get(term);
                const err = errs.get(term);
                const tl = `${label} "${term.slice(0, 30)}"`;
                if (need.region && !slot.region) slot.region = await run('interest by region', () => widgets.geo.get(term), (t, w) => this.fetchRegions(t, w, tl), (e) => err.push(e));
                if (need.queries && !slot.queries) slot.queries = await run('related queries', () => widgets.relatedQueries.get(term), (t, w) => this.fetchRelated(t, w, tl, false), (e) => err.push(e));
                if (need.topics && !slot.topics) {
                    // A multi-term explore has no RELATED_TOPICS widgets: those need a single-term explore.
                    if (!widgets.relatedTopics.get(term) && terms.length > 1) {
                        try {
                            const single = await this.getWidgets([term], `${tl} single`, { topics: true });
                            const w = single.widgets.relatedTopics.get(term);
                            if (w) widgets.relatedTopics.set(term, w);
                        } catch (e) {
                            if (!(e instanceof BlockedError)) throw e;
                            err.push(`related topics: ${e.message}`);
                            continue;
                        }
                    }
                    slot.topics = await run('related topics', () => widgets.relatedTopics.get(term), (t, w) => this.fetchRelated(t, w, tl, true), (e) => err.push(e));
                }
            }
            return errs;
        };

        let errs = await collect();
        const missing = () => [...errs.values()].reduce((n, e) => n + e.length, 0);
        if (missing()) {
            // Second chance for what failed: fresh tokens (tokens are bound to the session that got them), then only the missing parts.
            // An incomplete term is stored free, so without this pass a short Google hiccup costs us the whole term.
            log.warning(`[${label}] ${missing()} part(s) failed (${[...new Set([...errs.values()].flat())].join('; ').slice(0, 300)}); `
                + 'trying the missing parts once more with fresh tokens.');
            this.stats.secondPasses++;
            try {
                await refresh();
                errs = await collect();
            } catch (err) {
                if (!(err instanceof BlockedError)) throw err;
                log.warning(`[${label}] second pass: fresh tokens refused (${err.message}).`);
            }
            if (!missing()) log.info(`[${label}] second pass: all missing parts recovered.`);
        }
        for (const [term, e] of errs) res.terms.get(term).errors.push(...e);
        return res;
    }

    // ── Trending now ──────────────────────────────────────────────────────────────────────

    trendingRss(geo) {
        const url = buildRssUrl(this.cfg.baseUrl, { geo });
        return this.withFallback(`trending rss ${geo}`, (t) => this.attempt(t, `trending rss ${geo}/${t.name}`, { url, headers: { accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' } }, (res) => {
            const items = parseTrendingRss(res.text);
            return { ok: true, value: items, summary: `parser=rss items=${items.length} withNews=${items.filter((i) => i.news.length).length}` };
        }));
    }

    trendingPage(geo, hours) {
        const { url, body } = buildTrendingRequest(this.cfg.baseUrl, { geo, hl: this.cfg.language, hours });
        const headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', origin: this.cfg.baseUrl, referer: `${this.cfg.baseUrl}/trending?geo=${geo}` };
        return this.withFallback(`trending page ${geo}`, (t) => this.attempt(t, `trending batchexecute:${TRENDING_RPC_ID} ${geo}/${t.name}`, { url, method: 'POST', body, headers }, (res) => {
            const rows = parseTrendingRows(parseBatchExecute(res.text, TRENDING_RPC_ID), TRENDING_CATEGORIES);
            return { ok: true, value: rows, summary: `parser=batchexecute:${TRENDING_RPC_ID} rows=${rows.length}` };
        }));
    }
}

export { widgetDataPath };
