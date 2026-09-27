import { Actor, log } from 'apify';
import { parseInput, InputError } from './input.js';
import { ColesClient } from './stores/coles.js';
import { WoolworthsClient } from './stores/woolworths.js';
import { normalizeColes, normalizeWoolworths } from './normalize.js';

const EVENT_PRODUCT = 'product';
const LABEL = { coles: 'Coles', woolworths: 'Woolworths' };
const n = (x) => Number(x).toLocaleString('en-US');

await Actor.init();

const clients = [];
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

    // ── Work list ──────────────────────────────────────────────────────────────────
    const tasks = { coles: [], woolworths: [] };
    for (const store of cfg.stores) for (const term of cfg.searchTerms) tasks[store].push({ kind: { type: 'search', term }, label: `search "${term}"`, searchTerm: term });
    for (const c of cfg.categories) {
        const kind = c.store === 'coles'
            ? (c.type === 'specials' ? { type: 'specials' } : { type: 'category', slugParts: c.slugParts })
            : (c.type === 'specials' ? { type: 'specials' } : { type: 'category', slug: c.slug });
        tasks[c.store].push({ kind, label: `category ${c.url}`, categoryUrl: c.url });
    }
    for (const p of cfg.products) tasks[p.store].push({ product: p, label: `product ${p.input}`, productInput: p.input });
    if (cfg.onlySpecials && !cfg.searchTerms.length && !cfg.categories.length && !cfg.products.length) {
        for (const store of cfg.stores) tasks[store].push({ kind: { type: 'specials' }, label: 'all specials', categoryUrl: null });
    }
    const activeStores = Object.keys(tasks).filter((s) => tasks[s].length);
    log.info(`Stores: ${activeStores.map((s) => `${LABEL[s]} (${tasks[s].length} task${tasks[s].length === 1 ? '' : 's'})`).join(', ')}. `
        + `Max ${n(cfg.maxItemsPerSearch)} products per search/category${cfg.onlySpecials ? ', specials only' : ''}${cfg.includeSponsored ? ', sponsored rows included' : ''}. Proxy: ${proxyDesc}.`);
    if (!proxyConfiguration && Actor.isAtHome()) log.warning('No proxy is used. Both stores block many cloud IPs; enable Apify Proxy if requests get blocked.');

    // ── Charging (pay per event) ───────────────────────────────────────────────────
    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    let limitReached = false;
    let pushed = 0;
    let chain = Promise.resolve();
    /** Charges and stores products; never charges beyond the user's max cost per run. Serialised across stores. */
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

    const saveDebug = cfg.saveDebugPages ? (key, content, contentType) => Actor.setValue(key, content, { contentType }) : null;
    const backoffMs = Number(process.env.AU_GROCERY_BACKOFF_MS) || 1500;
    const makeClient = (store) => {
        const common = {
            proxyConfiguration, browserFallback: cfg.browserFallback, maxRetries: cfg.maxRetries,
            requestDelayMs: cfg.requestDelayMs, backoffMs, saveDebug,
        };
        const c = store === 'coles'
            ? new ColesClient({ ...common, baseUrl: cfg.colesBaseUrl, useBrowserForCookies: cfg.useBrowserForCookies })
            // Woolworths: plain HTTP first (works for hotprices-au); the browser is only the fallback.
            : new WoolworthsClient({ ...common, baseUrl: cfg.woolworthsBaseUrl, useBrowserForCookies: false });
        clients.push(c);
        return c;
    };

    const perStore = {};
    const errors = [];

    const errorItem = (store, task, err) => ({
        store,
        isError: true,
        searchTerm: task.searchTerm ?? null,
        categoryUrl: task.categoryUrl ?? null,
        productId: task.productInput ?? null,
        error: err.message,
        errorStep: err.step ?? null,
        httpStatus: err.status ?? null,
        blocked: Boolean(err.blocked),
        blockMarkers: err.markers?.length ? err.markers : null,
        scrapedAt,
    });

    async function runListing(store, client, task, st) {
        const normalize = store === 'coles' ? normalizeColes : normalizeWoolworths;
        const ctx = { searchTerm: task.searchTerm ?? null, categoryUrl: task.categoryUrl ?? null, scrapedAt, includeRaw: cfg.includeRaw };
        const seen = new Set();
        let saved = 0;
        let checked = 0;
        let pages = 0;
        let sponsoredSkipped = 0;
        let reportedTotal = null;
        let hitPageCap = false;
        for await (const { items, page, total } of client.listing(task.kind, { maxPages: cfg.maxPagesPerSearch })) {
            pages = page;
            if (page === 1) {
                reportedTotal = total;
                log.info(`[${LABEL[store]}] ${task.label}: the store reports ${n(total ?? 0)} result(s).`);
            }
            const batch = [];
            for (const raw of items) {
                const rec = normalize(raw, ctx);
                if (seen.has(rec.productId)) continue;
                if (rec.isSponsored && !cfg.includeSponsored) {
                    sponsoredSkipped++;
                    continue;
                }
                seen.add(rec.productId);
                checked++;
                if (cfg.onlySpecials && !rec.isOnSpecial) continue;
                batch.push(rec);
            }
            const room = cfg.maxItemsPerSearch - saved;
            const stored = await emit(batch.slice(0, room));
            saved += stored;
            st.products += stored;
            if (limitReached || saved >= cfg.maxItemsPerSearch) break;
            if (page === cfg.maxPagesPerSearch) hitPageCap = true;
        }
        const extra = [
            `${n(checked)} checked`,
            `${pages} page${pages === 1 ? '' : 's'}`,
            sponsoredSkipped ? `${sponsoredSkipped} sponsored row(s) skipped` : null,
        ].filter(Boolean).join(', ');
        log.info(`[${LABEL[store]}] ${task.label}: ${n(saved)} product(s) saved (${extra}).`);
        if (hitPageCap && reportedTotal && checked < reportedTotal) {
            log.warning(`[${LABEL[store]}] ${task.label}: stopped at maxPagesPerSearch = ${cfg.maxPagesPerSearch}; raise it to go deeper.`);
        }
        if (!saved && cfg.onlySpecials && checked) log.info(`[${LABEL[store]}] ${task.label}: none of the ${n(checked)} products checked is on special.`);
    }

    async function runProduct(store, client, task) {
        const p = task.product;
        const raw = store === 'coles' ? await client.product({ slug: p.slug, id: p.id }) : await client.product(p.id);
        if (!raw) {
            const err = Object.assign(new Error(`Product ${p.input} was not found on ${LABEL[store]}.`), { step: 'product lookup', status: 404 });
            throw err;
        }
        const rec = (store === 'coles' ? normalizeColes : normalizeWoolworths)(raw, { scrapedAt, includeRaw: cfg.includeRaw });
        rec.productInput = p.input;
        if (cfg.onlySpecials && !rec.isOnSpecial) {
            log.info(`[${LABEL[store]}] ${task.label}: not on special, skipped (onlySpecials).`);
            return 0;
        }
        return emit([rec]);
    }

    async function runStore(store) {
        const client = makeClient(store);
        const st = { tasks: tasks[store].length, failedTasks: 0, products: 0 };
        perStore[store] = st;
        let blockedInARow = 0;
        let giveUp = null;
        for (const task of tasks[store]) {
            if (limitReached) break;
            try {
                if (giveUp) throw giveUp;
                if (task.product) st.products += await runProduct(store, client, task);
                else await runListing(store, client, task, st);
                blockedInARow = 0;
            } catch (err) {
                st.failedTasks++;
                if (!giveUp && err.blocked) {
                    blockedInARow++;
                    // Two inputs in a row fully blocked after all retries: don't burn time and proxy traffic on the rest.
                    if (blockedInARow >= 2 && tasks[store].length > 2) {
                        giveUp = Object.assign(new Error(`skipped: ${LABEL[store]} blocked the previous inputs after all retries (${err.message})`),
                            { step: 'skipped', blocked: true, status: err.status, markers: err.markers });
                        log.warning(`[${LABEL[store]}] Blocked on ${blockedInARow} inputs in a row; the remaining ${LABEL[store]} inputs are skipped.`);
                    }
                }
                const detail = [
                    err.step ? `step "${err.step}"` : null,
                    err.status ? `HTTP ${err.status}` : null,
                    err.blocked ? `anti-bot block${err.markers?.length ? ` (${err.markers.join(', ')})` : ''}` : null,
                ].filter(Boolean).join(', ');
                log.error(`[${LABEL[store]}] ${task.label} FAILED${detail ? ` — ${detail}` : ''}: ${err.message}`);
                const item = errorItem(store, task, err);
                errors.push(item);
                // Error rows are free: they tell integrations which inputs failed and why.
                if (!limitReached) await Actor.pushData(item);
            }
        }
        Object.assign(st, client.stats);
        await client.close();
    }

    await Promise.all(activeStores.map((s) => runStore(s)));

    const totalTasks = activeStores.reduce((a, s) => a + tasks[s].length, 0);
    const output = {
        products: pushed,
        failedTasks: errors.length,
        totalTasks,
        stoppedAtCostLimit: limitReached,
        proxy: proxyDesc,
        stores: perStore,
        errors: errors.map((e) => ({ store: e.store, input: e.searchTerm ?? e.categoryUrl ?? e.productId ?? 'specials', error: e.error, httpStatus: e.httpStatus, blocked: e.blocked })),
        startedAt: scrapedAt,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);

    for (const s of activeStores) {
        const st = perStore[s];
        log.info(`[${LABEL[s]}] summary: ${n(st.products)} products, ${st.failedTasks}/${st.tasks} tasks failed, ${st.requests} requests, `
            + `${st.retries} retries, ${st.blocks} blocks, ${st.sessions} session(s), final method: ${st.strategy}.`);
    }
    const byStore = activeStores.map((s) => `${LABEL[s]}: ${n(perStore[s].products)}`).join(', ');
    let status = `Saved ${n(pushed)} product(s) (${byStore}).`;
    if (errors.length) status += ` ${errors.length} of ${totalTasks} task(s) failed — see the log and the error rows.`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';

    if (pushed === 0 && errors.length === totalTasks && totalTasks > 0) {
        const blocked = errors.filter((e) => e.blocked).map((e) => LABEL[e.store]);
        const hint = blocked.length
            ? ` ${[...new Set(blocked)].join(' and ')} blocked the requests (anti-bot). Try Apify Proxy group RESIDENTIAL with country AU.`
            : '';
        const msg = `Nothing could be loaded: ${errors[0].error}${hint}`;
        log.error(msg);
        await Actor.fail(msg);
    } else {
        log.info(status);
        await Actor.exit({ statusMessage: status });
    }
} catch (err) {
    for (const c of clients) await c.close().catch(() => {});
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
