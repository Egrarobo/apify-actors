import { Actor, log } from 'apify';
import { parseInput, InputError } from './input.js';
import { AldiClient, SPECIAL_CATEGORIES, specialBuysDates, pageLimit, MAX_LIMIT } from './store.js';
import { normalizeAldi, SITE_URL } from './normalize.js';

const EVENT_PRODUCT = 'product';
const LABEL = 'ALDI';
const n = (x) => Number(x).toLocaleString('en-US');
const LIST_TYPES = ['special-buys', 'super-savers', 'lower-prices', 'limited-time-only'];

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
    client = new AldiClient({
        apiUrl: cfg.apiBaseUrl, siteUrl: cfg.siteBaseUrl, servicePoint: cfg.storeId, sort: cfg.sort,
        proxyConfiguration, useBrowserForCookies: cfg.useBrowserForCookies, browserFallback: cfg.browserFallback,
        maxRetries: cfg.maxRetries, requestDelayMs: cfg.requestDelayMs, backoffMs: Number(process.env.GROCERY_BACKOFF_MS) || 1500, saveDebug,
    });

    // ── Work list ──────────────────────────────────────────────────────────────────
    const tasks = [];
    for (const term of cfg.searchTerms) tasks.push({ kind: { type: 'search', term }, label: `search "${term}"`, searchTerm: term });
    for (const l of cfg.listings) {
        const listType = l.type === 'specialBuys' ? 'special-buys' : LIST_TYPES.find((t) => l.slug.split('/').pop() === t) ?? null;
        tasks.push({ kind: l, label: l.type === 'specialBuys' ? `Special Buys ${l.date}` : `category ${l.slug}`, categoryUrl: l.url, listType });
    }
    if (cfg.skus.length) tasks.push({ products: cfg.skus, label: `${cfg.skus.length} product lookup(s)` });
    if (cfg.onlySpecials && !cfg.searchTerms.length && !cfg.listings.length && !cfg.skus.length) {
        for (const date of specialBuysDates()) {
            tasks.push({ kind: { type: 'specialBuys', date }, label: `Special Buys ${date}`, categoryUrl: `${SITE_URL}/special-buys/${date}`, listType: 'special-buys' });
        }
        for (const [slug, c] of Object.entries(SPECIAL_CATEGORIES)) {
            tasks.push({ kind: { type: 'category', key: c.key, slug, resolve: true }, label: c.name, categoryUrl: `${SITE_URL}/products/${slug}/k/${c.key}`, listType: slug });
        }
    }
    log.info(`ALDI Australia: ${tasks.length} task(s). Max ${n(cfg.maxItemsPerSearch)} products per search/list${cfg.onlySpecials ? ', specials only' : ''}, sort ${cfg.sort}. `
        + `Store: ${cfg.storeId ?? 'automatic'}. Proxy: ${proxyDesc}. API: ${client.apiUrl}.`);
    if (!proxyConfiguration && Actor.isAtHome()) log.warning('No proxy is used. Enable Apify Proxy if requests get blocked.');

    const errors = [];
    const errorItem = (task, err, productInput = null) => ({
        store: 'aldi',
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
        const ctx = { searchTerm: task.searchTerm ?? null, categoryUrl: task.categoryUrl ?? null, listType: task.listType, scrapedAt, includeRaw: cfg.includeRaw };
        let kind = task.kind;
        if (kind.resolve) {
            const live = await client.categoryKeyForSlug(kind.slug);
            if (live && live !== kind.key) {
                log.info(`[${LABEL}] ${task.label}: category key ${live} from the live category tree (known key was ${kind.key}).`);
                kind = { ...kind, key: live };
            }
        }
        const filtering = cfg.onlySpecials && !task.listType;
        const seen = new Set();
        let saved = 0;
        let checked = 0;
        let pages = 0;
        let reportedTotal = null;
        let hitPageCap = false;
        for await (const { items, page, total } of client.listing(kind, { maxPages: cfg.maxPagesPerSearch, maxItems: filtering ? MAX_LIMIT : cfg.maxItemsPerSearch })) {
            pages = page;
            if (page === 1) {
                reportedTotal = total;
                log.info(`[${LABEL}] ${task.label}: the store reports ${n(total ?? 0)} result(s) (page size ${pageLimit(filtering ? MAX_LIMIT : cfg.maxItemsPerSearch)}).`);
            }
            const batch = [];
            for (const raw of items) {
                if (!raw?.sku) continue;
                const rec = normalizeAldi(raw, ctx);
                if (seen.has(rec.productId)) continue;
                seen.add(rec.productId);
                checked++;
                if (cfg.onlySpecials && !rec.isOnSpecial) continue;
                batch.push(rec);
            }
            if (!sampleLogged && batch.length) {
                sampleLogged = true;
                const s = batch[0];
                log.info(`[${LABEL}] First product: "${s.name}" ${s.size ?? ''} — $${s.price} (${s.unitPriceText ?? 'no unit price'}), ${s.category ?? 'no category'}, ${s.url}`);
            }
            const stored = await emit(batch.slice(0, cfg.maxItemsPerSearch - saved));
            saved += stored;
            st.products += stored;
            if (limitReached || saved >= cfg.maxItemsPerSearch) break;
            if (page === cfg.maxPagesPerSearch) hitPageCap = true;
        }
        log.info(`[${LABEL}] ${task.label}: ${n(saved)} product(s) saved (${n(checked)} checked, ${pages} page${pages === 1 ? '' : 's'}).`);
        if (hitPageCap && reportedTotal && checked < reportedTotal) log.warning(`[${LABEL}] ${task.label}: stopped at maxPagesPerSearch = ${cfg.maxPagesPerSearch}; raise it to go deeper.`);
        if (!saved && cfg.onlySpecials && checked) log.info(`[${LABEL}] ${task.label}: none of the ${n(checked)} products checked is on special.`);
        if (!checked && task.kind.type === 'specialBuys') log.info(`[${LABEL}] ${task.label}: no products (this Special Buys date may not be announced yet or is over).`);
    }

    async function runProducts(task, st) {
        const found = await client.products(task.products.map((p) => p.sku));
        let failed = 0;
        for (const p of task.products) {
            const raw = found.get(p.sku);
            if (!raw) {
                failed++;
                const err = Object.assign(new Error(`Product ${p.input} was not found on ALDI Australia.`), { step: 'product lookup', status: 404 });
                log.error(`[${LABEL}] product ${p.input} FAILED: ${err.message}`);
                await recordError(errorItem(task, err, p.input));
                continue;
            }
            const rec = normalizeAldi(raw, { scrapedAt, includeRaw: cfg.includeRaw });
            rec.productInput = p.input;
            if (cfg.onlySpecials && !rec.isOnSpecial) {
                log.info(`[${LABEL}] product ${p.input}: not on special, skipped (onlySpecials).`);
                continue;
            }
            st.products += await emit([rec]);
            if (limitReached) break;
        }
        return failed;
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
                    giveUp = Object.assign(new Error(`skipped: ALDI blocked the previous inputs after all retries (${err.message})`),
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
    Object.assign(st, client.stats, { storeId: client.servicePoint, storeIdSource: client.servicePointSource });
    await client.close();

    const output = {
        products: pushed,
        failedTasks: st.failedTasks,
        totalTasks: tasks.length,
        stoppedAtCostLimit: limitReached,
        proxy: proxyDesc,
        stores: { aldi: st },
        errors: errors.map((e) => ({ input: e.searchTerm ?? e.categoryUrl ?? e.productId ?? 'specials', error: e.error, httpStatus: e.httpStatus, blocked: e.blocked })),
        startedAt: scrapedAt,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);

    log.info(`[${LABEL}] summary: ${n(st.products)} products, ${st.failedTasks}/${st.tasks} tasks failed, ${st.requests} requests, ${st.retries} retries, `
        + `${st.blocks} blocks, ${st.sessions} session(s), final method: ${st.strategy} (${st.headerProfile} headers), store ${st.storeId ?? 'none'} (${st.storeIdSource ?? 'n/a'}).`);
    let status = `Saved ${n(pushed)} ALDI product(s).`;
    if (st.failedTasks) status += ` ${st.failedTasks} of ${tasks.length} task(s) failed — see the log and the error rows.`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';

    if (pushed === 0 && st.failedTasks === tasks.length && tasks.length > 0) {
        const blocked = errors.some((e) => e.blocked);
        const msg = `Nothing could be loaded: ${errors[0]?.error ?? 'unknown error'}${blocked ? ' ALDI blocked the requests (anti-bot). Try Apify Proxy group RESIDENTIAL with country AU.' : ''}`;
        log.error(msg);
        await Actor.fail(msg);
    } else {
        if (pushed === 0) log.warning('No products were saved. Check the search terms / links, or turn off "Only specials".');
        log.info(status);
        await Actor.exit({ statusMessage: status });
    }
} catch (err) {
    if (client) await client.close().catch(() => {});
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
