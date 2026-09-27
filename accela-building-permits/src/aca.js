import { log } from 'apify';
import { HttpTransport, BrowserTransport, lookupExitIp } from './transport.js';
import {
    parseSearchForm, parseResults, parseDetail, serializeForm, setField, encodeForm, isDetailPage, csvToRows, findExportUrl,
    findBlockMarkers, isMaintenancePage, acaErrorMessage, isLoginPage, pageTitle, clean,
} from './parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AcaError extends Error {
    constructor(message, { kind = 'error', fatal = false, ...info } = {}) {
        super(message);
        this.name = 'AcaError';
        this.kind = kind; // blocked | not-found | module | captcha | login | maintenance | session | http | network
        this.fatal = fatal; // true = retrying cannot help (wrong agency/module, CAPTCHA, login)
        Object.assign(this, info);
    }
}

const STRATEGY_LABEL = { http: 'plain HTTP', 'browser-cookies': 'HTTP with cookies from a real browser', browser: 'a real browser' };

/** "2026-09-27" → "09/27/2026" (ACA's date format). */
export const acaDate = (isoDay) => {
    const [y, m, d] = String(isoDay).slice(0, 10).split('-');
    return `${m}/${d}/${y}`;
};

/**
 * One ACA agency + module. Keeps one session (cookies + current page's ViewState) and escalates from plain HTTP
 * to a real browser when the portal blocks plain requests.
 */
export class AcaClient {
    constructor({
        agency, module, proxyConfiguration = null, browserFallback = true, requestDelayMs = 500, maxRetries = 3,
        backoffMs = 1500, saveDebug = null, forceBrowser = false,
    }) {
        this.agency = agency;
        this.module = module;
        this.label = agency.code;
        this.proxyConfiguration = proxyConfiguration;
        this.browserFallback = browserFallback;
        this.requestDelayMs = requestDelayMs;
        this.maxRetries = maxRetries;
        this.backoffMs = backoffMs;
        this.saveDebugFn = saveDebug;
        this.strategy = forceBrowser ? 'browser' : 'http';
        this.transport = null;
        this.browser = null;
        this.form = null; // parsed search form
        this.searchHtml = null;
        this.searchUrl = `${agency.baseUrl}/Cap/CapHome.aspx?module=${encodeURIComponent(module)}&TabName=${encodeURIComponent(module)}`;
        this.current = null; // { html, url } of the last page (for postbacks)
        this.sessionNo = 0;
        this.blocks = 0;
        this.nextRequestAt = 0;
        this.debugSaved = 0;
        this.stats = { requests: 0, retries: 0, blocks: 0, sessions: 0, strategy: this.strategy, csvExports: 0, csvFailures: 0, pages: 0, detailPages: 0 };
    }

    tag(step) {
        return `[${this.label}]${step ? ` ${step}:` : ''}`;
    }

    async saveDebug(kind, content, contentType = 'text/html; charset=utf-8') {
        if (!this.saveDebugFn || this.debugSaved >= 6 || !content) return null;
        this.debugSaved++;
        const key = `DEBUG-${this.label.replace(/[^a-zA-Z0-9-]/g, '-')}-${kind}-${this.debugSaved}`;
        try {
            await this.saveDebugFn(key, content, contentType);
            return key;
        } catch {
            return null;
        }
    }

    async close() {
        const b = this.browser;
        this.browser = null;
        this.transport = null;
        if (b) await b.close();
    }

    async throttle() {
        const now = Date.now();
        const wait = Math.max(0, this.nextRequestAt - now);
        this.nextRequestAt = Math.max(now, this.nextRequestAt) + this.requestDelayMs * (0.7 + Math.random() * 0.6);
        if (wait) await sleep(wait);
    }

    backoff(attempt) {
        return Math.min(30_000, this.backoffMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    }

    /** Opens a new session (new proxy IP, new cookies) with the current strategy and loads the search page. */
    async startSession(reason) {
        await this.close();
        this.sessionNo++;
        this.stats.sessions++;
        this.stats.strategy = this.strategy;
        const proxyUrl = this.proxyConfiguration ? await this.proxyConfiguration.newUrl(`aca${this.label.replace(/[^a-zA-Z0-9]/g, '')}${Date.now().toString(36)}`) : null;
        const ip = proxyUrl && this.sessionNo <= 3 ? await lookupExitIp(proxyUrl) : null;
        const proxyInfo = proxyUrl ? `proxy${ip ? ` exit IP ${ip}` : ''}` : 'no proxy';
        log.info(`${this.tag()} Session #${this.sessionNo}: ${STRATEGY_LABEL[this.strategy]}, ${proxyInfo}${reason ? ` (because ${reason})` : ''}. Opening ${this.searchUrl}`);
        if (this.strategy === 'http') {
            this.transport = new HttpTransport({ proxyUrl });
        } else {
            const b = new BrowserTransport({ proxyUrl });
            this.browser = b;
            try {
                await b.open();
            } catch (err) {
                this.browser = null;
                throw new AcaError(`${this.lastBlock ? `the portal blocks plain HTTP (${this.lastBlock}) and ` : ''}the browser fallback could not start: ${err.message}`, { kind: 'browser', fatal: true });
            }
            if (this.strategy === 'browser-cookies') {
                const res = await b.request({ url: this.searchUrl });
                this.stats.requests++;
                this.checkResponse(res, 'open search page (browser)');
                const t = new HttpTransport({ proxyUrl, userAgent: b.userAgent });
                t.jar.setFromList(await b.cookies());
                this.transport = t;
                log.info(`${this.tag()} Browser passed the portal (${res.status}, "${pageTitle(res.text)}"); continuing over HTTP with its cookies (${t.jar.names().join(', ') || 'none'}).`);
            } else {
                this.transport = b;
            }
        }
        const started = Date.now();
        const res = await this.rawRequest({ url: this.searchUrl, step: 'open search page' });
        this.acceptSearchPage(res);
        log.info(`${this.tag()} Search page loaded (HTTP ${res.status}, "${pageTitle(res.text)}", ${Date.now() - started} ms). Date fields: ${this.form.startName.split('$').pop()} / ${this.form.endName.split('$').pop()}`
            + `${this.form.typeName ? `, ${this.form.recordTypes.length} record types in the dropdown` : ', no record-type dropdown'}${this.form.captcha ? ', CAPTCHA present' : ''}.`);
    }

    acceptSearchPage(res) {
        const form = parseSearchForm(res.text);
        if (!form.ok) {
            if (isLoginPage(res.text, res.finalUrl)) {
                throw new AcaError(`the ${this.module} module of ${this.label} asks for a login (redirected to ${res.finalUrl}); only public search pages are supported.`, { kind: 'login', fatal: true });
            }
            const acaErr = acaErrorMessage(res.text);
            const isAca = /Accela Citizen Access|aspnetForm|ACA_/i.test(res.text);
            if (!isAca || res.status === 404) {
                throw new AcaError(`"${this.label}" does not look like an Accela Citizen Access agency (HTTP ${res.status} at ${res.finalUrl}, page "${pageTitle(res.text) || 'no title'}"). `
                    + 'Check the agency code: it is the part after aca-prod.accela.com/ in the portal address (e.g. TAMPA), or paste the full portal URL.', { kind: 'not-found', fatal: true, status: res.status });
            }
            const mods = form.modules.filter((m) => m.toLowerCase() !== String(this.module).toLowerCase());
            throw new AcaError(`the ${this.module} module of ${this.label} has no public date search${acaErr ? ` (portal says: "${acaErr}")` : ''}. `
                + `${mods.length ? `Modules linked on this portal: ${mods.join(', ')}. Set "module" to one of them.` : 'Check the module name in the portal address (…/CapHome.aspx?module=…).'}`, { kind: 'module', fatal: true, modules: form.modules });
        }
        if (form.captcha) {
            throw new AcaError(`the ${this.module} search of ${this.label} requires a CAPTCHA for anonymous users, which this Actor does not solve.`, { kind: 'captcha', fatal: true });
        }
        this.form = form;
        this.searchHtml = res.text;
        this.searchPageUrl = res.finalUrl;
        this.current = { html: res.text, url: res.finalUrl };
    }

    /** Throws AcaError for blocks, maintenance and HTTP errors. */
    checkResponse(res, step) {
        const markers = findBlockMarkers(res.text);
        if (res.status === 403 || res.status === 429 || res.status === 401 || markers.length) {
            throw new AcaError(`${step}: HTTP ${res.status}${markers.length ? `, ${markers.join(', ')}` : `, page "${pageTitle(res.text)}"`}`, { kind: 'blocked', status: res.status, markers, html: res.text });
        }
        if (isMaintenancePage(res.text)) {
            throw new AcaError(`${step}: the portal shows a maintenance page ("${pageTitle(res.text)}"). Try again later.`, { kind: 'maintenance', fatal: true, html: res.text });
        }
        if (res.status >= 500 || res.status === 0) throw new AcaError(`${step}: HTTP ${res.status}`, { kind: 'http', status: res.status, html: res.text });
        if (res.status === 404) return res; // handled by the caller
        if (res.status >= 400) throw new AcaError(`${step}: HTTP ${res.status}`, { kind: 'http', fatal: true, status: res.status, html: res.text });
        return res;
    }

    /** One request with throttling and network/5xx retries on the same session. */
    async rawRequest({ url, method = 'GET', body = null, step }) {
        let last = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            if (attempt > 0) {
                this.stats.retries++;
                await sleep(this.backoff(attempt - 1));
            }
            await this.throttle();
            this.stats.requests++;
            let res;
            try {
                res = await this.transport.request({ url, method, body, referer: this.current?.url ?? null });
            } catch (err) {
                last = new AcaError(`${step}: ${err.code ?? ''} ${String(err.message).split('\n')[0]}`.replace(/\s+/g, ' '), { kind: 'network' });
                log.debug(`${this.tag(step)} attempt ${attempt + 1} failed: ${last.message}`);
                continue;
            }
            try {
                return this.checkResponse(res, step);
            } catch (err) {
                if (err.kind === 'http' && !err.fatal) {
                    last = err;
                    continue;
                }
                throw err;
            }
        }
        throw last;
    }

    /** Switches strategy after a block: new IP first, then a real browser. */
    escalate(err) {
        this.lastBlock = err.message.replace(/ — page saved.*$/, '');
        this.blocks++;
        this.stats.blocks++;
        if (this.browserFallback && this.strategy === 'http' && this.blocks >= 2) this.strategy = 'browser-cookies';
        else if (this.browserFallback && this.strategy === 'browser-cookies' && this.blocks >= 3) this.strategy = 'browser';
        log.warning(`${this.tag()} Blocked (${err.message}). Next attempt: ${STRATEGY_LABEL[this.strategy]} on a new IP.`);
    }

    /**
     * Runs fn() with a working session; on blocks / broken sessions it starts a new one and runs fn() again.
     * fn must be safe to repeat (callers de-duplicate records by number).
     */
    async withSession(step, fn) {
        let last = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (!this.form) await this.startSession(last ? last.message : null);
                return await fn();
            } catch (err) {
                if (!(err instanceof AcaError)) throw err;
                if (err.html) {
                    const key = await this.saveDebug(err.kind, err.html);
                    if (key) err.message += ` — page saved to the key-value store as ${key}`;
                }
                if (err.fatal) throw err;
                last = err;
                this.form = null;
                if (err.kind === 'blocked') this.escalate(err);
                else log.warning(`${this.tag(step)} ${err.message}. Retrying with a new session.`);
                if (attempt < this.maxRetries) await sleep(this.backoff(attempt));
            }
        }
        const hint = last?.kind === 'blocked'
            ? (this.proxyConfiguration ? ' The portal keeps refusing these IPs; try RESIDENTIAL proxies (proxy group "RESIDENTIAL", country US).' : ' Enable Apify Proxy (ideally RESIDENTIAL, country US).')
            : '';
        throw new AcaError(`${step}: gave up after ${this.maxRetries + 1} sessions. Last error: ${last?.message ?? 'unknown'}.${hint}`, { kind: last?.kind ?? 'error' });
    }

    /** Posts the current page's form with __EVENTTARGET = target (and optional field overrides). */
    async postBack(target, overrides = {}, step = 'postback', argument = '') {
        const { action, fields: f0 } = serializeForm(this.current.html, this.current.url);
        let fields = setField(f0, '__EVENTTARGET', target);
        fields = setField(fields, '__EVENTARGUMENT', argument ?? '');
        for (const [k, v] of Object.entries(overrides)) fields = setField(fields, k, v);
        const res = await this.rawRequest({ url: action, method: 'POST', body: encodeForm(fields), step });
        return res;
    }

    /** Checks a postback answer for ACA's error page (expired session / invalid ViewState). */
    checkAcaPage(res, step) {
        if (isLoginPage(res.text, res.finalUrl)) throw new AcaError(`${step}: the portal redirected to its login page`, { kind: 'login', fatal: true });
        const err = acaErrorMessage(res.text);
        if (err) throw new AcaError(`${step}: the portal answered "${err}"`, { kind: 'session', html: res.text });
        if (res.status === 404) throw new AcaError(`${step}: HTTP 404 at ${res.finalUrl}`, { kind: 'session', html: res.text });
    }

    /**
     * Searches one date window. Calls onPage({ rows, pageNo, countText, source }) for every results page; onPage
     * returns false to stop paging. Returns { pages, rows, exportUsed, single }.
     * exportMode: 'grid' | 'csv' | 'auto' (csv tried when the grid has more than one page and `wantCsv`).
     */
    async searchWindow({ from, to, recordType = null, maxPages = 100, exportMode = 'grid', wantCsv = false, onPage }) {
        const label = `${from}…${to}${recordType ? ` [${recordType.text}]` : ''}`;
        return this.withSession(`search ${label}`, async () => {
            // Every attempt starts from a fresh search page (the ViewState of a failed session is useless).
            this.current = { html: this.searchHtml, url: this.searchPageUrl ?? this.searchUrl };
            const overrides = {
                [this.form.startName]: acaDate(from),
                [this.form.endName]: acaDate(to),
            };
            if (recordType && this.form.typeName) overrides[this.form.typeName] = recordType.value;
            const res = await this.postBack(this.form.searchTarget, overrides, `search ${label}`);
            this.checkAcaPage(res, `search ${label}`);
            this.current = { html: res.text, url: res.finalUrl };
            if (isDetailPage(res.text)) {
                // ACA opens the record directly when exactly one record matches.
                const d = parseDetail(res.text, res.finalUrl);
                this.stats.pages++;
                const row = { byKey: { recordNumber: d.recordNumber, recordType: d.recordType, status: d.status, address: d.address, description: d.description }, detailHref: res.finalUrl, detail: d };
                await onPage({ rows: [row], pageNo: 1, countText: '1 record (opened directly)', source: 'detail' });
                return { pages: 1, rows: 1, single: true };
            }
            let page = parseResults(res.text, res.finalUrl);
            if (!page.grid) {
                if (page.noResults) return { pages: 0, rows: 0 };
                const key = await this.saveDebug('no-grid', res.text);
                if (page.message) {
                    throw new AcaError(`search ${label}: no results grid; the portal says "${page.message}"${key ? ` — page saved as ${key}` : ''}. `
                        + 'If it complains about too many results, lower "searchWindowDays" (e.g. 1) or use "recordTypes".', { kind: 'search', fatal: true });
                }
                log.warning(`${this.tag()} Search ${label}: no results grid and no "no results" message (page "${pageTitle(res.text)}")${key ? ` — page saved as ${key}` : ''}. Treating as 0 results.`);
                return { pages: 0, rows: 0 };
            }
            if (page.message) log.info(`${this.tag()} Portal message for ${label}: "${page.message}"`);

            // CSV export: one request instead of one per 10 rows. Only when the grid has more pages.
            // "auto": only for big result sets (> 100 records = more than 10 grid requests), since CSV rows have no links.
            const resultCount = Number(String(page.countText ?? '').match(/of\s+([\d,]+)/i)?.[1]?.replace(/,/g, '')) || null;
            const big = resultCount !== null && (resultCount > 100 || /\+$/.test(page.countText));
            const tryCsv = page.exportTarget && page.nextTarget && (exportMode === 'csv' || (exportMode === 'auto' && wantCsv && big));
            if (exportMode === 'csv' && !page.exportTarget && page.nextTarget) log.info(`${this.tag()} No "Download results" link on this portal; reading the grid page by page.`);
            if (tryCsv) {
                const csvRows = await this.exportCsv(page.exportTarget, label);
                if (csvRows) {
                    this.stats.pages++;
                    await onPage({ rows: csvRows, pageNo: 1, countText: page.countText, source: 'csv' });
                    return { pages: 1, rows: csvRows.length, exportUsed: true };
                }
                // Export failed: go on with the grid (restore page 1 of the results).
                this.current = { html: res.text, url: res.finalUrl };
            }

            let pageNo = 1;
            let total = 0;
            for (;;) {
                this.stats.pages++;
                total += page.rows.length;
                const more = await onPage({ rows: page.rows, pageNo, countText: page.countText, source: 'grid' });
                if (more === false || !page.nextTarget) break;
                if (pageNo >= maxPages) {
                    log.warning(`${this.tag()} Stopped ${label} after ${maxPages} result pages (maxPagesPerAgency). Narrow the dates or raise the limit.`);
                    break;
                }
                const firstBefore = page.rows[0]?.byKey?.recordNumber;
                const r = await this.postBack(page.nextTarget, {}, `results page ${pageNo + 1} of ${label}`, page.nextArgument);
                this.checkAcaPage(r, `results page ${pageNo + 1}`);
                this.current = { html: r.text, url: r.finalUrl };
                page = parseResults(r.text, r.finalUrl);
                pageNo++;
                if (!page.grid || !page.rows.length) {
                    const key = await this.saveDebug('empty-page', r.text);
                    throw new AcaError(`results page ${pageNo} of ${label} has no rows${key ? ` (saved as ${key})` : ''}`, { kind: 'session' });
                }
                if (page.rows[0]?.byKey?.recordNumber === firstBefore) {
                    log.warning(`${this.tag()} Results page ${pageNo} repeats the previous page; stopping pagination for ${label}.`);
                    break;
                }
            }
            return { pages: pageNo, rows: total };
        });
    }

    /** Clicks "Download results". Returns grid-like rows, or null when the export did not yield an ACA CSV. */
    async exportCsv(target, label) {
        try {
            const res = await this.postBack(target, {}, `CSV export of ${label}`);
            let body = res;
            const looksCsv = (r) => /text\/csv|application\/(?:vnd\.ms-excel|octet-stream|csv)/i.test(r.contentType) || /attachment/i.test(r.disposition);
            if (!looksCsv(res)) {
                const url = findExportUrl(res.text, res.finalUrl);
                if (!url) {
                    this.stats.csvFailures++;
                    log.info(`${this.tag()} "Download results" did not return a file (HTTP ${res.status}, ${res.contentType || 'no content-type'}); using the grid instead.`);
                    await this.saveDebug('export', res.text);
                    return null;
                }
                body = await this.rawRequest({ url, step: `CSV download of ${label}` });
            }
            const rows = csvToRows(body.text);
            if (!rows) {
                this.stats.csvFailures++;
                log.info(`${this.tag()} The export file is not a recognised ACA CSV (first line: "${clean(body.text.split('\n')[0]).slice(0, 120)}"); using the grid instead.`);
                return null;
            }
            this.stats.csvExports++;
            log.info(`${this.tag()} CSV export of ${label}: ${rows.length} rows in one request.`);
            return rows;
        } catch (err) {
            if (err instanceof AcaError && err.kind === 'blocked') throw err;
            this.stats.csvFailures++;
            log.info(`${this.tag()} CSV export failed (${err.message}); using the grid instead.`);
            return null;
        }
    }

    /** Loads and parses one CapDetail.aspx page. */
    async fetchDetail(url) {
        return this.withSession(`detail ${url}`, async () => {
            const res = await this.rawRequest({ url, step: 'record detail' });
            if (!isDetailPage(res.text)) {
                this.checkAcaPage(res, 'record detail');
                const key = await this.saveDebug('detail', res.text);
                throw new AcaError(`record detail page not recognised (HTTP ${res.status}, "${pageTitle(res.text)}")${key ? ` — saved as ${key}` : ''}`, { kind: 'detail', fatal: true });
            }
            this.stats.detailPages++;
            return parseDetail(res.text, url);
        });
    }
}
