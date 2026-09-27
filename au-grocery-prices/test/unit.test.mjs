// Unit tests: normalisation of real product objects, block detection, input parsing, category resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeColes, normalizeWoolworths, flattenWoolworths, isColesAdTile } from '../src/normalize.js';
import { classifyResponse, findBlockMarkers } from '../src/blocks.js';
import { parseInput, InputError } from '../src/input.js';
import { categoryIdForSlug, searchBody } from '../src/stores/woolworths.js';
import { parseColesHome, colesCategoryFromUrl, colesProductFromUrl } from '../src/stores/coles.js';
import { AKAMAI_PAGE, IMPERVA_PAGE } from './mock-server.mjs';

const coles = JSON.parse(readFileSync(new URL('./fixtures/coles.json', import.meta.url), 'utf8'));
const wool = JSON.parse(readFileSync(new URL('./fixtures/woolworths.json', import.meta.url), 'utf8'));
const UNIFIED = ['store', 'productId', 'name', 'brand', 'size', 'price', 'wasPrice', 'unitPrice', 'unitPriceText', 'isOnSpecial', 'promoText',
    'inStock', 'category', 'imageUrl', 'url', 'searchTerm', 'scrapedAt'];

test('Coles: everyday product (real object)', () => {
    const r = normalizeColes(coles.products.find((p) => p.id === 8145346), { searchTerm: 'cheese', scrapedAt: 'T' });
    for (const k of UNIFIED) assert.ok(k in r, `missing ${k}`);
    assert.equal(r.name, 'Coles Cheese Shredded Tasty Light');
    assert.equal(r.size, '700g');
    assert.equal(r.price, 9.5);
    assert.equal(r.wasPrice, null, 'was = 0 means no was-price');
    assert.equal(r.unitPrice, 13.57);
    assert.equal(r.unitPriceText, '$13.57 per 1kg');
    assert.equal(r.isOnSpecial, false);
    assert.equal(r.inStock, true);
    assert.equal(r.category, 'Dairy, Eggs & Fridge > Cheese > Grated Cheese');
    assert.equal(r.imageUrl, 'https://productimages.coles.com.au/productimages/8/8145346.jpg');
    assert.equal(r.url, 'https://www.coles.com.au/product/coles-cheese-shredded-tasty-light-700g-8145346');
});

test('Coles: specials, down-down, sponsored, unavailable, ad tile', () => {
    const special = normalizeColes(coles.products.find((p) => p.pricing?.promotionType === 'SPECIAL' && !p.adId));
    assert.equal(special.isOnSpecial, true);
    assert.ok(special.wasPrice > special.price);
    assert.ok(special.promoText, 'save statement present');
    const dd = normalizeColes(coles.products.find((p) => p.pricing?.promotionType === 'DOWNDOWN'));
    assert.equal(dd.promoType, 'DOWNDOWN');
    assert.equal(dd.isOnSpecial, dd.wasPrice !== null);
    assert.match(dd.promoText ?? '', /Was \$/);
    assert.equal(dd.isSponsored, true, 'adId → sponsored');
    const un = normalizeColes(coles.products.at(-1));
    assert.equal(un.price, null);
    assert.equal(un.inStock, false);
    assert.equal(isColesAdTile(coles.adTile), true);
    // Product page object has the same shape.
    const pd = normalizeColes(coles.productDetail);
    assert.equal(pd.price, 0.9);
    assert.equal(pd.wasPrice, 1);
    assert.equal(pd.promoText, 'save $0.10');
});

test('Woolworths: wrappers, was-price only when greater, half price, sponsored', () => {
    const payload = { Products: wool.products.map((p) => ({ Products: [p], Name: p.Name })), SearchResultsCount: 12 };
    const flat = flattenWoolworths(payload);
    assert.equal(flat.length, 12);
    assert.equal(flattenWoolworths({ Bundles: payload.Products }).length, 12);
    assert.equal(flattenWoolworths([wool.products[0]]).length, 1);
    const bread = normalizeWoolworths(wool.products.find((p) => p.Stockcode === 277728), { searchTerm: 'bread' });
    for (const k of UNIFIED) assert.ok(k in bread, `missing ${k}`);
    assert.equal(bread.wasPrice, null, 'WasPrice == Price is not a discount');
    assert.equal(bread.isOnSpecial, false);
    assert.equal(bread.unitPriceText, '$0.38 / 100G');
    assert.equal(bread.barcode, '9339687336265');
    assert.equal(bread.url, 'https://www.woolworths.com.au/shop/productdetails/277728/woolworths-white-sandwich-bread-loaf');
    const crumpets = normalizeWoolworths(wool.products.find((p) => p.Stockcode === 49622));
    assert.equal(crumpets.price, 2);
    assert.equal(crumpets.wasPrice, 4.8);
    assert.equal(crumpets.isOnSpecial, true);
    assert.equal(crumpets.promoType, 'HALF_PRICE');
    assert.equal(crumpets.promoText, 'Half price · Save $2.80');
    assert.equal(normalizeWoolworths(wool.products.find((p) => p.IsSponsoredAd)).isSponsored, true);
});

test('block detection: Imperva, Akamai (raw escaped), JSON ok, HTML instead of JSON', () => {
    assert.deepEqual(classifyResponse('coles', { status: 200, contentType: 'application/json', text: '{"pageProps":{}}' }), { ok: true });
    const c = classifyResponse('coles', { status: 200, contentType: 'text/html', text: IMPERVA_PAGE });
    assert.equal(c.blocked, true);
    assert.ok(c.markers.some((m) => m.includes('Pardon Our Interruption')));
    const w = classifyResponse('woolworths', { status: 403, contentType: 'text/html', text: AKAMAI_PAGE });
    assert.equal(w.blocked, true);
    assert.ok(findBlockMarkers('woolworths', AKAMAI_PAGE).includes('Akamai edgesuite error reference'), 'escaped punctuation still matched');
    const html = classifyResponse('woolworths', { status: 200, contentType: 'text/html', text: '<html><title>Woolworths</title></html>' });
    assert.equal(html.blocked, true, 'HTML where JSON was expected counts as a block');
    assert.equal(classifyResponse('coles', { status: 404, text: '' }).notFound, true);
    assert.equal(classifyResponse('coles', { status: 503, text: '' }).retryable, true);
    assert.equal(classifyResponse('coles', { status: 429, text: '' }).rateLimited, true);
    assert.equal(findBlockMarkers('woolworths', '<html>… akamai …</html>').length, 0, '"akamai" alone is not a block marker');
});

test('Coles homepage parsing: buildId, API key from __RUNTIME_CONFIG__, blocked page', () => {
    const html = `<script>window.__RUNTIME_CONFIG__={"BFF_API_SUBSCRIPTION_KEY":"k1"};</script>
<script id="__NEXT_DATA__" type="application/json">{"buildId":"20260901.1-abc","props":{"pageProps":{"initialState":{"trolley":{"storeId":"0584"}}}}}</script>`;
    assert.deepEqual(parseColesHome(html), { buildId: '20260901.1-abc', apiKey: 'k1', storeId: '0584' });
    assert.throws(() => parseColesHome(IMPERVA_PAGE), /no __NEXT_DATA__/);
});

test('URL parsing and category resolution', () => {
    assert.deepEqual(colesCategoryFromUrl('https://www.coles.com.au/browse/dairy-eggs-fridge/cheese'), { type: 'category', slugParts: ['dairy-eggs-fridge', 'cheese'] });
    assert.deepEqual(colesCategoryFromUrl('https://www.coles.com.au/on-special'), { type: 'specials' });
    assert.deepEqual(colesProductFromUrl('https://www.coles.com.au/product/appy-fizz-250ml-8060378'), { slug: 'appy-fizz-250ml-8060378', id: '8060378' });
    assert.deepEqual(categoryIdForSlug(wool.categories, 'bakery/packaged-bread-bakery'), { id: '1_A6D1FC1', name: 'Packaged Bread & Bakery' });
    assert.equal(categoryIdForSlug(wool.categories, 'bakery/nope'), null);
    assert.equal(searchBody('milk', 2).PageNumber, 2);
});

test('input parsing', () => {
    const cfg = parseInput({
        searchTerms: ['milk', ' milk ', ''],
        categoryUrls: ['https://www.woolworths.com.au/shop/browse/fruit-veg', 'coles.com.au/browse/frozen'],
        productIds: ['coles:8145346', 'https://www.woolworths.com.au/shop/productdetails/277728/x', '123456'],
    });
    assert.deepEqual(cfg.stores, ['coles', 'woolworths']);
    assert.deepEqual(cfg.searchTerms, ['milk']);
    assert.equal(cfg.categories.length, 2);
    assert.equal(cfg.products.length, 4, 'bare number → both stores');
    assert.equal(cfg.useBrowserForCookies, true);
    assert.deepEqual(cfg.proxyConfiguration, { useApifyProxy: true });
    assert.throws(() => parseInput({}), InputError);
    assert.throws(() => parseInput({ stores: ['aldi'], searchTerms: ['x'] }), /Unknown store/);
    assert.throws(() => parseInput({ categoryUrls: ['https://example.com/browse/x'] }), /not Coles or Woolworths/);
    assert.throws(() => parseInput({ productIds: ['hello'] }), /Could not understand/);
    assert.equal(parseInput({ onlySpecials: true }).onlySpecials, true);
});
