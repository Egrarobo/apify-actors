// Unit tests: normalisation of xapi product nodes, Clubcard/price-cut logic, queries, URL + input parsing, blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTesco, moneyIn, sizeFromTitle } from '../src/normalize.js';
import { classifyResponse } from '../src/blocks.js';
import { parseInput, InputError } from '../src/input.js';
import { tescoCategoryFromUrl, tescoProductFromUrl, facetForSlugs, facetFor, listingQuery, productsQuery, slugify } from '../src/store.js';
import { AKAMAI_PAGE } from './mock-server.mjs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tesco.json', import.meta.url), 'utf8'));
const node = (tpnc) => [...fx.searchNodes, ...fx.categoryNodes, ...fx.products].find((n) => n.tpnc === tpnc);
const UNIFIED = ['store', 'productId', 'name', 'brand', 'size', 'price', 'wasPrice', 'unitPrice', 'unitPriceText', 'promoText', 'loyaltyPrice',
    'isOnSpecial', 'inStock', 'category', 'imageUrl', 'url', 'searchTerm', 'currency', 'scrapedAt'];

test('search node with Clubcard Price (basketeer body)', () => {
    const r = normalizeTesco(node('254656543'), { searchTerm: 'milk', scrapedAt: 'T' });
    for (const k of UNIFIED) assert.ok(k in r, `missing ${k}`);
    assert.equal(r.store, 'tesco');
    assert.equal(r.productId, '254656543');
    assert.equal(r.tpnb, '54550994');
    assert.equal(r.name, 'Tesco British Semi Skimmed Milk 2.272L, 4 Pints');
    assert.equal(r.brand, 'TESCO');
    assert.equal(r.size, '2.272L, 4 Pints');
    assert.equal(r.price, 1.65);
    assert.equal(r.unitPrice, 0.73);
    assert.equal(r.unitPriceText, '£0.73/litre');
    assert.equal(r.loyaltyPrice, 2.25, 'the Clubcard price in the promotion text wins');
    assert.equal(r.isOnSpecial, true);
    assert.equal(r.promoType, 'CLUBCARD_PRICE');
    assert.equal(r.promoText, '£2.25 Clubcard Price');
    assert.equal(r.wasPrice, null);
    assert.equal(r.currency, 'GBP');
    assert.equal(r.url, 'https://www.tesco.com/shop/en-GB/products/254656543');
    assert.match(r.imageUrl, /^https:\/\/digitalcontent\.api\.tesco\.com\//);
});

test('Clubcard price from afterDiscount when the text has no amount; price cut; product node', () => {
    const cat = normalizeTesco(node('222'));
    assert.equal(cat.price, 0.17);
    assert.equal(cat.loyaltyPrice, 0.15, 'description "Clubcard Price" → afterDiscount');
    assert.equal(cat.unitPriceText, '£1.10/kg');

    const cut = normalizeTesco(node('299999001'));
    assert.equal(cut.wasPrice, 1.45);
    assert.equal(cut.savings, 0.2);
    assert.equal(cut.promoType, 'PRICE_CUT');
    assert.equal(cut.loyaltyPrice, null);
    assert.equal(cut.promoEndDate, '2026-10-10T23:59:59Z');

    const coke = normalizeTesco(node('282822189'));
    assert.equal(coke.price, 2.49);
    assert.equal(coke.size, '1750ml', 'details.packSize');
    assert.equal(coke.isOnSpecial, false);
    assert.equal(coke.promoText, null);
    assert.equal(coke.inStock, null, 'isForSale not in this body');

    const multi = normalizeTesco({ ...node('282822189'), promotions: [{ description: 'Any 3 for £10 Clubcard Price', attributes: ['CLUBCARD_PRICING'], price: { afterDiscount: null, beforeDiscount: null } }] });
    assert.equal(multi.loyaltyPrice, null, 'multibuy total is not a per-item Clubcard price');
    assert.equal(multi.promoType, 'CLUBCARD_MULTIBUY');
    assert.equal(multi.isOnSpecial, true);

    const withCats = normalizeTesco({ ...node('282822189'), superDepartmentName: 'Drinks', departmentName: 'Fizzy', aisleName: 'Cola', gtin: '5000112637922', isForSale: true });
    assert.equal(withCats.category, 'Drinks > Fizzy > Cola');
    assert.equal(withCats.gtin, '5000112637922');
    assert.equal(withCats.inStock, true);
});

test('helpers', () => {
    assert.equal(moneyIn('£2.25 Clubcard Price'), 2.25);
    assert.equal(moneyIn('80p Clubcard Price'), 0.8);
    assert.equal(moneyIn('Any 3 for £10 Clubcard Price'), 10);
    assert.equal(sizeFromTitle('Coca-Cola 1.75L'), '1.75L');
    assert.equal(sizeFromTitle('Tesco Bananas Loose'), null);
    assert.equal(sizeFromTitle('Walkers Crisps 6 x 25g'), '6 x 25g');
    assert.equal(slugify('Milk, Butter & Eggs'), 'milk-butter-and-eggs');
    assert.equal(facetFor('Fresh Food'), 'b;RnJlc2ggRm9vZA==', 'same as basketeer categoryFacet("Fresh Food")');
});

test('queries: basketeer field set always, extended fields only in the full set', () => {
    const basic = listingQuery('search', false);
    assert.match(basic, /search\(query: \$query, page: \$page, count: \$count\)/);
    assert.match(basic, /\.\.\. on ProductInterface/);
    assert.match(basic, /sellers \{ results \{ price \{ actual unitPrice unitOfMeasure \}/);
    assert.doesNotMatch(basic, /superDepartmentName|info \{/);
    assert.match(listingQuery('category', true), /category\(facet: \$facet.*\n\s*info \{ total/);
    const pq = productsQuery(2, false);
    assert.match(pq, /query GetProducts\(\$tpnc0: String!, \$tpnc1: String!\)/);
    assert.match(pq, /p1: product\(tpnc: \$tpnc1\)/);
    assert.match(pq, /details \{ packSize \{ value units \} \}/);
});

test('URL parsing and taxonomy resolution', () => {
    assert.deepEqual(tescoCategoryFromUrl('https://www.tesco.com/shop/en-GB/browse/fresh-food/all'), { type: 'category', slugs: ['fresh-food'] });
    assert.deepEqual(tescoCategoryFromUrl('https://www.tesco.com/groceries/en-GB/shop/fresh-food/milk-butter-and-eggs/milk'), { type: 'category', slugs: ['fresh-food', 'milk-butter-and-eggs', 'milk'] });
    assert.deepEqual(tescoCategoryFromUrl('https://www.tesco.com/shop/en-GB/category/bakery'), { type: 'category', slugs: ['bakery'] });
    assert.deepEqual(tescoCategoryFromUrl('https://www.tesco.com/groceries/en-GB/shop/fresh-food/all?facet=b;TWlsaw=='), { type: 'category', facet: 'b;TWlsaw==' });
    assert.equal(tescoCategoryFromUrl('https://www.tesco.com/shop/en-GB/zone/clubcard-prices'), null);
    assert.equal(tescoProductFromUrl('https://www.tesco.com/shop/en-GB/products/321525706'), '321525706');
    assert.equal(tescoProductFromUrl('https://www.tesco.com/groceries/en-GB/products/254656543'), '254656543');
    const tree = [{ name: 'Fresh Food', label: 'Fresh Food', children: [{ id: 'b;abc', name: 'Milk, Butter & Eggs', children: [] }] }];
    assert.deepEqual(facetForSlugs(tree, ['fresh-food']), { facet: 'b;RnJlc2ggRm9vZA==', name: 'Fresh Food', id: null });
    assert.equal(facetForSlugs(tree, ['fresh-food', 'milk-butter-and-eggs']).facet, 'b;abc');
    assert.equal(facetForSlugs(tree, ['frozen']), null);
});

test('block and API-key detection', () => {
    const b = classifyResponse({ status: 403, contentType: 'text/html', text: AKAMAI_PAGE });
    assert.equal(b.blocked, true);
    const k = classifyResponse({ status: 403, contentType: 'text/plain', text: 'Forbidden: Invalid Client' });
    assert.equal(k.apiKeyRejected, true);
    assert.equal(k.blocked, undefined, 'a rejected key is not an anti-bot block');
    const gqlErr = classifyResponse({ status: 400, contentType: 'application/json', text: '[{"errors":[{"message":"Cannot query field \\"x\\""}]}]' });
    assert.match(gqlErr.reason, /Cannot query field/);
    assert.equal(classifyResponse({ status: 200, contentType: 'application/json', text: '[{"data":{}}]' }).ok, true);
});

test('input parsing and validation', () => {
    const c = parseInput({
        searchTerms: ['milk', 'milk'],
        categoryUrls: ['https://www.tesco.com/shop/en-GB/browse/fresh-food/all'],
        productIds: ['254656543', 'tesco:282822189', 'https://www.tesco.com/shop/en-GB/products/321525706'],
    });
    assert.deepEqual(c.searchTerms, ['milk']);
    assert.deepEqual(c.products.map((p) => p.id), ['254656543', '282822189', '321525706']);
    assert.equal(c.requestDelayMs, 1000);
    assert.equal(parseInput({ onlyClubcardPrices: true }).onlySpecials, true, 'Clubcard-only implies offers-only');
    assert.throws(() => parseInput({}), /Nothing to do/);
    assert.throws(() => parseInput({ categoryUrls: ['https://www.tesco.com/shop/en-GB/zone/clubcard-prices'] }), /Only Clubcard Prices/);
    assert.throws(() => parseInput({ productIds: ['milk'] }), InputError);
    assert.throws(() => parseInput({ searchTerms: ['x'], apiKey: 'short' }), /apiKey/);
});
