// End-to-end: run src/main.js as a child process against a local mock serving real saved answers.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-server.mjs';
import { runActor } from './helpers.mjs';

let srv;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());
const run = (input, env = {}) => runActor({ requestDelaySecs: 1, ...input }, { env: { ATC_BASE_URL: srv.url, ATC_FIRST_WAIT_MS: '50', ...env } });

test('domain search with details: ads, regions, links, filters sent to Google', async () => {
    const r = await run({ searchTerms: ['nike.com'], region: 'US', format: 'text', period: 'custom', startDate: '2026-09-01', endDate: '2026-09-30', maxAdsPerQuery: 3 });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 3);
    const search = srv.state.requests.find((q) => q.path.endsWith('SearchCreatives'));
    assert.deepEqual(search.freq['3'], { 4: 1, 6: 20260901, 7: 20260930, 8: [2840], 12: { 1: 'nike.com', 2: true } });
    assert.equal(srv.state.requests.filter((q) => q.path.endsWith('GetCreativeById')).length, 3, 'one detail request per ad');
    const a = r.items[0];
    for (const k of ['advertiserName', 'advertiserId', 'adId', 'format', 'firstShown', 'lastShown', 'regions', 'imageUrl', 'adUrl', 'advertiserUrl', 'scrapedAt']) assert.ok(a[k] !== null && a[k] !== undefined, `${k} present`);
    assert.deepEqual(a.regions, ['US']);
    assert.deepEqual(a.regionNames, ['United States']);
    assert.equal(a.variantCount, 3);
    assert.equal(a.adUrl, `https://adstransparency.google.com/advertiser/${a.advertiserId}/creative/${a.adId}?region=US`);
    assert.equal(r.output.adsStored, 3);
    assert.deepEqual(r.output.queries[0].adsReported, { min: 8000, max: 9000 });
});

test('advertiser name → suggestions → ads; pagination with the next-page token; no details', async () => {
    const r = await run({ searchTerms: ['Nike, Inc.'], maxAdsPerQuery: 8, includeDetails: false });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 8);
    assert.match(r.log, /"Nike, Inc\." → advertiser "Nike, Inc\." \(AR16735076323512287233, US, exact name\)/);
    const searches = srv.state.requests.filter((q) => q.path.endsWith('SearchCreatives'));
    assert.equal(searches.length, 2);
    assert.deepEqual(searches[0].freq['3']['13'], { 1: ['AR16735076323512287233'] });
    assert.ok(searches[1].freq['4'], 'page 2 sends the token');
    assert.equal(srv.state.requests.filter((q) => q.path.endsWith('GetCreativeById')).length, 0);
    assert.equal(r.items[0].regions, null);
    assert.equal(new Set(r.items.map((i) => i.adId)).size, 8);
});

test('unknown advertiser name and empty region are reported, not fatal', async () => {
    const r = await run({ searchTerms: ['Adidas', 'nike.com'], region: 'MD', maxAdsPerQuery: 2 });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 0);
    assert.match(r.log, /"Adidas": no advertiser with this name/);
    assert.match(r.log, /no ads found for these filters/);
    assert.equal(r.output.failures.length, 1);
});

test('rate-limit page: waits and retries on the same IP, then continues', async () => {
    srv.state.blockNext = 2;
    const r = await run({ searchTerms: ['nike.com'], maxAdsPerQuery: 2, includeDetails: false });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2);
    assert.match(r.log, /Google asked to slow down/);
    assert.equal(r.output.requests.blockedAnswers, 2);
});

test('persistent block from the first request: no IP change, run fails with a clear message', async () => {
    srv.state.blockAlways = true;
    const r = await run({ searchTerms: ['nike.com'], maxAdsPerQuery: 2, maxBlockWaitSecs: 0 });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /rate-limit page and the wait limit was reached/);
    assert.equal(r.items.length, 0);
});

test('pay-per-event: stops at the maximum charge and charges one "ad" event per stored ad', async () => {
    const r = await run({ searchTerms: ['nike.com'], maxAdsPerQuery: 10, includeDetails: false }, {
        // Outside the platform the SDK counts 1 USD per event, so 3 USD = 3 ads.
        ACTOR_MAX_TOTAL_CHARGE_USD: '3',
        APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { ad: { eventPrice: 1, eventTitle: 'Ad', eventDescription: 'x' } } } }),
        ACTOR_TEST_PAY_PER_EVENT: 'true',
    });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 3, '3 USD / 1 USD per ad = 3 ads');
    assert.equal(r.output.stoppedAtCostLimit, true);
});

test('invalid input fails with a clear message', async () => {
    const r = await run({ searchTerms: ['nike.com'], region: 'Narnia' });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /Invalid input: Unknown "region" "Narnia"/);
});
