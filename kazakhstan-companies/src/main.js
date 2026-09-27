import { Actor, log } from 'apify';
import { parseBin, cleanBin, decodeBin } from './bin.js';
import { createHttpClient, SourceUnavailableError } from './http.js';
import { createSources, REGISTRY, STATISTICS, SOURCE_INFO } from './sources.js';
import { buildItem, nameScore, nameTokens } from './normalize.js';
import { openCache, binKey, nameKey } from './cache.js';

const EVENT_RESULT = 'company-result';
const LANGS = ['ru', 'kz', 'en'];
const ALL_SOURCES = [REGISTRY, STATISTICS];
const MAX_BINS = 10000;
const MAX_NAMES = 100;
const MAX_RESULTS_CAP = 200;
const SOURCE_DOWN_AFTER = 2; // consecutive "unreachable" failures before a source is skipped for the rest of the run

function validateInput(input) {
    const known = new Set(['bins', 'names', 'language', 'maxResults', 'sources', 'validateChecksum', 'includeOriginal',
        'cacheDays', 'forceRefresh', 'proxyConfiguration', 'egovApiKey', 'maxConcurrency', 'requestTimeoutSecs', 'apiBaseUrl']);
    const unknown = Object.keys(input).filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`Unknown input field(s): ${unknown.join(', ')}. Did you mean "bins" or "names"?`);

    const binsIn = input.bins ?? [];
    const namesIn = input.names ?? [];
    if (!Array.isArray(binsIn)) throw new Error('"bins" must be an array of 12-digit BINs, e.g. ["971240001315"].');
    if (!Array.isArray(namesIn)) throw new Error('"names" must be an array of company names, e.g. ["Казахтелеком"].');
    if (binsIn.length > MAX_BINS) throw new Error(`Too many BINs (${binsIn.length}). The maximum per run is ${MAX_BINS}; split the list into several runs.`);
    if (namesIn.length > MAX_NAMES) throw new Error(`Too many names (${namesIn.length}). The maximum per run is ${MAX_NAMES}.`);

    const language = String(input.language ?? 'ru').toLowerCase().replace(/^kk$/, 'kz');
    if (!LANGS.includes(language)) throw new Error('"language" must be "ru", "kz" or "en".');

    const maxResults = Number(input.maxResults ?? 10);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new Error(`"maxResults" must be an integer from 1 to ${MAX_RESULTS_CAP}.`);

    const sources = input.sources ?? ALL_SOURCES;
    if (!Array.isArray(sources) || !sources.length || sources.some((x) => !ALL_SOURCES.includes(x))) {
        throw new Error('"sources" must be a non-empty array containing "registry" and/or "statistics".');
    }

    const cacheDays = Number(input.cacheDays ?? 7);
    if (!(cacheDays >= 0 && cacheDays <= 365)) throw new Error('"cacheDays" must be a number from 0 (no cache) to 365.');
    const maxConcurrency = Number(input.maxConcurrency ?? 2);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 5) throw new Error('"maxConcurrency" must be an integer from 1 to 5 (please be polite to government servers).');
    const requestTimeoutSecs = Number(input.requestTimeoutSecs ?? 30);
    if (!(requestTimeoutSecs >= 5 && requestTimeoutSecs <= 120)) throw new Error('"requestTimeoutSecs" must be from 5 to 120.');

    let apiBaseUrl = null;
    if (input.apiBaseUrl) {
        try {
            apiBaseUrl = new URL(String(input.apiBaseUrl)).origin;
        } catch {
            throw new Error('"apiBaseUrl" must be a full URL such as http://localhost:8080 (testing only; leave empty for the official sources).');
        }
    }

    const validateChecksum = input.validateChecksum !== false;
    const bins = [];
    const invalid = [];
    const seen = new Set();
    for (const raw of binsIn) {
        const text = String(raw ?? '').trim();
        if (!text) continue;
        let parsed = parseBin(text);
        if (!parsed.valid && !validateChecksum && /^\d{12}$/.test(parsed.bin) && Number(parsed.bin[4]) >= 4) {
            parsed = { bin: parsed.bin, valid: true, info: decodeBin(parsed.bin), checksumSkipped: true };
        }
        if (parsed.valid) {
            if (!seen.has(parsed.bin)) { seen.add(parsed.bin); bins.push(parsed); }
        } else invalid.push({ query: text, bin: cleanBin(text), error: parsed.error });
    }

    const names = [...new Set(namesIn.map((n) => String(n ?? '').trim()).filter(Boolean))];
    for (const n of names) {
        if (n.length < 2 || !nameTokens(n).length) throw new Error(`Name query "${n}" is too short or contains only legal-form words (e.g. ТОО, LLP). Use at least one distinctive word.`);
    }
    if (names.length && !sources.includes(REGISTRY)) {
        throw new Error('Name search uses the state register (data.egov.kz). Add "registry" to "sources" or remove "names". The statistics source only supports BIN lookups.');
    }

    if (!bins.length && !names.length) {
        throw new Error(invalid.length
            ? `No valid BIN given. ${invalid.map((i) => `"${i.query}": ${i.error}`).join(' ')}`
            : 'Nothing to look up. Provide "bins" (12-digit business identification numbers) and/or "names".');
    }

    const egovApiKey = input.egovApiKey ? String(input.egovApiKey).trim() : null;
    return {
        bins, invalid, names, language, maxResults, sources, validateChecksum,
        includeOriginal: input.includeOriginal !== false,
        cacheDays, forceRefresh: input.forceRefresh === true,
        proxyInput: input.proxyConfiguration ?? null,
        egovApiKey: egovApiKey || null, maxConcurrency, requestTimeoutSecs, apiBaseUrl,
    };
}

/** Runs `fn` over `items` with at most `concurrency` in flight; stops scheduling when `shouldStop()` is true. */
async function pool(items, concurrency, fn, shouldStop) {
    let next = 0;
    const worker = async () => {
        while (next < items.length && !shouldStop()) {
            const i = next++;
            await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const opts = validateInput(input);
    for (const i of opts.invalid) log.warning(`Skipping invalid BIN "${i.query}": ${i.error}`);

    let proxyConfiguration = null;
    if (opts.proxyInput && (opts.proxyInput.useApifyProxy || opts.proxyInput.proxyUrls?.length)) {
        proxyConfiguration = await Actor.createProxyConfiguration(opts.proxyInput);
        log.info('Using proxy for requests to the official sources.');
    }
    // KZ_RETRY_BASE_MS only shortens retry delays in the test suite.
    const http = createHttpClient({ proxyConfiguration, timeoutSecs: opts.requestTimeoutSecs, baseDelayMs: Number(process.env.KZ_RETRY_BASE_MS) || 1000 });
    const src = createSources({ http, apiBaseUrl: opts.apiBaseUrl, egovApiKey: opts.egovApiKey });
    const cache = await openCache({ enabled: opts.cacheDays > 0, cacheDays: opts.cacheDays });
    if (opts.forceRefresh) log.info('forceRefresh: ignoring cached answers (fresh answers are still written to the cache).');
    if (opts.apiBaseUrl) log.warning(`apiBaseUrl is set: requests go to ${opts.apiBaseUrl} instead of the official sources (testing only).`);

    const charging = Actor.getChargingManager();
    const isPpe = charging.getPricingInfo().isPayPerEvent;
    let limitReached = false;
    const counts = { found: 0, notFound: 0, errors: 0, charged: 0, requests: 0, successfulRequests: 0 };
    const sourceHealth = Object.fromEntries(ALL_SOURCES.map((x) => [x, { consecutiveFailures: 0, down: null, ok: 0, failed: 0 }]));
    const statLang = opts.language;

    const budgetLeft = () => !isPpe || charging.calculateMaxEventChargeCountWithinLimit(EVENT_RESULT) > 0;
    const stop = () => {
        if (!limitReached && !budgetLeft()) {
            limitReached = true;
            log.warning('Stopped: the run reached the maximum cost you set. Remaining lookups were skipped.');
        }
        return limitReached;
    };

    /** Charges one company-result and pushes the item; returns false when the spending limit prevents it. */
    const emitFound = async (item) => {
        if (limitReached) return false;
        if (isPpe) {
            // Check the budget synchronously right before charging (no await in between): at zero budget the SDK
            // would otherwise record one extra event as a termination signal, and parallel workers could race.
            if (charging.calculateMaxEventChargeCountWithinLimit(EVENT_RESULT) < 1) {
                limitReached = true;
                log.warning('Stopped: the run reached the maximum cost you set.');
                return false;
            }
            const res = await Actor.charge({ eventName: EVENT_RESULT, count: 1 });
            if (res.chargedCount < 1) {
                limitReached = true;
                log.warning('Stopped: the run reached the maximum cost you set.');
                return false;
            }
        }
        await Actor.pushData(item);
        counts.found++;
        counts.charged++;
        return true;
    };

    /**
     * Cached call to one source. Returns { value, url, fromCache, fetchedAt } or { error }.
     * `fetcher` returns { value, url, empty }.
     */
    const callSource = async (source, key, fetcher) => {
        if (!opts.forceRefresh) {
            const hit = await cache.get(key);
            if (hit) return { value: hit.value, url: hit.url, fromCache: true, fetchedAt: hit.fetchedAt };
        }
        const health = sourceHealth[source];
        if (health.down) return { error: health.down, unavailable: true };
        counts.requests++;
        try {
            const r = await fetcher();
            health.consecutiveFailures = 0;
            health.ok++;
            counts.successfulRequests++;
            await cache.set(key, r.value, { empty: r.empty, url: r.url });
            return { value: r.value, url: r.url, fromCache: false, fetchedAt: new Date().toISOString() };
        } catch (e) {
            health.failed++;
            if (e instanceof SourceUnavailableError) {
                health.consecutiveFailures++;
                if (health.consecutiveFailures >= SOURCE_DOWN_AFTER && !health.down) {
                    health.down = e.message;
                    log.error(`${e.message} Skipping this source for the rest of the run.`);
                } else log.warning(e.message);
                return { error: e.message, unavailable: true };
            }
            log.warning(`${SOURCE_INFO[source].name}: ${e.message}`);
            return { error: e.message };
        }
    };

    const sourceLabel = (used) => used.map((x) => SOURCE_INFO[x].name).join(' + ');

    // ---------- BIN lookups ----------
    await pool(opts.bins, opts.maxConcurrency, async ({ bin, info, checksumSkipped }) => {
        if (stop()) return;
        const results = {};
        if (opts.sources.includes(REGISTRY)) {
            results[REGISTRY] = await callSource(REGISTRY, binKey(REGISTRY, 'all', bin), async () => {
                const r = await src.registryByBin(bin);
                return { value: r.records, url: r.url, empty: !r.records.length };
            });
        }
        if (opts.sources.includes(STATISTICS)) {
            results[STATISTICS] = await callSource(STATISTICS, binKey(STATISTICS, statLang, bin), async () => {
                const r = await src.statisticsByBin(bin, statLang);
                return { value: r.record, url: r.url, empty: !r.record };
            });
        }
        const registryRecords = results[REGISTRY]?.value ?? [];
        // Prefer the registered (active) record if the register lists the BIN more than once.
        const registry = registryRecords.find((r) => /зарегистр|тіркелген/i.test(`${r.statusru} ${r.statuskz}`)) ?? registryRecords[0] ?? null;
        const statistics = results[STATISTICS]?.value ?? null;
        const used = Object.keys(results).filter((k) => (k === REGISTRY ? registry : statistics));
        const errors = Object.entries(results).filter(([, r]) => r.error).map(([k, r]) => `${k}: ${r.error}`);
        const fromCache = Object.values(results).every((r) => r.fromCache);
        const retrievedAt = Object.values(results).map((r) => r.fetchedAt).filter(Boolean).sort()[0] ?? new Date().toISOString();
        const sourceUrls = Object.values(results).map((r) => r.url).filter(Boolean);
        const meta = { matchedQuery: bin, language: opts.language, source: null, sources: used, sourceUrls, retrievedAt, fromCache };

        if (registry || statistics) {
            const item = buildItem({ bin, registry, statistics, language: opts.language, binInfo: info, includeOriginal: opts.includeOriginal });
            Object.assign(item, meta, { lookupStatus: 'found', source: sourceLabel(used) });
            if (registryRecords.length > 1) item.registryRecordCount = registryRecords.length;
            if (checksumSkipped) item.warnings = [...(item.warnings ?? []), 'BIN check digit is not valid; looked up anyway because validateChecksum is off.'];
            if (errors.length) item.warnings = [...(item.warnings ?? []), ...errors.map((e) => `Partial result, a source failed: ${e}`)];
            await emitFound(item);
        } else if (errors.length) {
            counts.errors++;
            await Actor.pushData({ found: false, bin, lookupStatus: 'error', error: errors.join(' | '), binInfo: info, ...meta, source: sourceLabel(Object.keys(results)) });
        } else {
            counts.notFound++;
            await Actor.pushData({ found: false, bin, lookupStatus: 'not_found', error: 'BIN not found in the official sources queried.', binInfo: info, ...meta, source: sourceLabel(Object.keys(results)) });
        }
    }, stop);

    // ---------- Name searches ----------
    const nameSummary = [];
    await pool(opts.names, 1, async (name) => {
        if (stop()) return;
        const mode = opts.egovApiKey ? 'api' : 'viewer';
        const r = await callSource(REGISTRY, nameKey(REGISTRY, name, opts.maxResults, mode), async () => {
            // Legal-form words (ТОО, АО, LLP...) are dropped from the text sent to the source: the register spells them out in full.
            const res = await src.registryByName(nameTokens(name).join(' '), opts.maxResults);
            return { value: res.records, url: res.urls[0] ?? null, empty: !res.records.length };
        });
        if (r.error) {
            counts.errors++;
            nameSummary.push({ name, returned: 0, error: r.error });
            await Actor.pushData({ found: false, bin: null, matchedQuery: name, lookupStatus: 'error', error: r.error, source: SOURCE_INFO[REGISTRY].name, retrievedAt: new Date().toISOString() });
            return;
        }
        const byBin = new Map();
        for (const rec of r.value ?? []) {
            const score = nameScore(rec, name);
            if (!score) continue;
            const key = String(rec.bin ?? '').trim() || `id:${rec.id}`;
            const prev = byBin.get(key);
            if (!prev || score > prev.score) byBin.set(key, { rec, score });
        }
        const active = (x) => (/зарегистр|тіркелген/i.test(`${x.rec.statusru} ${x.rec.statuskz}`) ? 0 : 1);
        const hits = [...byBin.values()]
            .sort((a, b) => b.score - a.score || active(a) - active(b) || String(a.rec.nameru ?? '').length - String(b.rec.nameru ?? '').length)
            .slice(0, opts.maxResults);
        let returned = 0;
        for (const { rec, score } of hits) {
            if (stop()) break;
            const bin = String(rec.bin ?? '').trim();
            const parsed = /^\d{12}$/.test(bin) ? parseBin(bin) : null;
            let statistics = null;
            const urls = [r.url];
            if (parsed && opts.sources.includes(STATISTICS)) {
                const st = await callSource(STATISTICS, binKey(STATISTICS, statLang, bin), async () => {
                    const x = await src.statisticsByBin(bin, statLang);
                    return { value: x.record, url: x.url, empty: !x.record };
                });
                statistics = st.value ?? null;
                if (st.url) urls.push(st.url);
            }
            const used = statistics ? [REGISTRY, STATISTICS] : [REGISTRY];
            const item = buildItem({ bin: bin || null, registry: rec, statistics, language: opts.language, binInfo: parsed?.valid ? parsed.info : (bin ? decodeBin(bin) : null), includeOriginal: opts.includeOriginal });
            Object.assign(item, {
                matchedQuery: name, matchScore: score, lookupStatus: 'found', language: opts.language, source: sourceLabel(used), sources: used,
                sourceUrls: urls.filter(Boolean), retrievedAt: r.fetchedAt, fromCache: r.fromCache,
            });
            if (await emitFound(item)) returned++;
        }
        nameSummary.push({ name, returned });
        if (!hits.length) {
            counts.notFound++;
            log.info(`No company matches name "${name}".`);
            await Actor.pushData({ found: false, bin: null, matchedQuery: name, lookupStatus: 'not_found', error: 'No company in the state register matches this name.', source: SOURCE_INFO[REGISTRY].name, sourceUrls: [r.url].filter(Boolean), retrievedAt: r.fetchedAt, fromCache: r.fromCache });
        }
    }, stop);

    // ---------- Invalid BINs (free) ----------
    if (opts.invalid.length) {
        await Actor.pushData(opts.invalid.map((i) => ({ found: false, bin: i.bin || null, matchedQuery: i.query, lookupStatus: 'invalid', error: i.error })));
    }

    const unavailable = Object.entries(sourceHealth).filter(([, h]) => h.down).map(([k]) => k);
    const summary = {
        foundCompanies: counts.found,
        notFound: counts.notFound,
        invalidBins: opts.invalid.map((i) => i.query),
        failedLookups: counts.errors,
        names: nameSummary,
        chargedEvents: { [EVENT_RESULT]: isPpe ? counts.charged : 0 },
        stoppedBySpendingLimit: limitReached,
        requestsToSources: counts.requests,
        cache: { store: opts.cacheDays > 0 ? 'kazakhstan-company-lookup-cache' : null, ...cache.stats },
        unavailableSources: unavailable,
        sources: Object.fromEntries(opts.sources.map((x) => [x, { ...SOURCE_INFO[x], ok: sourceHealth[x].ok, failed: sourceHealth[x].failed }])),
    };
    await Actor.setValue('OUTPUT', summary);

    // Everything failed because the sources could not be reached: fail loudly (nothing was charged).
    if (counts.requests > 0 && counts.successfulRequests === 0 && counts.found === 0 && counts.errors > 0) {
        const detail = Object.values(sourceHealth).map((h) => h.down).find(Boolean)
            ?? 'No official source answered.';
        throw new Error(`No lookup could be completed. ${detail}`);
    }

    const msg = `Found ${counts.found} compan${counts.found === 1 ? 'y' : 'ies'}`
        + `${counts.notFound ? `, ${counts.notFound} not found` : ''}`
        + `${opts.invalid.length ? `, ${opts.invalid.length} invalid BIN(s)` : ''}`
        + `${counts.errors ? `, ${counts.errors} failed (source unavailable)` : ''}`
        + `${limitReached ? '. Stopped at your spending limit' : ''}.`;
    log.info(msg);
    await Actor.exit({ statusMessage: msg });
} catch (err) {
    log.error(err.message);
    await Actor.fail(err.message);
}
