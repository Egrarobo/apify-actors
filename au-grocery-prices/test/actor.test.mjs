// End-to-end tests: run src/main.js as a child process against the local mock Coles/Woolworths servers.
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
    colesBaseUrl: srv.colesUrl,
    woolworthsBaseUrl: srv.woolUrl,
    useBrowserForCookies: false,
    browserFallback: false,
    requestDelayMs: 0,
    proxyConfiguration: { useApifyProxy: false },
    ...extra,
});
const products = (items) => items.filter((i) => !i.isError);
const byStore = (items, s) => products(items).filter((i) => i.store === s);
const kvKeys = (dir) => {
    const d = path.join(dir, 'key_value_stores', 'default');
    return existsSync(d) ? readdirSync(d) : [];
};

const CHROME = process.env.BROWSER_EXECUTABLE_PATH
    || ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'].find((p) => existsSync(p));

test('search both stores: unified schema, pagination, sponsored rows skipped, no duplicates', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 70 }));
    assert.equal(r.code, 0, r.log);
    const c = byStore(r.items, 'coles');
    const w = byStore(r.items, 'woolworths');
    assert.equal(c.length, 70, 'Coles: 2 pages of 48 needed');
    assert.equal(w.length, 50, 'Woolworths: all 50 organic results (2 pages of 36), stops on the sponsored-only page');
    for (const i of [...c, ...w]) {
        for (const k of ['store', 'productId', 'name', 'brand', 'size', 'price', 'wasPrice', 'unitPrice', 'unitPriceText', 'isOnSpecial',
            'promoText', 'inStock', 'category', 'imageUrl', 'url', 'searchTerm', 'scrapedAt']) assert.ok(k in i, `${i.store} missing ${k}`);
        assert.equal(i.searchTerm, 'milk');
        assert.equal(i.isSponsored, false);
    }
    assert.equal(new Set(c.map((i) => i.productId)).size, c.length);
    assert.equal(new Set(w.map((i) => i.productId)).size, w.length);
    assert.ok(srv.state.coles.requests.some((q) => q.includes('page=2')), 'Coles page 2 requested');
    assert.equal(r.output.products, 120);
    assert.equal(r.output.failedTasks, 0);
});

test('sponsored rows can be included; maxItemsPerSearch; no results', async () => {
    const r = await runActor(base({ searchTerms: ['milk', 'nothing'], includeSponsored: true, maxItemsPerSearch: 10, stores: ['woolworths'] }));
    assert.equal(r.code, 0, r.log);
    const w = byStore(r.items, 'woolworths');
    assert.equal(w.length, 10);
    assert.ok(w.some((i) => i.isSponsored), 'sponsored row kept');
    assert.equal(byStore(r.items, 'coles').length, 0, 'only the selected store');
    assert.match(r.log, /search "nothing": the store reports 0 result/);
});

test('onlySpecials: filters searches; with no inputs returns the specials lists', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], onlySpecials: true }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.isOnSpecial), 'every item is on special');
    assert.ok(byStore(r.items, 'woolworths').some((i) => i.productId === '49622' && i.promoType === 'HALF_PRICE'));

    srv.reset();
    const s = await runActor(base({ onlySpecials: true }));
    assert.equal(s.code, 0, s.log);
    assert.ok(srv.state.coles.requests.some((q) => q.includes('/en/on-special.json')), 'Coles specials route used');
    assert.ok(byStore(s.items, 'coles').length > 0 && byStore(s.items, 'woolworths').length > 0);
    assert.ok(products(s.items).every((i) => i.isOnSpecial));
});

test('categories and products (URL, prefixed id, bare id with redirect, not found)', async () => {
    const r = await runActor(base({
        categoryUrls: ['https://www.coles.com.au/browse/dairy-eggs-fridge', 'https://www.woolworths.com.au/shop/browse/bakery/packaged-bread-bakery',
            'https://www.woolworths.com.au/shop/browse/no-such-aisle'],
        productIds: ['https://www.coles.com.au/product/coles-cheese-shredded-tasty-light-700g-8145346', 'coles:6604351', 'woolworths:277728', '999999'],
        maxItemsPerSearch: 5,
    }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.equal(items.filter((i) => i.categoryUrl?.includes('coles.com.au/browse/dairy-eggs-fridge')).length, 5);
    assert.equal(items.filter((i) => i.categoryUrl?.includes('woolworths.com.au/shop/browse/bakery')).length, 5);
    assert.ok(items.some((i) => i.store === 'coles' && i.productId === '8145346'));
    assert.ok(items.some((i) => i.store === 'coles' && i.productId === '6604351'), 'bare coles id resolved via redirect');
    assert.ok(items.some((i) => i.store === 'woolworths' && i.productId === '277728'));
    const errs = r.items.filter((i) => i.isError);
    assert.ok(errs.some((e) => e.categoryUrl?.includes('no-such-aisle') && /not found in the Woolworths category tree/.test(e.error)));
    assert.equal(errs.filter((e) => e.productId === '999999').length, 2, 'unknown bare id → one error row per store');
    assert.equal(r.output.failedTasks, 3);
});

test('block → retry: Imperva page and Akamai 403 recovered with new sessions; debug page saved', async () => {
    srv.state.coles.blockData = 1;
    srv.state.woolworths.blockApi = 1;
    srv.state.woolworths.fail500 = 1;
    const r = await runActor(base({ searchTerms: ['bread'], maxItemsPerSearch: 5 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(byStore(r.items, 'coles').length, 5);
    assert.equal(byStore(r.items, 'woolworths').length, 5);
    assert.match(r.log, /\[Coles\] search "bread" page 1: BLOCKED — HTTP 200, Imperva/);
    assert.match(r.log, /\[Woolworths\] search "bread" page 1: BLOCKED — HTTP 403, Akamai "Access Denied"/);
    assert.match(r.log, /HTTP 500; retrying/);
    assert.equal(r.output.stores.coles.blocks, 1);
    assert.equal(r.output.stores.woolworths.sessions, 2, 'new session after the block');
    assert.ok(kvKeys(r.storageDir).some((k) => k.startsWith('DEBUG-coles-blocked-1')), 'block page saved for diagnosis');
});

test('stale buildId (Coles deploys mid-run) → buildId refreshed, run continues', async () => {
    srv.state.coles.rotateBuildAfter = 1;
    const r = await runActor(base({ stores: ['coles'], searchTerms: ['milk'], maxItemsPerSearch: 60 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(byStore(r.items, 'coles').length, 60);
    assert.match(r.log, /a data route answered 404/);
    assert.ok(srv.state.coles.requests.some((q) => q.includes('/test-build-2/')));
});

test('permanent block: error rows, clear message, run fails only when nothing worked', async () => {
    srv.state.coles.alwaysBlock = true;
    const partial = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 3, maxRetries: 1 }));
    assert.equal(partial.code, 0, 'Woolworths still worked');
    const err = partial.items.find((i) => i.isError && i.store === 'coles');
    assert.equal(err.blocked, true);
    assert.equal(err.searchTerm, 'milk');
    assert.ok(err.blockMarkers?.some((m) => m.includes('Imperva')));
    assert.match(partial.log, /\[Coles\] search "milk" FAILED — step "search "milk" page 1", HTTP 200, anti-bot block/);

    srv.reset();
    srv.state.coles.alwaysBlock = true;
    srv.state.woolworths.alwaysBlock = true;
    const all = await runActor(base({ searchTerms: ['milk', 'bread', 'eggs'], maxRetries: 1 }));
    assert.notEqual(all.code, 0);
    assert.match(all.log, /Nothing could be loaded: .*RESIDENTIAL with country AU/);
    assert.match(all.log, /Blocked on 2 inputs in a row; the remaining Coles inputs are skipped/);
    assert.equal(all.items.filter((i) => i.isError).length, 6);
});

test('pay per event: stops at the max cost per run', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 50 }), {
        env: {
            APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { product: { eventPriceUsd: 0.001, eventTitle: 'Product' } } } }),
            APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
            // Locally the SDK prices every event at $1 so the budget can be reached: $7 = 7 products.
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
    const r2 = await runActor(base({ categoryUrls: ['https://www.aldi.com.au/groceries'] }));
    assert.match(r2.log, /Invalid input: These "categoryUrls" are not Coles or Woolworths category pages/);
    const r3 = await runActor(base({ stores: ['iga'], searchTerms: ['milk'] }));
    assert.match(r3.log, /Invalid input: Unknown store/);
});

test('browser: Coles cookies from a real browser; Woolworths escalates to in-browser requests', { skip: !CHROME && 'no Chrome found' }, async () => {
    srv.state.coles.requireJsCookie = true; // data routes need a cookie that only JavaScript sets (like reese84)
    srv.state.woolworths.requireJsCookie = true;
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5, useBrowserForCookies: true, browserFallback: true }), {
        env: { BROWSER_EXECUTABLE_PATH: CHROME },
    });
    assert.equal(r.code, 0, r.log);
    assert.equal(byStore(r.items, 'coles').length, 5);
    assert.equal(byStore(r.items, 'woolworths').length, 5);
    assert.match(r.log, /\[Coles\] Homepage loaded in the browser .*Cookies: .*reese84/);
    assert.match(r.log, /\[Woolworths\] .*plain HTTP keeps getting blocked; switching to requests from inside a real browser/);
    assert.equal(r.output.stores.coles.strategy, 'browser-cookies');
    assert.equal(r.output.stores.woolworths.strategy, 'browser-fetch');

    // Without the browser, Coles cannot get the JS cookie → blocked, reported per search.
    srv.reset();
    srv.state.coles.requireJsCookie = true;
    const nb = await runActor(base({ stores: ['coles'], searchTerms: ['milk'], maxRetries: 1 }));
    assert.notEqual(nb.code, 0);
    assert.match(nb.log, /BLOCKED/);
});
