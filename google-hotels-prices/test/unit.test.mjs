// Unit tests: request builders and parsers, on real captured Google data (test/fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTs, buildQs, buildSearchUrl, buildRpcInner, buildRpcBody, parseEntityId, locationFromQuery } from '../src/request.js';
import {
    parseSearchPayload, parseDetailPayload, parseSearchHtml, classifyResponse, decodeBatchExecute, parsePriceText, extractInitData, RpcDecodeError,
} from '../src/parse.js';
import { parseInput, parseDay, buildFilter, limitProxy, InputError } from '../src/input.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const search = fx('search-nyc.json');
const detail = fx('detail-manhattan.json');

test('ts/qs protobufs are byte-identical to google-hotels-python build_ts/build_qs', () => {
    // Expected values produced by running janik4321sdfa/google-hotels-python core.py (Python) with the same arguments.
    assert.equal(buildTs({ location: 'Prague', checkIn: '2026-11-12', checkOut: '2026-11-14', adults: 3, currency: 'EUR' }),
        'CAEaKAoKEgg6BlByYWd1ZRIaEhQKBwjqDxALGAwSBwjqDxALGA4YAjICCAMqBwoFOgNFVVI');
    assert.equal(buildQs('CBI='), 'EgRDQkk9OA0');
    const u = new URL(buildSearchUrl('https://www.google.com', { query: 'hotels in Paris', checkIn: '2026-11-12', checkOut: '2026-11-13', adults: 2, currency: 'EUR', language: 'fr', country: 'fr', pageToken: 'CBI=' }));
    assert.equal(u.pathname, '/travel/search');
    assert.equal(u.searchParams.get('hl'), 'fr');
    assert.equal(u.searchParams.get('gl'), 'fr');
    assert.equal(u.searchParams.get('curr'), 'EUR');
    assert.equal(u.searchParams.get('qs'), 'EgRDQkk9OA0');
    assert.equal(locationFromQuery('hotels in Paris'), 'Paris');
    assert.equal(locationFromQuery('Hotels near Times Square'), 'Times Square');
});

test('RPC payload matches the shape captured by stays (entity id at meta[5], children as age buckets)', () => {
    const inner = buildRpcInner({ query: 'hotels', checkIn: '2026-09-01', checkOut: '2026-09-04', adults: 2, childrenAges: [], currency: 'USD', entityId: 'ChkIabc' });
    assert.deepEqual(inner[1][2][1][1], [[2026, 9, 1], [2026, 9, 4], 3]);
    assert.equal(inner[1][1], null, 'default party = null extras block');
    assert.equal(inner[1][4][0][6], 'USD');
    assert.deepEqual(inner[2], [1, null, null, null, null, 'ChkIabc', 13, null, 0]);
    const kids = buildRpcInner({ query: 'x', checkIn: '2026-09-01', checkOut: '2026-09-02', adults: 1, childrenAges: [5, 15], currency: 'EUR' });
    assert.deepEqual(kids[1][1], [[[3], [2, 12], [13, 17]], 1]);
    const body = buildRpcBody(inner);
    assert.ok(body.startsWith('f.req=%5B%5B%5B%22AtySUc%22'));
});

test('entity ids are extracted from Google Hotels links', () => {
    assert.equal(parseEntityId('https://www.google.com/travel/hotels/entity/ChoIxPKIzoX4zIfLARoNL2cvMTFwd2g1N2c1NRAB?q=x'), 'ChoIxPKIzoX4zIfLARoNL2cvMTFwd2g1N2c1NRAB');
    assert.equal(parseEntityId('https://www.google.com/travel/hotels/New%20York/entity/ChkIooCAqvyy0fDgARoML2cvMWhoZ18zbWdzEAE/prices'), 'ChkIooCAqvyy0fDgARoML2cvMWhoZ18zbWdzEAE');
    assert.equal(parseEntityId('ChkIooCAqvyy0fDgARoML2cvMWhoZ18zbWdzEAE'), 'ChkIooCAqvyy0fDgARoML2cvMWhoZ18zbWdzEAE');
    assert.equal(parseEntityId('https://www.booking.com/hotel/x.html'), null);
});

test('search payload: 18 real NYC hotels with prices, taxes, rating, class, GPS, page token', () => {
    const r = parseSearchPayload(search, { nights: 2 });
    assert.equal(r.hotels.length, 18);
    assert.equal(r.nextPageToken, 'CBI=');
    assert.equal(r.totalResults, 1135);
    assert.equal(r.resolvedLocation, 'New York');
    assert.equal(r.locationRecognized, true);
    const h = r.hotels.find((x) => x.hotelName === 'Mayfair Inn and Suites');
    assert.equal(h.entityId, 'ChoI07j2vbif2oC7ARoNL2cvMTF4Zng3X253NRAB');
    assert.equal(h.pricePerNight, 67.57);
    assert.equal(h.pricePerNightText, '$68');
    assert.equal(h.pricePerNightWithTaxes, 79.97);
    assert.equal(h.priceBeforeTaxes, 52.7);
    assert.equal(h.taxes, 12.4);
    assert.equal(h.fees, 14.87);
    // The fixture's rate is for 1 night (rateDates 27–28 Apr 2026), so the total is the 1-night total even if 2 were asked.
    assert.equal(h.priceTotal, 79.97, 'total = stay total from the breakdown (1 night in this capture)');
    assert.equal(h.currency, 'USD');
    assert.equal(h.rating, 2.8);
    assert.equal(h.reviews, 66);
    assert.equal(h.hotelClass, 2);
    assert.ok(Math.abs(h.lat - 40.756887) < 1e-6 && Math.abs(h.lng + 73.942305) < 1e-6);
    assert.equal(h.website, 'http://www.mayfairinnny.com/');
    assert.equal(h.checkInTime, '3:00 PM');
    assert.match(h.thumbnail, /^https:\/\/lh\d\.googleusercontent\.com\//);
    assert.match(h.googleMapsUrl, /^https:\/\/maps\.google\.com\/\?cid=\d+$/);
    const noClass = r.hotels.find((x) => x.hotelName === 'Moon Hotel Brooklyn');
    assert.equal(noClass.hotelClass, null, 'hotels without an official class are kept');
});

test('detail payload: address, phone, description, deal and 36 provider offers with official-site flag', () => {
    const h = parseDetailPayload(detail, { nights: 1 });
    assert.equal(h.hotelName, 'The Manhattan at Times Square Hotel');
    assert.equal(h.address, '790 7th Ave, New York, NY 10019');
    assert.equal(h.phone, '(212) 581-3300');
    assert.equal(h.dealLabel, '20% less than usual');
    assert.equal(h.offers.length, 36);
    const prices = h.offers.map((o) => o.price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'sorted cheapest first');
    const official = h.offers.filter((o) => o.isOfficialSite);
    assert.equal(official.length, 1);
    assert.equal(official[0].provider, 'The Manhattan at Times Square Hotel');
    assert.equal(official[0].price, 158);
    assert.match(official[0].directUrl, /^https:\/\/www\.ihg\.com\//);
    const booking = h.offers.find((o) => o.provider === 'Booking.com');
    assert.equal(booking.price, 158);
    assert.equal(booking.priceWithTaxes, 184.81);
    assert.match(booking.url, /^https:\/\/www\.google\.com\//);
    assert.ok(h.offers.some((o) => o.isSponsored), 'ad rows (/aclk links) are flagged as sponsored');
    assert.ok(h.offers.find((o) => o.provider === 'Expedia.com').rooms?.length >= 1, 'room names/rates from featured rows');
});

test('search HTML: ds:0 blob is found among several AF_initDataCallback blobs', () => {
    const html = `<html><script>AF_initDataCallback({key: 'ds:1', hash: '2', data:[1,2], sideChannel: {}});</script>`
        + `<script nonce="x">AF_initDataCallback({key: 'ds:0', hash: '7', data:${JSON.stringify(search)}, sideChannel: {}});</script></html>`;
    const { keys } = extractInitData(html);
    assert.deepEqual(keys, ['ds:1', 'ds:0']);
    const r = parseSearchHtml(html);
    assert.equal(r.parserPath, 'html:ds:0');
    assert.equal(r.hotels.length, 18);
    const empty = parseSearchHtml('<html><body>nothing</body></html>');
    assert.equal(empty.parserPath, 'html:no-blobs');
});

test('batchexecute decoding: frame, empty payload, garbage', () => {
    const payload = JSON.stringify([['wrb.fr', 'AtySUc', JSON.stringify([1, ['a"b']]), null, null, null, 'generic']]);
    assert.deepEqual(decodeBatchExecute(`)]}'\n\n${payload.length}\n${payload}\n`, 'AtySUc'), [1, ['a"b']]);
    const nul = JSON.stringify([['wrb.fr', 'AtySUc', null, null, null, [3], 'generic']]);
    assert.throws(() => decodeBatchExecute(`)]}'\n\n10\n${nul}\n`, 'AtySUc'), RpcDecodeError);
    assert.throws(() => decodeBatchExecute('<html>sorry</html>', 'AtySUc'), /No AtySUc frame/);
});

test('page classification: consent, captcha, blocked, ok', () => {
    assert.equal(classifyResponse({ status: 200, url: 'https://consent.google.com/ml?continue=x', text: '<html></html>' }).kind, 'consent');
    assert.equal(classifyResponse({ status: 200, url: 'https://www.google.com/travel/search', text: '<form action="https://consent.google.de/save">' }).kind, 'consent');
    assert.equal(classifyResponse({ status: 429, url: 'https://www.google.com/sorry/index?continue=x', text: '' }).kind, 'captcha');
    assert.equal(classifyResponse({ status: 200, url: 'https://www.google.com/travel/search', text: 'Our systems have detected unusual traffic from your computer network' }).kind, 'captcha');
    assert.equal(classifyResponse({ status: 403, url: 'https://www.google.com/travel/search', text: '' }).kind, 'blocked');
    assert.equal(classifyResponse({ status: 200, url: 'https://www.google.com/travel/search', text: '<a href="https://consent.google.com/">privacy</a>' }).kind, 'ok', 'a consent link alone is not a consent page');
});

test('price text parsing across locales', () => {
    const cases = [['$1,234', 1234], ['1.234 €', 1234], ['€ 99,50', 99.5], ['$42', 42], ['₹12,345', 12345], ['1 234,56 kr', 1234.56], ['CHF 1’250.40', 1250.4], ['', null], ['free', null]];
    for (const [s, v] of cases) assert.equal(parsePriceText(s), v, s);
});

test('input: defaults, relative dates, validation messages', () => {
    const now = Date.parse('2026-09-27T10:00:00Z');
    const c = parseInput({ queries: ['hotels in Rome'] }, { now });
    assert.equal(c.checkIn, '2026-10-27');
    assert.equal(c.checkOut, '2026-10-28');
    assert.equal(c.nights, 1);
    assert.equal(c.adults, 2);
    assert.equal(c.currency, 'USD');
    assert.equal(parseDay('+3 days', 'x', now), '2026-09-30');
    const k = parseInput({ queries: ['x'], checkInDate: '2026-12-01', nights: 3, children: 2, currency: 'eur' }, { now });
    assert.equal(k.checkOut, '2026-12-04');
    assert.deepEqual(k.childrenAges, [8, 8]);
    assert.equal(k.currency, 'EUR');
    const bad = [
        [{}, /at least one search/],
        [{ queries: ['x'], checkInDate: '2026-01-01' }, /in the past/],
        [{ queries: ['x'], checkInDate: '2026-12-05', checkOutDate: '2026-12-01' }, /must be after/],
        [{ queries: ['x'], checkInDate: 'next friday' }, /not a valid date/],
        [{ queries: ['x'], currency: 'dollars' }, /3-letter/],
        [{ hotelUrls: ['https://www.booking.com/hotel/fr/x.html'] }, /not Google Hotels hotel links/],
        [{ queries: ['x'], children: 1, childrenAges: ['5', '7'] }, /one age per child/],
        [{ queries: ['x'], minPrice: 300, maxPrice: 100 }, /higher than/],
        [{ queries: ['x'], hotelClass: ['6'] }, /1 to 5/],
    ];
    for (const [input, re] of bad) assert.throws(() => parseInput(input, { now }), (e) => e instanceof InputError && re.test(e.message), JSON.stringify(input));
});

test('filters: price, rating, class', () => {
    const f = buildFilter({ minPrice: 50, maxPrice: 100, minRating: 3.5, hotelClass: [3, 4] });
    assert.equal(f({ pricePerNight: 80, rating: 4, hotelClass: 3 }), true);
    assert.equal(f({ pricePerNight: 40, rating: 4, hotelClass: 3 }), false);
    assert.equal(f({ pricePerNight: null, rating: 4, hotelClass: 3 }), false);
    assert.equal(f({ pricePerNight: 80, rating: 3.4, hotelClass: 3 }), false);
    assert.equal(f({ pricePerNight: 80, rating: 4, hotelClass: null }), false);
});

test('proxy: Apify RESIDENTIAL and GOOGLE_SERP groups are removed, other groups and own proxy URLs are kept', () => {
    let r = limitProxy({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'], apifyProxyCountry: 'US' });
    assert.deepEqual(r.removedGroups, ['RESIDENTIAL']);
    assert.deepEqual(r.proxy, { useApifyProxy: true, apifyProxyCountry: 'US' });
    r = limitProxy({ useApifyProxy: true, apifyProxyGroups: ['GOOGLE_SERP'] });
    assert.deepEqual(r.removedGroups, ['GOOGLE_SERP']);
    assert.deepEqual(r.proxy, { useApifyProxy: true });
    r = limitProxy({ useApifyProxy: true, apifyProxyGroups: ['residential', 'google_serp'] });
    assert.deepEqual(r.removedGroups, ['RESIDENTIAL', 'GOOGLE_SERP']);
    assert.equal(r.proxy.apifyProxyGroups, undefined);
    r = limitProxy({ useApifyProxy: true, apifyProxyGroups: ['GOOGLE_SERP', 'SHADER'] });
    assert.deepEqual(r.proxy.apifyProxyGroups, ['SHADER']);
    r = limitProxy({ useApifyProxy: true });
    assert.deepEqual(r.removedGroups, []);
    r = limitProxy({ useApifyProxy: false, proxyUrls: ['http://u:p@my-residential.example:8000'] });
    assert.deepEqual(r.removedGroups, []);
    assert.deepEqual(r.proxy.proxyUrls, ['http://u:p@my-residential.example:8000']);
    assert.deepEqual(limitProxy(null).removedGroups, []);
});

test('multi-night stay: the price breakdown is for the whole stay and is divided per night (Lisbon, 3 nights, 10 Oct 2026)', () => {
    // Same real entry, with the rate block changed to the shape Google returned for a 3-night stay on 10 Oct 2026:
    // display $140 per night (140.44), breakdown [421.32, 52.18, 0, 473.5] = whole stay (421.32 = 3 × 140.44).
    const tree = structuredClone(search);
    let entry = null;
    (function walk(n) {
        if (entry) return;
        if (Array.isArray(n)) { if (n[1] === 'Mayfair Inn and Suites' && Array.isArray(n[6])) { entry = n; return; } n.forEach(walk); }
        else if (n && typeof n === 'object') Object.values(n).forEach(walk);
    })(tree);
    assert.ok(entry, 'fixture entry found');
    entry[6][2][1] = ['$140', '$158', 140.44, null, 140];
    entry[6][2][8] = [[2026, 12, 18], [2026, 12, 21], 3, null, 0];
    entry[6][2][44] = [421.32, 52.18, 0, 473.5];
    const h = parseSearchPayload(tree, { nights: 3 }).hotels.find((x) => x.hotelName === 'Mayfair Inn and Suites');
    assert.equal(h.pricePerNight, 140.44);
    assert.equal(h.pricePerNightWithTaxes, 157.83);
    assert.equal(h.priceBeforeTaxes, 140.44);
    assert.equal(h.taxes, 17.39);
    assert.equal(h.priceTotal, 473.5, 'not 3 × 473.5');
});
