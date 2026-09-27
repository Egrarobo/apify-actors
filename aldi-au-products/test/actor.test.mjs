// End-to-end tests: run src/main.js as a child process against the local mock ALDI API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { startMockServer } from './mock-server.mjs';
import { runActor } from './helpers.mjs';

let srv;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const base = (extra = {}) => ({
    apiBaseUrl: srv.apiUrl,
    siteBaseUrl: srv.siteUrl,
    useBrowserForCookies: false,
    browserFallback: false,
    requestDelayMs: 0,
    proxyConfiguration: { useApifyProxy: false },
    ...extra,
});
const products = (items) => items.filter((i) => !i.isError);
const kvKeys = (dir) => {
    const d = path.join(dir, 'key_value_stores', 'default');
    return existsSync(d) ? readdirSync(d) : [];
};
const CHROME = process.env.BROWSER_EXECUTABLE_PATH
    || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find((p) => existsSync(p));

test('default input (prefill "milk"): unified schema, pagination by offset, store auto-picked, no duplicates', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 100 }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.equal(items.length, 100);
    for (const i of items) {
        for (const k of ['store', 'productId', 'name', 'brand', 'size', 'price', 'wasPrice', 'unitPrice', 'unitPriceText', 'promoText', 'loyaltyPrice',
            'isOnSpecial', 'inStock', 'category', 'imageUrl', 'url', 'searchTerm', 'currency', 'scrapedAt']) assert.ok(k in i, `missing ${k}`);
        assert.equal(i.store, 'aldi');
        assert.equal(i.currency, 'AUD');
        assert.equal(i.searchTerm, 'milk');
    }
    assert.equal(new Set(items.map((i) => i.productId)).size, 100);
    const searches = srv.state.requests.filter((q) => q.includes('/v3/product-search'));
    assert.equal(searches.length, 2, 'two pages of 60');
    assert.ok(searches[1].includes('offset=60'));
    assert.ok(searches.every((q) => q.includes('servicePoint=G452') && q.includes('currency=AUD') && q.includes('serviceType=walk-in') && q.includes('limit=60')));
    assert.match(r.log, /Using store G452 \(Chatswood, Chatswood, NSW\)/);
    assert.match(r.log, /First product: "LODGE FARMS Cage Eggs 700g"/);
    assert.equal(r.output.products, 100);
    assert.equal(r.output.stores.aldi.storeId, 'G452');
});

test('small max → smallest allowed page size; sorting; no results', async () => {
    const r = await runActor(base({ searchTerms: ['milk', 'nothing'], maxItemsPerSearch: 5, sortBy: 'price_asc', storeId: 'H123' }));
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 5);
    const q = srv.state.requests.find((x) => x.includes('/v3/product-search'));
    assert.ok(q.includes('limit=12') && q.includes('sort=price_asc') && q.includes('servicePoint=H123'), q);
    assert.ok(!srv.state.requests.some((x) => x.includes('/v2/service-points')), 'storeId from input: no lookup');
    const prices = products(r.items).map((i) => i.price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    assert.match(r.log, /search "nothing": the store reports 0 result/);
});

test('categories, Special Buys URL, products by link/number, not-found product', async () => {
    const r = await runActor(base({
        categoryUrls: ['https://www.aldi.com.au/products/dairy-eggs-fridge/eggs/k/1111111162', 'https://www.aldi.com.au/special-buys/2026-09-26',
            'https://www.aldi.com.au/special-buys/2026-10-10'],
        productIds: ['https://www.aldi.com.au/product/lodge-farms-cage-eggs-700g-000000000000399451', '704511', '999999'],
        maxItemsPerSearch: 10,
    }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.equal(items.filter((i) => i.categoryUrl?.includes('/k/1111111162')).length, 10);
    const sb = items.filter((i) => i.categoryUrl?.includes('special-buys/2026-09-26'));
    assert.equal(sb.length, 3);
    assert.ok(sb.every((i) => i.isOnSpecial && i.promoType === 'SPECIAL_BUY'));
    assert.ok(srv.state.requests.some((q) => q.includes('promotionKey=2026-09-26')));
    assert.match(r.log, /Special Buys 2026-10-10: no products/);
    assert.ok(items.some((i) => i.productId === '000000000000399451' && i.productInput?.includes('/product/')));
    assert.ok(items.some((i) => i.productId === '000000000000704511' && i.wasPrice === 3.99));
    assert.ok(srv.state.requests.some((q) => q.includes('/v2/products?') && q.includes('skus=')), 'batch lookup');
    const errs = r.items.filter((i) => i.isError);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].productId, '999999');
    assert.match(errs[0].error, /not found on ALDI Australia/);
    assert.equal(r.output.failedTasks, 1);
});

test('onlySpecials: filters searches; with no inputs returns Special Buys + Super Savers + Lower Prices', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], onlySpecials: true }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.ok(items.length > 0 && items.every((i) => i.isOnSpecial), 'only price drops from the search');

    srv.reset();
    srv.state.specialDates = ['2026-09-23', '2026-09-26', '2026-09-30', '2026-10-03', ...Array.from({ length: 30 }, (_, i) => new Date(Date.now() + (i - 10) * 864e5).toISOString().slice(0, 10))];
    const s = await runActor(base({ onlySpecials: true }));
    assert.equal(s.code, 0, s.log);
    const all = products(s.items);
    assert.ok(all.every((i) => i.isOnSpecial));
    assert.ok(all.some((i) => i.promoType === 'SPECIAL_BUY'));
    assert.ok(all.some((i) => i.promoType === 'LOWER_PRICE'));
    assert.ok(all.some((i) => i.promoType === 'PRICE_DROP' || i.promoType === 'SUPER_SAVER'));
    assert.equal(srv.state.requests.filter((q) => q.includes('promotionKey=')).length, 4, 'last 2 + next 2 Special Buys days');
    assert.ok(srv.state.requests.some((q) => q.includes('/v2/product-category-tree')), 'special list keys checked against the live tree');
});

test('block → retry: Akamai 403 recovered on a new session; HTTP 500 retried; debug page saved', async () => {
    srv.state.blockApi = 1;
    srv.state.fail500 = 1;
    const r = await runActor(base({ searchTerms: ['eggs'], maxItemsPerSearch: 5, storeId: 'G452' }));
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 5);
    assert.match(r.log, /search "eggs" page 1: BLOCKED — HTTP 403, Akamai "Access Denied"/);
    assert.match(r.log, /Blocked with browser-like headers; retrying with minimal API headers on a new IP/);
    assert.match(r.log, /HTTP 500 \[500\] Internal error; retrying/);
    assert.equal(r.output.stores.aldi.sessions, 2);
    assert.equal(r.output.stores.aldi.blocks, 1);
    assert.ok(kvKeys(r.storageDir).some((k) => k.startsWith('DEBUG-aldi-blocked-1')));
});

test('API refuses browser-like headers → falls back to minimal API headers (aldiscount observation)', async () => {
    srv.state.blockBrowserUa = true;
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 3 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 3);
    assert.equal(r.output.stores.aldi.headerProfile, 'plain');
    assert.ok(srv.state.requests.some((q) => q.includes('ua=plain') && q.includes('/v3/product-search')));
});

test('API that requires a store id: the automatic store lookup satisfies it', async () => {
    srv.state.requireServicePoint = true;
    const r = await runActor(base({ searchTerms: ['milk'], storeId: '', maxRetries: 0, apiBaseUrl: srv.apiUrl }));
    // Lookup works in the mock, so the store id is found and the search succeeds.
    assert.equal(r.code, 0, r.log);
    assert.ok(products(r.items).length > 0);
});

test('permanent block: error rows, clear message, run fails when nothing worked', async () => {
    srv.state.alwaysBlock = true;
    const all = await runActor(base({ searchTerms: ['milk', 'bread', 'eggs'], maxRetries: 1, storeId: 'G452' }));
    assert.notEqual(all.code, 0);
    assert.match(all.log, /Nothing could be loaded: .*RESIDENTIAL with country AU/);
    assert.match(all.log, /Blocked on 2 inputs in a row; the remaining inputs are skipped/);
    const errs = all.items.filter((i) => i.isError);
    assert.equal(errs.length, 3);
    assert.ok(errs[0].blocked && errs[0].blockMarkers.some((m) => m.includes('Akamai')));
    assert.match(all.log, /search "milk" FAILED — step "search "milk" page 1", HTTP 403, anti-bot block/);
});

test('pay per event: stops at the max cost per run', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 50 }), {
        env: {
            APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { product: { eventPriceUsd: 0.001, eventTitle: 'Product' } } } }),
            APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
            ACTOR_MAX_TOTAL_CHARGE_USD: '7',
        },
    });
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 7);
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.match(r.log, /Stopped at your maximum cost per run/);
});

test('bad input fails fast with a clear message', async () => {
    const r1 = await runActor(base({}));
    assert.notEqual(r1.code, 0);
    assert.match(r1.log, /Invalid input: Nothing to do/);
    const r2 = await runActor(base({ categoryUrls: ['https://www.coles.com.au/browse/dairy'] }));
    assert.match(r2.log, /Invalid input: These "categoryUrls" are not ALDI Australia/);
    const r3 = await runActor(base({ searchTerms: ['milk'], sortBy: 'cheapest' }));
    assert.match(r3.log, /Invalid input: "sortBy" must be one of/);
});

test('browser: cookies from a real browser; escalation to in-browser requests', { skip: !CHROME && 'no Chrome found' }, async () => {
    srv.state.requireJsCookie = true;
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5, useBrowserForCookies: true, storeId: 'G452' }), { env: { BROWSER_EXECUTABLE_PATH: CHROME } });
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 5);
    assert.match(r.log, /Website loaded in the browser .*Cookies: .*aldi_js/);
    assert.equal(r.output.stores.aldi.strategy, 'browser-cookies');

    srv.reset();
    srv.state.requireJsCookie = true;
    const f = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5, browserFallback: true, storeId: 'G452' }), { env: { BROWSER_EXECUTABLE_PATH: CHROME } });
    assert.equal(f.code, 0, f.log);
    assert.equal(products(f.items).length, 5);
    assert.match(f.log, /keeps getting blocked; switching to requests from inside a real browser/);
    assert.equal(f.output.stores.aldi.strategy, 'browser-fetch');
});
