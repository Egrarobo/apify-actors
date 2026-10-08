// End-to-end tests: run src/main.js as a child process against the local mock of Google Hotels.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, MANHATTAN_ID } from './mock-server.mjs';
import { runActor, CHROME_PATH } from './helpers.mjs';

let srv;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const base = (extra = {}) => ({ baseUrl: srv.url, useBrowser: 'never', maxRetries: 2, ...extra });
const NYC = 'hotels in New York';

test('search: paginates with the qs token and stops at maxHotelsPerQuery', async () => {
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 25 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 25);
    assert.equal(r.output.queries[0].pages, 2);
    const searches = srv.state.requests.filter((q) => q.startsWith('GET /travel/search'));
    assert.equal(searches.length, 2);
    assert.match(searches[1], /[?&]qs=EgRDQkk9OA0/, 'page 2 uses the cursor built from token "CBI="');
    assert.match(searches[1], /[?&]ap=MAE/);
    const first = r.items[0];
    for (const k of ['query', 'hotelName', 'entityId', 'url', 'rating', 'reviews', 'hotelClass', 'lat', 'lng', 'pricePerNight', 'priceLowest', 'currency', 'checkIn', 'checkOut', 'thumbnail', 'scrapedAt']) {
        assert.ok(first[k] !== undefined && first[k] !== null, `field ${k} present`);
    }
    assert.equal(first.offers, undefined, 'no offers unless includeOffers');
    assert.deepEqual(r.items.map((i) => i.position), Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal(new Set(r.items.map((i) => i.entityId)).size, 25, 'no duplicates');
    assert.match(r.log, /parser=html:ds:0 blobs=\[ds:1,ds:0,ds:2\] hotels=18 nextPage=yes total=1135/);
    assert.match(r.log, /consent=no captcha=no/);
});

test('search: small limit reads one page; last page ends pagination', async () => {
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 5 }));
    assert.equal(r.items.length, 5);
    assert.equal(r.output.queries[0].pages, 1);
    const all = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 500 }));
    assert.equal(all.items.length, 30, '18 + 12 hotels, page 2 has no next token');
    assert.match(all.log, /no more result pages/);
});

test('filters: price, rating and class are applied and keep paging for matches', async () => {
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 100, minRating: '3.5', hotelClass: ['2', '3'], maxPrice: 85 }));
    assert.equal(r.code, 0, r.log);
    assert.ok(r.items.length > 0);
    for (const i of r.items) {
        assert.ok(i.rating >= 3.5 && [2, 3].includes(i.hotelClass) && i.pricePerNight <= 85, JSON.stringify(i));
    }
    assert.ok(r.output.filteredOut > 0);
});

test('offers: per-provider prices via the RPC, charged as extra event', async () => {
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 3, includeOffers: true, maxOffersPerHotel: 5 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 3);
    for (const i of r.items) {
        assert.equal(i.offersCount, 36);
        assert.equal(i.offers.length, 5, 'maxOffersPerHotel');
        assert.equal(i.cheapestProvider, i.offers[0].provider);
        assert.equal(i.officialSitePrice, 158);
        assert.match(i.dataSource, /\+rpc:AtySUc$/);
    }
    // The detail RPC carried the entity id at meta[5] and the stay dates.
    const detailReqs = srv.state.rpcBodies.filter((b) => b[2][5]);
    assert.equal(detailReqs.length, 3);
    assert.deepEqual(detailReqs.map((b) => b[2][5]).sort(), r.items.map((i) => i.entityId).sort());
    assert.equal(r.output.offersCharged, 3);
});

test('offers: RPC broken → hotel prices page fallback', async () => {
    srv.state.detailRpcBroken = true;
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 2, includeOffers: true, maxRetries: 0 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2);
    for (const i of r.items) assert.equal(i.offersCount, 36);
    assert.ok(srv.state.requests.some((q) => /GET \/travel\/hotels\/entity\/.+\/prices/.test(q)));
    assert.match(r.log, /parser=entity-html:ds:3 blobs=\[ds:0,ds:3\] offers=36/);
});

test('captcha / "unusual traffic": detected, retried with a new session, then succeeds', async () => {
    srv.state.captchaNext = 2;
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 3, maxRetries: 3 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 3);
    assert.equal(r.output.requests.captchaPages, 2);
    assert.equal(r.output.requests.retries, 2);
    assert.match(r.log, /attempt 1\/4 via http session=gh_\w+ proxy=none: status=429 .*captcha=YES.*→ captcha/);
    assert.ok(r.kvKeys.some((k) => k.startsWith('DEBUG-1-')), 'first blocked response saved for inspection');
});

test('captcha on every try and no browser: run fails with a clear proxy hint', async () => {
    srv.state.captchaNext = 1000;
    const r = await runActor(base({ queries: [NYC], maxRetries: 1 }));
    assert.notEqual(r.code, 0);
    assert.match(r.log, /could not be read for any of the 1 input/);
    assert.match(r.log, /keep the browser fallback on, run fewer hotels per run, try again later, or add your own proxy URLs/);
    assert.doesNotMatch(r.log, /RESIDENTIAL|GOOGLE_SERP/);
});

test('search page without data → falls back to the RPC search method', async () => {
    srv.state.searchPageBroken = true;
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 20, maxRetries: 0 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 20, '18 from RPC page 1 + 2 from RPC page 2 (token in meta[1])');
    assert.match(r.log, /page method failed .*trying the rpc method/);
    assert.match(r.log, /parser=html:no-blobs/);
    assert.equal(r.items[0].dataSource, 'rpc/http');
});

test('children switch the search to the RPC with age buckets', async () => {
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 2, adults: 1, children: 2, childrenAges: ['4', '14'] }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2);
    assert.deepEqual(srv.state.rpcBodies[0][1][1], [[[3], [2, 12], [13, 17]], 1]);
});

test('unrecognized location: warning, no items, no failure', async () => {
    const r = await runActor(base({ queries: ['hotels in Nowhereville'] }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 0);
    assert.match(r.log, /did not recognize this location/);
});

test('hotel names: best match is returned, unknown names are skipped', async () => {
    const r = await runActor(base({ hotelNames: ['Mayfair Inn & Suites New York', 'Ritz Paris Place Vendome'] }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].hotelName, 'Mayfair Inn and Suites');
    assert.ok(r.items[0].matchScore >= 0.5);
    assert.equal(r.output.failures.length, 1);
    assert.match(r.log, /"Ritz Paris Place Vendome": no confident match/);
});

test('hotel links: details via RPC; offers only when requested', async () => {
    const url = `https://www.google.com/travel/hotels/entity/${MANHATTAN_ID}?q=x`;
    const r = await runActor(base({ hotelUrls: [url], includeOffers: true }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 1);
    const h = r.items[0];
    assert.equal(h.hotelName, 'The Manhattan at Times Square Hotel');
    assert.equal(h.address, '790 7th Ave, New York, NY 10019');
    assert.equal(h.offersCount, 36);
    assert.equal(h.entityId, MANHATTAN_ID);
    const noOffers = await runActor(base({ hotelUrls: [MANHATTAN_ID] }));
    assert.equal(noOffers.items[0].offers, undefined);
    assert.equal(noOffers.output.offersCharged, 0);
});

// Outside the platform the SDK counts the remaining budget at 1 USD per event but the spent amount at the configured
// price, so the test prices are 1 USD to keep both consistent: ACTOR_MAX_TOTAL_CHARGE_USD=N allows N events.
const ppeEnv = (maxUsd) => ({
    ACTOR_TEST_PAY_PER_EVENT: 'true',
    ACTOR_MAX_TOTAL_CHARGE_USD: String(maxUsd),
    APIFY_ACTOR_PRICING_INFO: JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: { hotel: { eventTitle: 'Hotel', eventPriceUsd: 1 }, 'hotel-offers': { eventTitle: 'Hotel offers', eventPriceUsd: 1 } } },
    }),
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
});

test('pay-per-event: stops cleanly at the spending limit', async () => {
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 100 }), { env: ppeEnv(4.5) });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 4);
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.equal(r.output.requests.requests, 1, 'no further pages requested after the budget is used');
    assert.match(r.log, /Stopped at your maximum cost per run/);
});

test('pay-per-event with offers: budget is split into hotel + offers pairs', async () => {
    // 5 USD at 1 USD per event = 2 hotels with offers (4 events); the 5th dollar can't buy another pair.
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 100, includeOffers: true, maxConcurrency: 1 }), { env: ppeEnv(5) });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2);
    assert.equal(r.output.hotelsCharged, 2);
    assert.equal(r.output.offersCharged, 2);
    for (const i of r.items) assert.equal(i.offersCount, 36);
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.equal(srv.state.rpcBodies.length, 2, 'no offers loaded that could not be paid for');
});

test('bad input fails with a clear message', async () => {
    const cases = [
        [{}, /at least one search/],
        [{ queries: ['x'], checkInDate: '2020-01-01' }, /in the past/],
        [{ queries: ['x'], currency: 'euro' }, /3-letter/],
        [{ hotelUrls: ['https://www.booking.com/hotel/fr/x.html'] }, /not Google Hotels hotel links/],
        [{ queries: ['x'], baseUrl: 'ftp://x' }, /baseUrl/],
    ];
    for (const [input, re] of cases) {
        const r = await runActor({ useBrowser: 'never', ...input, baseUrl: input.baseUrl ?? srv.url });
        assert.notEqual(r.code, 0, `should fail: ${JSON.stringify(input)}`);
        assert.match(r.log, /Invalid input/);
        assert.match(r.log, re);
    }
});

test('consent page: HTTP detects it, real browser clicks "Accept all" and continues', { skip: !CHROME_PATH && 'no local Chrome' }, async () => {
    srv.state.consent = 'always';
    const r = await runActor(base({ queries: [NYC], maxHotelsPerQuery: 20, useBrowser: 'fallback', maxRetries: 1, includeOffers: true, maxConcurrency: 1 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 20, 'both pages read in the browser');
    assert.match(r.log, /consent=YES/);
    assert.match(r.log, /Switching to a real Chrome browser/);
    assert.match(r.log, /\[browser\] Google consent page detected .* clicking/);
    assert.equal(r.output.requests.switchedToBrowser, true);
    assert.ok(r.output.requests.consentPages >= 2);
    assert.equal(r.items[0].dataSource, 'page/browser+rpc:AtySUc', 'offers RPC posted from inside the browser page');
    assert.equal(r.items[0].offersCount, 36);
});

test('consent page with browser disabled: fails and says why', async () => {
    srv.state.consent = 'always';
    const r = await runActor(base({ queries: [NYC], maxRetries: 0 }));
    assert.notEqual(r.code, 0);
    assert.match(r.log, /cookie consent page/);
});
