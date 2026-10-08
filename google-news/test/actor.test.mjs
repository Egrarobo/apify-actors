// End-to-end: src/main.js as a child process against the local mock of news.google.com.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-server.mjs';
import { runActor } from './helpers.mjs';

let srv;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const env = (extra = {}) => ({ env: { GN_BASE_URL: srv.url, ...extra } });
const base = (extra = {}) => ({ proxyConfiguration: { useApifyProxy: false }, requestDelayMs: 0, maxRetries: 2, ...extra });
const ppeEnv = (maxUsd) => ({
    ACTOR_TEST_PAY_PER_EVENT: 'true',
    ACTOR_MAX_TOTAL_CHARGE_USD: String(maxUsd),
    APIFY_ACTOR_PRICING_INFO: JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { article: { eventTitle: 'Article', eventPriceUsd: 1 }, 'publisher-details': { eventTitle: 'Details', eventPriceUsd: 1 } } } }),
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
});

test('search query: articles with real URLs (decoded in one batch, answers out of order)', async () => {
    const r = await runActor(base({ queries: ['OpenAI'], maxArticlesPerFeed: 10 }), env());
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 10);
    assert.equal(r.items[0].rank, 1);
    const a = r.items.find((i) => i.source === 'CNBC');
    assert.equal(a.feedType, 'search');
    assert.equal(a.feed, 'OpenAI');
    assert.equal(a.title, 'Nvidia, Oracle, CoreWeave and other AI stocks sink on OpenAI revenue report');
    assert.equal(a.source, 'CNBC');
    assert.equal(a.urlDecoded, true);
    assert.equal(a.articleUrl, `${srv.url}/pub/${a.articleId.slice(-12)}`, 'each answer mapped back to its own article');
    for (const it of r.items) assert.equal(it.articleUrl, `${srv.url}/pub/${it.articleId.slice(-12)}`);
    assert.deepEqual(srv.state.batches, [10]);
    assert.ok(srv.state.requests[0].startsWith('GET /rss/search?q=OpenAI&hl=en-US&gl=US&ceid=US%3Aen'));
    assert.equal(r.output.articlesPushed, 10);
    assert.equal(r.output.urlsDecoded, 10);
    // sorted newest first
    const dates = r.items.map((i) => Date.parse(i.publishedAt));
    assert.deepEqual(dates, [...dates].sort((x, y) => y - x));
});

test('topic + location feeds follow the 302 redirect; duplicates across feeds are skipped; related coverage on request', async () => {
    const r = await runActor(base({ topics: ['BUSINESS'], locations: ['Chicago'], decodeUrls: false, includeRelatedCoverage: true }), env());
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.filter((i) => i.feedType === 'topic').length, 12);
    assert.equal(r.items.filter((i) => i.feedType === 'location').length, 0, 'same fixture → all duplicates');
    assert.equal(r.output.duplicatesSkipped, 12);
    assert.ok(r.items.some((i) => i.relatedCoverage.length > 0));
    assert.equal(r.items[0].articleUrl, null);
    assert.ok(srv.state.requests.some((q) => q.startsWith('GET /rss/topics/CAAqBUSINESS')));
    assert.ok(!srv.state.requests.some((q) => q.includes('batchexecute')), 'no decoding when off');
});

test('more than 100 per query: one search per day, merged', async () => {
    const r = await runActor(base({ queries: ['OpenAI'], timeRange: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-03', maxArticlesPerFeed: 150, decodeUrls: false }), env());
    assert.equal(r.code, 0, r.log);
    const searches = srv.state.requests.filter((q) => q.startsWith('GET /rss/search'));
    assert.equal(searches.length, 3);
    assert.ok(searches[0].includes('after%3A2026-10-03+before%3A2026-10-04'));
    assert.equal(r.items.length, 36, '12 per day × 3 days');
    assert.match(r.log, /read day by day \(3 day\(s\), 2026-10-01 → 2026-10-03\)/);
});

test('429 then success: retried, run succeeds', async () => {
    srv.state.fail429 = 2;
    const r = await runActor(base({ queries: ['OpenAI'], maxArticlesPerFeed: 5, decodeUrls: false }), env());
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 5);
    assert.equal(r.output.httpRetries, 2);
    assert.match(r.log, /attempt 1\/3 failed .*blocked \(status=429/);
});

test('decoder unavailable: articles still saved with the Google News link, decoding stops after 3 empty chunks', async () => {
    srv.state.decodeFail = true;
    const r = await runActor(base({ queries: ['OpenAI'], timeRange: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-07', maxArticlesPerFeed: 101, maxRetries: 0 }), env());
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 84);
    assert.ok(r.items.every((i) => i.articleUrl === null && i.googleNewsUrl.startsWith('https://news.google.com/')));
    assert.match(r.log, /stopping URL decoding/);
});

test('publisher details: snippet, image, author, canonical URL; charged as a separate event', async () => {
    const r = await runActor(base({ queries: ['Moldova'], language: 'ro', country: 'RO', maxArticlesPerFeed: 3, fetchPublisherDetails: true }), env(ppeEnv(100)));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 3);
    const a = r.items[0];
    assert.match(a.snippet, /^Summary of .+ & more$/);
    assert.equal(a.author, 'Jane Doe');
    assert.match(a.articleUrl, /\/canonical\//);
    assert.equal(a.language, 'ro');
    assert.ok(srv.state.requests[0].includes('hl=ro&gl=RO&ceid=RO%3Aro'));
    assert.equal(r.output.articlesCharged, 3);
    assert.equal(r.output.publisherDetailsCharged, 3);
});

test('pay per event: stops at the maximum cost per run', async () => {
    const r = await runActor(base({ queries: ['OpenAI'], maxArticlesPerFeed: 12, decodeUrls: false }), env(ppeEnv(5)));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 5);
    assert.equal(r.output.limitReached, true);
});

test('no results: run succeeds with a hint; broken feed: run fails clearly; bad input: clear error', async () => {
    const empty = await runActor(base({ queries: ['nothing here'] }), env());
    assert.equal(empty.code, 0, empty.log);
    assert.equal(empty.items.length, 0);
    assert.match(empty.log, /No articles matched/);
    const broken = await runActor(base({ queries: ['broken'], maxRetries: 1 }), env());
    assert.notEqual(broken.code, 0);
    assert.match(broken.log, /No Google News feed could be read/);
    const bad = await runActor(base({ topics: ['POLITICS'] }), env());
    assert.notEqual(bad.code, 0);
    assert.match(bad.log, /Input problem: Unknown topic "POLITICS"/);
});
