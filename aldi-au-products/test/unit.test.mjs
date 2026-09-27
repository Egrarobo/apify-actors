// Unit tests: normalisation (real platform object + AU values), block detection, input parsing, URL parsing, helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAldi, imageUrlOf, moneyFrom, padSku } from '../src/normalize.js';
import { classifyResponse, findBlockMarkers } from '../src/blocks.js';
import { parseInput, InputError } from '../src/input.js';
import { aldiListingFromUrl, aldiSkuFromUrl, pageLimit, specialBuysDates } from '../src/store.js';
import { AKAMAI_PAGE } from './mock-server.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/aldi.json', import.meta.url), 'utf8'));
const bySku = (s) => fx.products.find((p) => p.sku === padSku(s));
const UNIFIED = ['store', 'productId', 'name', 'brand', 'size', 'price', 'wasPrice', 'unitPrice', 'unitPriceText', 'promoText', 'loyaltyPrice',
    'isOnSpecial', 'inStock', 'category', 'imageUrl', 'url', 'searchTerm', 'currency', 'scrapedAt'];

test('real captured platform object (api.aldi-suisse.ch) normalises without loss', () => {
    const r = normalizeAldi(fx.platformSample, { scrapedAt: 'T' });
    for (const k of UNIFIED) assert.ok(k in r, `missing ${k}`);
    assert.equal(r.productId, '000000000000525709');
    assert.equal(r.name, 'RETOUR AUX SOURCES Milch Drink', 'brand prefixed (API name excludes brand)');
    assert.equal(r.size, '1 l');
    assert.equal(r.price, 1.85, 'integer cents → 1.85');
    assert.equal(r.currency, 'CHF');
    assert.equal(r.wasPrice, null);
    assert.equal(r.category, 'Retour aux sources (Bio) > Milch & Milchprodukte');
    assert.deepEqual(r.badges, ['Gekühlt']);
    assert.equal(r.imageUrl, 'https://dm.emea.cms.aldi.cx/is/image/aldiprodeu/product/jpg/scaleWidth/600/95625f16-a901-453b-853d-3c19b9d3cb4c');
    assert.equal(r.inStock, true, 'notForSale=true is normal for walk-in offers');
});

test('AU everyday product: price, unit price, url, category', () => {
    const r = normalizeAldi(bySku('399451'), { searchTerm: 'eggs', scrapedAt: 'T' });
    assert.equal(r.store, 'aldi');
    assert.equal(r.name, 'LODGE FARMS Cage Eggs 700g');
    assert.equal(r.brand, 'LODGE FARMS');
    assert.equal(r.price, 5);
    assert.equal(r.unitPrice, 0.71);
    assert.equal(r.unitPriceText, '$0.71 per 100g');
    assert.equal(r.unitPriceMeasure, '100g');
    assert.equal(r.isOnSpecial, false);
    assert.equal(r.promoType, null);
    assert.equal(r.loyaltyPrice, null);
    assert.equal(r.currency, 'AUD');
    assert.equal(r.category, 'Dairy, Eggs & Fridge > Eggs');
    assert.equal(r.url, 'https://www.aldi.com.au/product/lodge-farms-cage-eggs-700g-000000000000399451', 'matches the live site link');
    assert.equal(r.searchTerm, 'eggs');
});

test('price drop, Special Buy, list context, discontinued', () => {
    const drop = normalizeAldi(bySku('704511'));
    assert.equal(drop.wasPrice, 3.99);
    assert.equal(drop.savings, 0.5);
    assert.equal(drop.isOnSpecial, true);
    assert.equal(drop.promoType, 'PRICE_DROP');
    assert.match(drop.promoText, /Was \$3\.99/);

    const sb = normalizeAldi(bySku('657233'), { listType: 'special-buys' });
    assert.equal(sb.isOnSpecial, true);
    assert.equal(sb.promoType, 'SPECIAL_BUY');
    assert.equal(sb.availableFrom, 'Available from Sat 26th September');
    assert.match(sb.promoText, /While Stocks Last/);
    assert.equal(sb.unitPrice, null);

    const sbFromSearch = normalizeAldi(bySku('657233'));
    assert.equal(sbFromSearch.promoType, 'SPECIAL_BUY', 'onSaleDateDisplay marks a Special Buy even without list context');

    const ss = normalizeAldi(bySku('398596'), { listType: 'lower-prices' });
    assert.equal(ss.promoType, 'LOWER_PRICE');
    assert.equal(ss.isOnSpecial, true);

    const gone = normalizeAldi(fx.products.find((p) => p.discontinued));
    assert.equal(gone.inStock, false);
});

test('helpers: money parsing, sku padding, image placeholders, page limits, Special Buys dates', () => {
    assert.equal(moneyFrom('$3.99'), 3.99);
    assert.equal(moneyFrom('2,49 €'), 2.49);
    assert.equal(moneyFrom(null), null);
    assert.equal(padSku('399451'), '000000000000399451');
    assert.equal(imageUrlOf({ assets: [{ url: 'https://x/{width}/abc/{slug}', maxWidth: 400, assetType: 'FR01' }] }), 'https://x/400/abc');
    assert.equal(imageUrlOf({ assets: [] }), null);
    assert.equal(pageLimit(5), 12);
    assert.equal(pageLimit(50), 60);
    assert.equal(pageLimit(500), 60);
    // Sat 26 Sep 2026 and Wed 30 Sep 2026 are drop days (seen on aldi.com.au).
    const d = specialBuysDates(new Date('2026-09-27T02:00:00Z'));
    assert.deepEqual(d, ['2026-09-23', '2026-09-26', '2026-09-30', '2026-10-03']);
    for (const x of d) assert.ok([3, 6].includes(new Date(`${x}T00:00:00Z`).getUTCDay()));
});

test('URL parsing', () => {
    assert.deepEqual(aldiListingFromUrl('https://www.aldi.com.au/products/dairy-eggs-fridge/eggs/k/1111111162'), { type: 'category', key: '1111111162', slug: 'dairy-eggs-fridge/eggs' });
    assert.deepEqual(aldiListingFromUrl('https://www.aldi.com.au/products/dairy-eggs-fridge/k/960000000?page=4'), { type: 'category', key: '960000000', slug: 'dairy-eggs-fridge' });
    assert.deepEqual(aldiListingFromUrl('https://www.aldi.com.au/special-buys/2026-09-30'), { type: 'specialBuys', date: '2026-09-30' });
    assert.equal(aldiListingFromUrl('https://www.aldi.com.au/en/groceries/'), null);
    assert.equal(aldiSkuFromUrl('https://www.aldi.com.au/product/lodge-farms-cage-eggs-700g-000000000000399451'), '000000000000399451');
    assert.equal(aldiSkuFromUrl('https://www.aldi.com.au/products/x/k/1'), null);
});

test('block detection', () => {
    const b = classifyResponse({ status: 403, contentType: 'text/html', text: AKAMAI_PAGE });
    assert.equal(b.blocked, true);
    assert.ok(b.markers.includes('Akamai "Access Denied" page'));
    assert.equal(classifyResponse({ status: 200, contentType: 'text/html', text: '<html>Just a moment...</html>' }).blocked, true);
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', text: '{"data":[]}' }).ok, true);
    const apiErr = classifyResponse({ status: 400, contentType: 'application/json', text: '{"errors":[{"code":"3731","message":"Invalid limit"}]}' });
    assert.equal(apiErr.blocked, undefined);
    assert.equal(apiErr.retryable, false);
    assert.match(apiErr.reason, /\[3731\] Invalid limit/);
    assert.deepEqual(findBlockMarkers('<html><body>Welcome</body></html>'), []);
});

test('input parsing and validation', () => {
    const c = parseInput({
        searchTerms: ['milk', 'milk', ' eggs '],
        categoryUrls: ['https://www.aldi.com.au/products/pantry/k/970000000', 'www.aldi.com.au/special-buys/2026-10-03'],
        productIds: ['399451', 'aldi:704511', 'https://www.aldi.com.au/product/gardenline-solar-spot-light-000000000000657233'],
    });
    assert.deepEqual(c.searchTerms, ['milk', 'eggs']);
    assert.equal(c.listings.length, 2);
    assert.deepEqual(c.skus.map((s) => s.sku), ['000000000000399451', '000000000000704511', '000000000000657233']);
    assert.equal(c.maxItemsPerSearch, 100);
    assert.equal(c.useBrowserForCookies, false);
    assert.throws(() => parseInput({}), /Nothing to do/);
    assert.ok(parseInput({ onlySpecials: true }).onlySpecials);
    assert.throws(() => parseInput({ categoryUrls: ['https://www.coles.com.au/browse/x'] }), InputError);
    assert.throws(() => parseInput({ productIds: ['abc'] }), /Could not understand/);
    assert.throws(() => parseInput({ searchTerms: ['x'], sortBy: 'cheap' }), /sortBy/);
    assert.throws(() => parseInput({ searchTerms: ['x'], storeId: 'bad id!' }), /storeId/);
    assert.equal(parseInput({ searchTerms: ['x'], maxItemsPerSearch: 999999 }).maxItemsPerSearch, 20000);
});
