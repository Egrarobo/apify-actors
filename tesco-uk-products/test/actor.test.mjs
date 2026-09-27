// End-to-end tests: run src/main.js as a child process against the local mock Tesco xapi.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { startMockServer, NEW_KEY, FACETS } from './mock-server.mjs';
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

test('default input (prefill "milk"): unified schema, GraphQL batch request shape, pagination, categories', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 100 }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.equal(items.length, 100);
    for (const i of items) {
        for (const k of ['store', 'productId', 'name', 'brand', 'size', 'price', 'wasPrice', 'unitPrice', 'unitPriceText', 'promoText', 'loyaltyPrice',
            'isOnSpecial', 'inStock', 'category', 'imageUrl', 'url', 'searchTerm', 'currency', 'scrapedAt']) assert.ok(k in i, `missing ${k}`);
        assert.equal(i.store, 'tesco');
        assert.equal(i.currency, 'GBP');
    }
    assert.equal(new Set(items.map((i) => i.productId)).size, 100);
    assert.equal(items[0].category, 'Fresh Food > Milk, Butter & Eggs > Milk > Fresh Milk');
    assert.equal(items[0].loyaltyPrice, 2.25);
    const searches = srv.state.ops.filter((o) => o.name === 'Search');
    assert.deepEqual(searches.map((o) => o.variables.page), [1, 2, 3]);
    assert.ok(searches.every((o) => o.variables.count === 48 && o.mfeName === 'mfe-plp' && o.full));
    assert.ok(srv.state.requests.every((q) => q.includes('key=TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA') && q.includes('region=UK')));
    assert.match(r.log, /search "milk": the store reports 130 result\(s\)/);
    assert.match(r.log, /First product: "Tesco British Semi Skimmed Milk 2\.272L, 4 Pints" — £1\.65 \(Clubcard £2\.25\)/);
    assert.equal(r.output.stores.tesco.fieldSet, 'full');
});

test('API rejects extended fields → basic field set (HTTP 400 and HTTP 200 variants), no totals', async () => {
    for (const status of [400, 200]) {
        srv.reset();
        srv.state.basicSchemaOnly = true;
        srv.state.schemaErrorStatus = status;
        const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 60 }));
        assert.equal(r.code, 0, r.log);
        assert.equal(products(r.items).length, 60);
        assert.equal(products(r.items)[0].category, null);
        assert.match(r.log, /does not accept the extended fields .*Cannot query field/);
        assert.match(r.log, /result\(s\) on page 1 \(the API gave no total\)/);
        assert.equal(r.output.stores.tesco.fieldSet, 'basic');
    }
});

test('pagination stops when the API ignores page; no results; small max uses a small page', async () => {
    srv.state.ignorePage = true;
    const r = await runActor(base({ searchTerms: ['milk', 'nothing'], maxItemsPerSearch: 500 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 48, 'second page had nothing new → stop');
    assert.match(r.log, /search "nothing": the store reports 0 result/);
    srv.reset();
    const s = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5 }));
    assert.equal(products(s.items).length, 5);
    assert.equal(srv.state.ops[0].variables.count, 5);
});

test('categories (slug via taxonomy, facet URL), products (batch, unknown id)', async () => {
    const r = await runActor(base({
        categoryUrls: ['https://www.tesco.com/shop/en-GB/browse/fresh-food/all', 'https://www.tesco.com/groceries/en-GB/shop/fresh-food/milk-butter-and-eggs',
            `https://www.tesco.com/groceries/en-GB/shop/bakery/all?facet=${FACETS.bakery}`, 'https://www.tesco.com/shop/en-GB/browse/frozen-food/all'],
        productIds: ['https://www.tesco.com/shop/en-GB/products/282822189', '275280804', '999999999'],
        maxItemsPerSearch: 10,
    }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.equal(items.filter((i) => i.categoryUrl?.includes('browse/fresh-food/all')).length, 10);
    assert.equal(items.filter((i) => i.categoryUrl?.endsWith('milk-butter-and-eggs')).length, 10);
    assert.equal(items.filter((i) => i.categoryUrl?.includes('facet=')).length, 1);
    const cats = srv.state.ops.filter((o) => o.name === 'GetCategoryProducts').map((o) => o.variables.facet);
    assert.ok(cats.includes(FACETS.freshFood) && cats.includes(FACETS.milkButterEggs) && cats.includes(FACETS.bakery));
    assert.equal(srv.state.ops.filter((o) => o.name === 'Taxonomy').length, 1, 'taxonomy loaded once');
    const coke = items.find((i) => i.productId === '282822189');
    assert.equal(coke.size, '1750ml');
    assert.ok(items.some((i) => i.productId === '275280804'));
    assert.equal(srv.state.ops.filter((o) => o.name === 'GetProducts').length, 1, 'one aliased request for all products');
    const errs = r.items.filter((i) => i.isError);
    assert.ok(errs.some((e) => e.categoryUrl?.includes('frozen-food') && /not found in the Tesco category tree/.test(e.error)));
    assert.ok(errs.some((e) => e.productId === '999999999' && /not found on Tesco/.test(e.error)));
});

test('onlySpecials / onlyClubcardPrices: filters; with no inputs scans all departments', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], onlySpecials: true, maxItemsPerSearch: 1000 }));
    assert.equal(r.code, 0, r.log);
    const items = products(r.items);
    assert.ok(items.length > 0 && items.length < 130 && items.every((i) => i.isOnSpecial));

    srv.reset();
    const c = await runActor(base({ onlyClubcardPrices: true, maxItemsPerSearch: 1000 }));
    assert.equal(c.code, 0, c.log);
    const cc = products(c.items);
    assert.ok(cc.length > 0 && cc.every((i) => i.promoType.includes('CLUBCARD')));
    assert.match(c.log, /Scanning 2 department\(s\) for offers: Fresh Food, Bakery/);
    assert.deepEqual(srv.state.ops.filter((o) => o.name === 'GetCategoryProducts').map((o) => o.variables.facet).filter((f, i, a) => a.indexOf(f) === i), [FACETS.freshFood, FACETS.bakery]);
});

test('rotated API key: 403 "Invalid Client" → new key read from the website → run continues', async () => {
    srv.state.apiKey = NEW_KEY;
    srv.state.siteKey = NEW_KEY;
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 5);
    assert.match(r.log, /"Invalid Client" \(the API key was rejected\)/);
    assert.match(r.log, /Found a new public API key on the website \(plain HTTP\): NewR…fXYZ/);
    assert.equal(r.output.stores.tesco.apiKeySource, 'website (plain HTTP)');

    srv.reset();
    srv.state.apiKey = NEW_KEY; // website still shows the old key
    const bad = await runActor(base({ searchTerms: ['milk'] }));
    assert.notEqual(bad.code, 0);
    assert.match(bad.log, /No new API key found\. Set "apiKey" in the input/);
    assert.equal(bad.items.find((i) => i.isError).blocked, false);

    srv.reset();
    srv.state.apiKey = NEW_KEY;
    const given = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 3, apiKey: NEW_KEY }));
    assert.equal(given.code, 0, given.log);
    assert.equal(given.output.stores.tesco.apiKeySource, 'input');
});

test('block → retry: Akamai 403 and 429 recovered; debug page saved', async () => {
    srv.state.blockApi = 1;
    srv.state.rate429 = 1;
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 5);
    assert.match(r.log, /search "milk" page 1: BLOCKED — HTTP 403, Akamai "Access Denied"/);
    assert.match(r.log, /BLOCKED — HTTP 429 \(rate limited\)/);
    assert.equal(r.output.stores.tesco.sessions, 2);
    assert.equal(r.output.stores.tesco.rateLimited, 1);
    assert.ok(kvKeys(r.storageDir).some((k) => k.startsWith('DEBUG-tesco-blocked-1')));
});

test('permanent block: error rows, clear message, run fails when nothing worked', async () => {
    srv.state.alwaysBlock = true;
    const all = await runActor(base({ searchTerms: ['milk', 'bread', 'eggs'], maxRetries: 1 }));
    assert.notEqual(all.code, 0);
    assert.match(all.log, /Nothing could be loaded: .*RESIDENTIAL with country GB/);
    assert.match(all.log, /Blocked on 2 inputs in a row; the remaining inputs are skipped/);
    assert.equal(all.items.filter((i) => i.isError).length, 3);
});

test('pay per event: stops at the max cost per run', async () => {
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 50 }), {
        env: {
            APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { product: { eventPriceUsd: 0.0015, eventTitle: 'Product' } } } }),
            APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
            ACTOR_MAX_TOTAL_CHARGE_USD: '7',
        },
    });
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 7);
    assert.equal(r.output.stoppedAtCostLimit, true);
});

test('bad input fails fast with a clear message', async () => {
    const r1 = await runActor(base({}));
    assert.match(r1.log, /Invalid input: Nothing to do/);
    const r2 = await runActor(base({ categoryUrls: ['https://www.sainsburys.co.uk/gol-ui/groceries/dairy'] }));
    assert.match(r2.log, /Invalid input: These "categoryUrls" are not Tesco category pages/);
    assert.notEqual(r2.code, 0);
});

test('browser: cookies from a real browser; escalation to in-browser requests', { skip: !CHROME && 'no Chrome found' }, async () => {
    srv.state.requireJsCookie = true;
    const r = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5, useBrowserForCookies: true }), { env: { BROWSER_EXECUTABLE_PATH: CHROME } });
    assert.equal(r.code, 0, r.log);
    assert.equal(products(r.items).length, 5);
    assert.match(r.log, /Website loaded in the browser .*Cookies: .*tesco_js/);

    srv.reset();
    srv.state.requireJsCookie = true;
    const f = await runActor(base({ searchTerms: ['milk'], maxItemsPerSearch: 5, browserFallback: true }), { env: { BROWSER_EXECUTABLE_PATH: CHROME } });
    assert.equal(f.code, 0, f.log);
    assert.equal(products(f.items).length, 5);
    assert.equal(f.output.stores.tesco.strategy, 'browser-fetch');
});
