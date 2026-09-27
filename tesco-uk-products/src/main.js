import { Actor, log } from 'apify';
import { parseInput, InputError } from './input.js';
import { TescoClient, PAGE_SIZE } from './store.js';
import { normalizeTesco } from './normalize.js';

const EVENT_PRODUCT = 'product';
const LABEL = 'Tesco';
const n = (x) => Number(x).toLocaleString('en-US');
const isClubcard = (rec) => String(rec.promoType ?? '').includes('CLUBCARD');

await Actor.init();

let client = null;
try {
    const cfg = parseInput((await Actor.getInput()) ?? {});
    const scrapedAt = new Date().toISOString();

    // ── Proxy ──────────────────────────────────────────────────────────────────────
    let proxyConfiguration = null;
    const pc = cfg.proxyConfiguration;
    if (pc?.useApifyProxy && !pc.proxyUrls?.length && !Actor.isAtHome() && !process.env.APIFY_PROXY_PASSWORD && !process.env.APIFY_TOKEN) {
        log.warning('Running WITHOUT a proxy (local run without APIFY_TOKEN / APIFY_PROXY_PASSWORD).');
    } else if (pc && (pc.useApifyProxy || pc.proxyUrls?.length)) {
        try {
            proxyConfiguration = (await Actor.createProxyConfiguration(pc)) ?? null;
        } catch (err) {
            if (Actor.isAtHome()) throw new InputError(`The proxy could not be set up: ${err.message}`);
            log.warning(`Running WITHOUT a proxy (local run, Apify Proxy not available: ${err.message.split('\n')[0]}).`);
        }
    }
    const proxyDesc = !proxyConfiguration ? 'none'
        : pc.proxyUrls?.length ? `${pc.proxyUrls.length} custom proxy URL(s)`
            : `Apify Proxy (${pc.apifyProxyGroups?.length ? pc.apifyProxyGroups.join('+') : 'automatic/datacenter'}${pc.apifyProxyCountry ? `, country ${pc.apifyProxyCountry}` : ''})`;

    // ── Charging (pay per event) ───────────────────────────────────────────────────
    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    let limitReached = false;
    let pushed = 0;
    let chain = Promise.resolve();
    /** Charges and stores products; never charges beyond the user's max cost per run. */
    const emit = (records) => {
        const job = chain.then(async () => {
            if (!records.length || limitReached) return 0;
            let batch = records;
            if (isPpe) {
                const allowed = chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_PRODUCT);
                if (allowed < batch.length) {
                    batch = batch.slice(0, Math.max(0, allowed));
                    limitReached = true;
                }
                if (!batch.length) return 0;
                const charge = await Actor.charge({ eventName: EVENT_PRODUCT, count: batch.length });
                if (charge.chargedCount < batch.length) {
                    batch = batch.slice(0, charge.chargedCount);
                    limitReached = true;
                }
            }
            if (batch.length) await Actor.pushData(batch);
            pushed += batch.length;
            if (isPpe && chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_PRODUCT) < 1) limitReached = true;
            return batch.length;
        });
        chain = job.catch(() => {});
        return job;
    };

    // ── Client ─────────────────────────────────────────────────────────────────────
    const saveDebug = cfg.saveDebugPages ? (key, content, contentType) => Actor.setValue(key, content, { contentType }) : null;
    client = new TescoClient({
        apiUrl: cfg.apiBaseUrl, siteUrl: cfg.siteBaseUrl, apiKey: cfg.apiKey,
        proxyConfiguration, useBrowserForCookies: cfg.useBrowserForCookies, browserFallback: cfg.browserFallback,
        maxRetries: cfg.maxRetries, requestDelayMs: cfg.requestDelayMs, backoffMs: Number(process.env.GROCERY_BACKOFF_MS) || 1500, saveDebug,
    });

    // ── Work list ──────────────────────────────────────────────────────────────────
    const tasks = [];
    for (const term of cfg.searchTerms) tasks.push({ kind: { type: 'search', term }, label: `search "${term}"`, searchTerm: term });
    for (const c of cfg.categories) {
        tasks.push({ kind: c, label: `category ${c.facet ?? c.slugs.join('/')}`, categoryUrl: c.url });
    }
    if (cfg.products.length) tasks.push({ products: cfg.products, label: `${cfg.products.length} product lookup(s)` });
    const scanAll = cfg.onlySpecials && !cfg.searchTerms.length && !cfg.categories.length && !cfg.products.length;
    const filterDesc = cfg.onlyClubcardPrices ? ', Clubcard Prices only' : cfg.onlySpecials ? ', offers only' : '';
    log.info(`Tesco UK: ${scanAll ? 'scan of all departments' : `${tasks.length} task(s)`}. Max ${n(cfg.maxItemsPerSearch)} products per search/category${filterDesc}. `
        + `Proxy: ${proxyDesc}. API: ${client.apiUrl} (key: ${client.keySource}).`);
    if (!proxyConfiguration && Actor.isAtHome()) log.warning('No proxy is used. Enable Apify Proxy if requests get blocked.');

    const errors = [];
    const errorItem = (task, err, productInput = null) => ({
        store: 'tesco',
        isError: true,
        searchTerm: task.searchTerm ?? null,
        categoryUrl: task.categoryUrl ?? null,
        productId: productInput,
        error: err.message,
        errorStep: err.step ?? null,
        httpStatus: err.status ?? null,
        blocked: Boolean(err.blocked),
        blockMarkers: err.markers?.length ? err.markers : null,
        scrapedAt,
    });
    const recordError = async (item) => {
        errors.push(item);
        // Error rows are free: they tell integrations which inputs failed and why.
        if (!limitReached) await Actor.pushData(item);
    };

    let sampleLogged = false;
    async function runListing(task, st) {
        const ctx = { searchTerm: task.searchTerm ?? null, categoryUrl: task.categoryUrl ?? null, scrapedAt, includeRaw: cfg.includeRaw };
        const { kind } = task;
        const filtering = cfg.onlySpecials;
        const seen = new Set();
        let saved = 0;
        let checked = 0;
        let pages = 0;
        let reportedTotal = null;
        let hitPageCap = false;
        const pageSize = filtering ? PAGE_SIZE : Math.min(PAGE_SIZE, cfg.maxItemsPerSearch);
        for await (const { items, page, total } of client.listing(kind, { maxPages: cfg.maxPagesPerSearch, maxItems: pageSize })) {
            pages = page;
            if (page === 1) {
                reportedTotal = total;
                log.info(`[${LABEL}] ${task.label}: ${total === null ? `${items.length} result(s) on page 1 (the API gave no total)` : `the store reports ${n(total)} result(s)`} (page size ${pageSize}).`);
            }
            const batch = [];
            for (const raw of items) {
                const rec = normalizeTesco(raw, ctx);
                if (seen.has(rec.productId)) continue;
                seen.add(rec.productId);
                checked++;
                if (cfg.onlySpecials && !rec.isOnSpecial) continue;
                if (cfg.onlyClubcardPrices && !isClubcard(rec)) continue;
                batch.push(rec);
            }
            if (!sampleLogged && batch.length) {
                sampleLogged = true;
                const s = batch[0];
                log.info(`[${LABEL}] First product: "${s.name}" — £${s.price}${s.loyaltyPrice !== null ? ` (Clubcard £${s.loyaltyPrice})` : ''} (${s.unitPriceText ?? 'no unit price'}), `
                    + `${s.category ?? 'no category'}, in stock: ${s.inStock}, ${s.url}`);
            }
            const stored = await emit(batch.slice(0, cfg.maxItemsPerSearch - saved));
            saved += stored;
            st.products += stored;
            if (limitReached || saved >= cfg.maxItemsPerSearch) break;
            if (page === cfg.maxPagesPerSearch) hitPageCap = true;
        }
        log.info(`[${LABEL}] ${task.label}: ${n(saved)} product(s) saved (${n(checked)} checked, ${pages} page${pages === 1 ? '' : 's'}).`);
        if (hitPageCap && reportedTotal && checked < reportedTotal) log.warning(`[${LABEL}] ${task.label}: stopped at maxPagesPerSearch = ${cfg.maxPagesPerSearch}; raise it to go deeper.`);
        if (!saved && cfg.onlySpecials && checked) log.info(`[${LABEL}] ${task.label}: none of the ${n(checked)} products checked has ${cfg.onlyClubcardPrices ? 'a Clubcard Price' : 'an offer'}.`);
    }

    async function runProducts(task, st) {
        const found = await client.products(task.products.map((p) => p.id));
        let failed = 0;
        for (const p of task.products) {
            const raw = found.get(p.id);
            if (!raw) {
                failed++;
                const err = Object.assign(new Error(`Product ${p.input} was not found on Tesco.`), { step: 'product lookup', status: 404 });
                log.error(`[${LABEL}] product ${p.input} FAILED: ${err.message}`);
                await recordError(errorItem(task, err, p.input));
                continue;
            }
            const rec = normalizeTesco(raw, { scrapedAt, includeRaw: cfg.includeRaw });
            rec.productInput = p.input;
            if ((cfg.onlySpecials && !rec.isOnSpecial) || (cfg.onlyClubcardPrices && !isClubcard(rec))) {
                log.info(`[${LABEL}] product ${p.input}: no ${cfg.onlyClubcardPrices ? 'Clubcard Price' : 'offer'}, skipped.`);
                continue;
            }
            st.products += await emit([rec]);
            if (limitReached) break;
        }
        return failed;
    }

    if (scanAll) {
        try {
            const deps = await client.departments();
            for (const d of deps) {
                tasks.push({ kind: { type: 'category', facet: d.facet, resolved: { facet: d.facet, name: d.name } }, label: `department ${d.name}`, categoryUrl: `https://www.tesco.com/shop/en-GB/browse/${d.slug}/all` });
            }
            log.info(`[${LABEL}] Scanning ${deps.length} department(s) for offers: ${deps.map((d) => d.name).join(', ')}.`);
        } catch (err) {
            const item = errorItem({}, err);
            log.error(`[${LABEL}] Could not load the department list FAILED: ${err.message}`);
            await recordError(item);
        }
    }

    const st = { tasks: tasks.length, failedTasks: 0, products: 0 };
    let blockedInARow = 0;
    let giveUp = null;
    for (const task of tasks) {
        if (limitReached) break;
        try {
            if (giveUp) throw giveUp;
            if (task.products) st.failedTasks += (await runProducts(task, st)) ? 1 : 0;
            else await runListing(task, st);
            blockedInARow = 0;
        } catch (err) {
            st.failedTasks++;
            if (!giveUp && err.blocked) {
                blockedInARow++;
                // Two inputs in a row fully blocked after all retries: don't burn time and proxy traffic on the rest.
                if (blockedInARow >= 2 && tasks.length > 2) {
                    giveUp = Object.assign(new Error(`skipped: Tesco blocked the previous inputs after all retries (${err.message})`),
                        { step: 'skipped', blocked: true, status: err.status, markers: err.markers });
                    log.warning(`[${LABEL}] Blocked on ${blockedInARow} inputs in a row; the remaining inputs are skipped.`);
                }
            }
            const detail = [
                err.step ? `step "${err.step}"` : null,
                err.status ? `HTTP ${err.status}` : null,
                err.blocked ? `anti-bot block${err.markers?.length ? ` (${err.markers.join(', ')})` : ''}` : null,
            ].filter(Boolean).join(', ');
            log.error(`[${LABEL}] ${task.label} FAILED${detail ? ` — ${detail}` : ''}: ${err.message}`);
            if (task.products) for (const p of task.products) await recordError(errorItem(task, err, p.input));
            else await recordError(errorItem(task, err));
        }
    }
    Object.assign(st, client.stats, { apiKeySource: client.keySource, fieldSet: client.full ? 'full' : 'basic' });
    if (!tasks.length) st.failedTasks = errors.length;
    await client.close();

    const output = {
        products: pushed,
        failedTasks: st.failedTasks,
        totalTasks: tasks.length,
        stoppedAtCostLimit: limitReached,
        proxy: proxyDesc,
        stores: { tesco: st },
        errors: errors.map((e) => ({ input: e.searchTerm ?? e.categoryUrl ?? e.productId ?? 'specials', error: e.error, httpStatus: e.httpStatus, blocked: e.blocked })),
        startedAt: scrapedAt,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);

    log.info(`[${LABEL}] summary: ${n(st.products)} products, ${st.failedTasks}/${st.tasks} tasks failed, ${st.requests} requests, ${st.retries} retries, `
        + `${st.blocks} blocks, ${st.sessions} session(s), final method: ${st.strategy}, API key: ${st.apiKeySource}, field set: ${st.fieldSet}.`);
    let status = `Saved ${n(pushed)} Tesco product(s).`;
    if (st.failedTasks) status += ` ${st.failedTasks} of ${Math.max(tasks.length, 1)} task(s) failed — see the log and the error rows.`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';

    if (pushed === 0 && errors.length && st.failedTasks >= tasks.length) {
        const blocked = errors.some((e) => e.blocked);
        const msg = `Nothing could be loaded: ${errors[0]?.error ?? 'unknown error'}${blocked ? ' Tesco blocked the requests (anti-bot). Try Apify Proxy group RESIDENTIAL with country GB.' : ''}`;
        log.error(msg);
        await Actor.fail(msg);
    } else {
        if (pushed === 0) log.warning('No products were saved. Check the search terms / links, or turn off "Only offers".');
        log.info(status);
        await Actor.exit({ statusMessage: status });
    }
} catch (err) {
    if (client) await client.close().catch(() => {});
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
