// End-to-end tests: run src/main.js as a child process against the local mock of Google Trends.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer, POPULARITY } from './mock-server.mjs';
import { runActor, CHROME_PATH } from './helpers.mjs';

let srv;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const base = (extra = {}) => ({ baseUrl: srv.url, useBrowser: 'never', maxRetries: 2, requestDelayMs: 0, ...extra });
const terms = (r) => r.items.filter((i) => i.type === 'term');
const trending = (r) => r.items.filter((i) => i.type === 'trending');

// Outside the platform the SDK counts the remaining budget at 1 USD per event, so test prices are 1 USD:
// ACTOR_MAX_TOTAL_CHARGE_USD=N allows N events.
const ppeEnv = (maxUsd) => ({
    ACTOR_TEST_PAY_PER_EVENT: 'true',
    ACTOR_MAX_TOTAL_CHARGE_USD: String(maxUsd),
    APIFY_ACTOR_PRICING_INFO: JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: { 'term-result': { eventTitle: 'Term result', eventPriceUsd: 1 }, 'trending-item': { eventTitle: 'Trending item', eventPriceUsd: 1 } } },
    }),
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
});

test('default-like input: 2 terms compared + trending now → complete items and clear logs', async () => {
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], geo: 'US', trendingNow: true, maxTrendingItems: 10 }));
    assert.equal(r.code, 0, r.log);
    const t = terms(r);
    assert.equal(t.length, 2);
    const [coffee, tea] = t;
    assert.equal(coffee.term, 'coffee');
    assert.equal(coffee.status, 'ok');
    assert.equal(coffee.timeline.length, 260);
    assert.equal(coffee.timeline.at(-1).isPartial, true);
    assert.equal(coffee.peakValue, 100, 'the most popular term of the group peaks at 100');
    assert.ok(tea.averageInterest < coffee.averageInterest);
    assert.ok(Math.abs(tea.averageInterest / coffee.averageInterest - POPULARITY.tea / POPULARITY.coffee) < 0.02);
    assert.deepEqual(coffee.comparedWith, ['tea']);
    assert.equal(coffee.exploreUrl, 'https://trends.google.com/trends/explore?date=today+12-m&geo=US&q=coffee%2Ctea&hl=en-US');
    assert.equal(coffee.regions, undefined, 'regions only when requested');
    assert.equal(trending(r).length, 10);
    assert.equal(trending(r)[0].title, 'typescript & effect');
    assert.equal(trending(r)[1].newsSource, 'ESPN');
    // One explore for both terms, sent with the NID cookie from the warmup request.
    assert.equal(srv.state.exploreBodies.length, 1);
    assert.deepEqual(srv.state.exploreBodies[0].req, { comparisonItem: [{ keyword: 'coffee', geo: 'US', time: 'today 12-m' }, { keyword: 'tea', geo: 'US', time: 'today 12-m' }], category: 0, property: '' });
    assert.equal(srv.state.exploreBodies[0].tz, '0');
    assert.match(r.log, /\[warmup\] http session=\S+ proxy=none: status=404 \d+ms NID cookie=yes/);
    assert.match(r.log, /\[group 1\/1 explore\/http\] attempt 1\/3 via http: status=200 .* → parser=explore widgets=\[TIMESERIES,GEO_MAP,TITLE_0,GEO_MAP_0,RELATED_QUERIES_0/);
    assert.match(r.log, /parser=multiline points=260 series=2 resolution=WEEK partial=1/);
    assert.match(r.log, /parser=rss items=13 withNews=13/);
    assert.equal(r.output.termsOk, 2);
    assert.equal(r.output.trendingItemsPushed, 10);
});

test('all outputs: regions (CITY with coordinates), related queries and topics (extra single-term explore per term)', async () => {
    const r = await runActor(base({ searchTerms: ['pizza', 'bagel'], geo: 'US', interestByRegion: true, regionResolution: 'CITY', includeLowSearchVolumeRegions: true, relatedQueries: true, relatedTopics: true, maxRelatedItems: 10 }));
    assert.equal(r.code, 0, r.log);
    const [pizza, bagel] = terms(r);
    for (const it of [pizza, bagel]) {
        assert.equal(it.status, 'ok', JSON.stringify(it.errors));
        assert.equal(it.regionResolution, 'CITY');
        assert.deepEqual(it.regions[0], { geoCode: null, geoName: 'New York', value: 100, formattedValue: '100', hasData: true, lat: 40.7127753, lng: -74.0059728 });
        assert.equal(it.topRegion, 'New York');
        assert.equal(it.relatedQueriesTop.length, 10, 'maxRelatedItems');
        assert.equal(it.relatedQueriesRising[0].isBreakout, true);
        assert.equal(it.relatedTopicsTop[0].title, 'Pizza');
    }
    const geoReqs = srv.state.widgetRequests.filter((w) => w.kind === 'comparedgeo');
    assert.equal(geoReqs.length, 2);
    assert.ok(geoReqs.every((g) => g.request.resolution === 'CITY' && g.request.includeLowSearchVolumeGeos === true));
    assert.deepEqual(geoReqs.map((g) => g.request.comparisonItem[0].complexKeywordsRestriction.keyword[0].value), ['pizza', 'bagel'], 'per-term GEO_MAP_i widgets');
    assert.equal(srv.state.exploreBodies.length, 3, '1 group explore + 1 single-term explore per term for related topics');
    const topicReqs = srv.state.widgetRequests.filter((w) => w.kind === 'relatedsearches' && w.request.keywordType === 'ENTITY');
    assert.equal(topicReqs.length, 2);
});

test('many terms + anchor: groups of anchor + 4, one scale for all (comparableValue), anchor stored once', async () => {
    const list = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'lemon', 'mango'];
    const r = await runActor(base({ searchTerms: list, anchorTerm: 'weather' }));
    assert.equal(r.code, 0, r.log);
    const t = terms(r);
    assert.equal(t.length, 10, '9 terms + the anchor once');
    assert.equal(srv.state.exploreBodies.length, 3);
    assert.ok(srv.state.exploreBodies.every((b) => b.req.comparisonItem[0].keyword === 'weather'));
    assert.deepEqual(srv.state.exploreBodies.map((b) => b.req.comparisonItem.length), [5, 5, 2]);
    const anchor = t.find((i) => i.term === 'weather');
    assert.equal(anchor.isAnchor, true);
    assert.equal(anchor.groupId, 1);
    // Comparable averages follow the true popularity ratios across groups; Google-style group values do not.
    const byTerm = Object.fromEntries(t.map((i) => [i.term, i]));
    const top = Math.max(...t.map((i) => Math.max(...i.timeline.map((p) => p.comparableValue ?? 0))));
    assert.equal(top, 100);
    for (const [a, b] of [['apple', 'mango'], ['apple', 'elderberry'], ['banana', 'grape'], ['fig', 'cherry']]) {
        const want = POPULARITY[a] / POPULARITY[b];
        const got = byTerm[a].comparableAverage / byTerm[b].comparableAverage;
        assert.ok(Math.abs(got / want - 1) < 0.15, `${a}/${b}: ${got.toFixed(2)} vs ${want.toFixed(2)}`);
    }
    // Raw values stay Google-style (relative to the group's top term): group 2 is weather(50), elderberry, fig(8), grape, lemon.
    assert.equal(byTerm.fig.peakValue, 16);
    assert.equal(byTerm.mango.peakValue, 30, 'group 3 = weather(50) + mango(15)');
    assert.equal(byTerm.apple.peakValue, 100);
    assert.equal(r.output.anchor.groups.length, 3);
    assert.match(r.log, /Group 3\/3 \[weather, mango\]: mango=ok/);
});

test('"separate" mode: every term alone on its own 0-100 scale', async () => {
    const r = await runActor(base({ searchTerms: ['coffee', 'bagel'], comparisonMode: 'separate' }));
    assert.equal(r.code, 0, r.log);
    const t = terms(r);
    assert.equal(srv.state.exploreBodies.length, 2);
    for (const i of t) assert.equal(i.peakValue, 100);
    assert.deepEqual(t.map((i) => i.comparedWith), [[], []]);
});

test('429 on explore: backoff, new session (new NID) and success on the 3rd attempt', async () => {
    srv.state.rateLimit.push({ re: /GET \/trends\/api\/explore/, count: 2 });
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], maxRetries: 3 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(terms(r).filter((i) => i.status === 'ok').length, 2);
    assert.match(r.log, /attempt 1\/4 via http session=\S+ proxy=none: status=429 .* → HTTP 429 Too Many Requests \(Google rate limit\)/);
    assert.match(r.log, /retrying with a new session \(new IP and cookies\)/);
    assert.match(r.log, /\[group 1\/1 explore\/http\] attempt 3\/4 via http: status=200/);
    assert.equal(r.output.requests.rateLimited, 2);
    assert.equal(r.output.requests.warmups, 3, 'every new session gets a fresh NID cookie');
    assert.equal(srv.state.nidCounter, 3);
    assert.ok(r.kvKeys.some((k) => k.startsWith('DEBUG-1-group-1-1-explore')), `debug page saved: ${r.kvKeys}`);
});

test('explore always rate-limited: tokens come from the embeddable widget pages instead', async () => {
    srv.state.exploreBlocked = true;
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], interestByRegion: true, maxRetries: 1 }));
    assert.equal(r.code, 0, r.log);
    const t = terms(r);
    assert.ok(t.every((i) => i.status === 'ok'), JSON.stringify(t.map((i) => i.errors)));
    assert.ok(t.every((i) => i.dataSource === 'embed/http'));
    assert.match(r.log, /explore failed \(HTTP 429 .*\); trying the embeddable widget pages/);
    assert.match(r.log, /embed:TIMESERIES\/http\] attempt 1\/\d via http: status=200 .* parser=embed widget=TIMESERIES type=fe_line_chart userType=USER_TYPE_EMBED/);
    assert.equal(r.output.requests.tokenSource, 'embed');
});

test('explore refuses GET (405): switches to POST like pytrends and keeps using it', async () => {
    srv.state.exploreGetRefused = true;
    const r = await runActor(base({ searchTerms: ['coffee', 'tea', 'pizza', 'bagel', 'apple', 'banana'] }));
    assert.equal(r.code, 0, r.log);
    assert.equal(terms(r).filter((i) => i.status === 'ok').length, 6);
    assert.match(r.log, /explore via GET answered HTTP 405; trying POST/);
    assert.deepEqual(srv.state.exploreBodies.map((b) => b.method), ['POST', 'POST']);
});

test('tokens bound to the session: 429 on data → new session → token refused (401) → fresh tokens → success', async () => {
    srv.state.tokenBound = true;
    srv.state.rateLimit.push({ re: /multiline/, count: 1 });
    const r = await runActor(base({ searchTerms: ['coffee'] }));
    assert.equal(r.code, 0, r.log);
    assert.equal(terms(r)[0].status, 'ok');
    assert.match(r.log, /interest over time: widget token refused \(HTTP 401\); requesting fresh tokens/);
    assert.equal(srv.state.exploreBodies.length, 2);
    assert.equal(r.output.requests.tokenRefused, 1);
});

test('captcha ("unusual traffic") → retried with a new session', async () => {
    srv.state.captchaNext = 1;
    const r = await runActor(base({ searchTerms: ['coffee'] }));
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /captcha=YES .* → captcha \/ "unusual traffic" page/);
    assert.equal(r.output.requests.captchaPages, 1);
});

test('partial data: related queries keep failing → item stored free with status "partial" and the error', async () => {
    srv.state.rateLimit.push({ re: /relatedsearches/, count: 100 });
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], relatedQueries: true, maxRetries: 1 }), { env: ppeEnv(10) });
    assert.equal(r.code, 0, r.log);
    const t = terms(r);
    assert.equal(t.length, 2);
    for (const i of t) {
        assert.equal(i.status, 'partial');
        assert.equal(i.timeline.length, 260);
        assert.equal(i.relatedQueriesTop, null);
        assert.match(i.errors[0], /related queries: HTTP 429/);
    }
    assert.equal(r.output.termResultsCharged, 0, 'incomplete terms are not charged');
    assert.equal(r.output.termsPartial, 2);
});

test('everything blocked, no browser: failed items (free) + run fails with a proxy hint', async () => {
    srv.state.exploreBlocked = true;
    const r = await runActor(base({ searchTerms: ['coffee'], useEmbedFallback: false, maxRetries: 1 }), { env: ppeEnv(10) });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /Google Trends could not be read \(Google Trends refused the comparison: HTTP 429 .*add your own proxy URLs/);
    assert.doesNotMatch(r.log, /RESIDENTIAL/);
    assert.equal(terms(r)[0].status, 'failed');
    assert.equal(r.output.termResultsCharged, 0);
});

test('pay-per-event: trending runs first, then the group is trimmed to what the budget still allows', async () => {
    const r = await runActor(base({ searchTerms: ['a1', 'a2', 'a3', 'a4', 'a5'], trendingNow: true, maxTrendingItems: 2 }), { env: ppeEnv(5) });
    assert.equal(r.code, 0, r.log);
    assert.equal(trending(r).length, 2);
    assert.equal(terms(r).length, 3);
    assert.deepEqual(srv.state.exploreBodies[0].req.comparisonItem.map((c) => c.keyword), ['a1', 'a2', 'a3'], 'no data fetched that cannot be paid for');
    assert.equal(r.output.trendingItemsCharged, 2);
    assert.equal(r.output.termResultsCharged, 3);
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.match(r.log, /allows only 3 more term\(s\)/);
    assert.match(r.log, /Stopped at your maximum cost per run/);
    const noMore = await runActor(base({ searchTerms: ['a1', 'a2'], trendingNow: true }), { env: ppeEnv(3) });
    assert.equal(trending(noMore).length, 3);
    assert.equal(terms(noMore).length, 0, 'budget used up by trending: no term requests at all');
    assert.equal(noMore.output.requests.byEndpoint.explore, undefined);
});

test('pay-per-event: trending items are charged one by one up to the limit', async () => {
    const r = await runActor(base({ trendingNow: true, maxTrendingItems: 50 }), { env: ppeEnv(4) });
    assert.equal(r.code, 0, r.log);
    assert.equal(trending(r).length, 4);
    assert.equal(r.output.trendingItemsCharged, 4);
    assert.equal(r.output.stoppedAtCostLimit, true);
});

test('pay-per-event: second group with the anchor does not charge the anchor twice', async () => {
    const r = await runActor(base({ searchTerms: ['apple', 'banana', 'cherry', 'date', 'fig', 'grape'], anchorTerm: 'weather' }), { env: ppeEnv(100) });
    assert.equal(r.code, 0, r.log);
    assert.equal(terms(r).length, 7);
    assert.equal(r.output.termResultsCharged, 7);
    // Budget 6: group 1 = weather + 4 (5 events), group 2 can only add 1 new term; the anchor is not counted twice.
    srv.reset();
    const tight = await runActor(base({ searchTerms: ['apple', 'banana', 'cherry', 'date', 'fig', 'grape'], anchorTerm: 'weather' }), { env: ppeEnv(6) });
    assert.equal(tight.code, 0, tight.log);
    assert.deepEqual(srv.state.exploreBodies.map((b) => b.req.comparisonItem.map((c) => c.keyword)), [['weather', 'apple', 'banana', 'cherry', 'date'], ['weather', 'fig']]);
    assert.equal(terms(tight).length, 6);
    assert.equal(tight.output.termResultsCharged, 6);
    assert.ok(terms(tight).every((i) => typeof i.comparableAverage === 'number'));
});

test('flat rows for spreadsheets: term, timeline, region and related rows', async () => {
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], geo: 'US', interestByRegion: true, relatedQueries: true, maxRelatedItems: 5, flattenTimeline: true }));
    assert.equal(r.code, 0, r.log);
    const by = (t) => r.items.filter((i) => i.rowType === t);
    assert.equal(by('term').length, 2);
    assert.equal(by('timeline').length, 520);
    assert.equal(by('region').length, 4);
    assert.equal(by('relatedQuery').length, 20);
    assert.deepEqual(Object.keys(by('timeline')[0]), ['rowType', 'term', 'groupId', 'geo', 'timeRange', 'date', 'value', 'isPartial', 'hasData']);
});

test('trending now from the Trending Now page data, news merged from RSS', async () => {
    const r = await runActor(base({ trendingNow: true, trendingGeo: 'gb', trendingSource: 'trendingPage', trendingHours: '48' }));
    assert.equal(r.code, 0, r.log);
    const t = trending(r);
    assert.equal(t.length, 6);
    assert.deepEqual(srv.state.batchInner, [null, null, 'GB', 0, 'en-US', 48, 1]);
    const ws = t.find((i) => i.title === 'world series');
    assert.equal(ws.approxTrafficMin, 2000000);
    assert.equal(ws.approxTraffic, '2M+');
    assert.equal(ws.increasePercent, 1000);
    assert.deepEqual(ws.categories, ['Sports']);
    assert.equal(ws.newsTitle, 'Game 7 goes to extra innings', 'news from the RSS feed');
    assert.equal(t.find((i) => i.title === 'new phone launch').isActive, false);
    assert.equal(ws.timeWindowHours, 48);
    assert.equal(ws.source, 'trendingPage');
});

test('bad input fails with a clear message', async () => {
    const cases = [
        [{}, /at least one term/],
        [{ searchTerms: ['x'], timeRange: 'custom', customTimeRange: '2025-06-01 2025-01-01' }, /before the end/],
        [{ searchTerms: ['x'], geo: 'Moldova' }, /country or region code/],
        [{ searchTerms: ['x'], baseUrl: 'ftp://x' }, /baseUrl/],
    ];
    for (const [input, re] of cases) {
        const r = await runActor({ useBrowser: 'never', ...input, baseUrl: input.baseUrl ?? srv.url });
        assert.notEqual(r.code, 0, `should fail: ${JSON.stringify(input)}`);
        assert.match(r.log, /Invalid input/);
        assert.match(r.log, re);
    }
});

test('consent page with browser disabled: fails and says why', async () => {
    srv.state.consent = 'always';
    const r = await runActor(base({ searchTerms: ['coffee'], maxRetries: 0, useEmbedFallback: false }));
    assert.notEqual(r.code, 0);
    assert.match(r.log, /consent=YES/);
    assert.match(r.log, /cookie consent page/);
});

test('consent page: real browser clicks "Accept all" and fetches the data from inside the page', { skip: !CHROME_PATH && 'no local Chrome' }, async () => {
    srv.state.consent = 'always';
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], useBrowser: 'fallback', maxRetries: 0, useEmbedFallback: false, trendingNow: true, maxTrendingItems: 3 }));
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /Switching to a real Chrome browser/);
    assert.match(r.log, /\[browser\] Google consent page detected .* clicking/);
    assert.equal(terms(r).filter((i) => i.status === 'ok').length, 2);
    assert.equal(terms(r)[0].dataSource, 'explore/browser');
    assert.equal(trending(r).length, 3);
    assert.equal(r.output.requests.switchedToBrowser, true);
});

test('429 over HTTP with the browser fallback: HTTP is dropped after 2 rate limits in a row, no long backoff, no embed attempts over HTTP', { skip: !CHROME_PATH && 'no local Chrome' }, async () => {
    srv.state.rateLimit.push({ re: /GET \/trends\/api\/explore/, count: 2 });
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], useBrowser: 'fallback', maxRetries: 5 }));
    assert.equal(r.code, 0, r.log);
    assert.equal(terms(r).filter((i) => i.status === 'ok').length, 2);
    assert.match(r.log, /HTTP was rate-limited 2 times in a row, not retrying it/);
    assert.match(r.log, /Switching to a real Chrome browser/);
    assert.doesNotMatch(r.log, /attempt 3\/6 via http/, 'no third HTTP attempt');
    assert.doesNotMatch(r.log, /embed:\w+\/http/, 'no embed pages over a rate-limited HTTP');
    assert.equal(terms(r)[0].dataSource, 'explore/browser');
    assert.equal(r.output.requests.switchedToBrowser, true);
    assert.equal(r.output.requests.retries, 1);
});

test('one 429 over HTTP is still retried over HTTP (the browser is not started for a single hiccup)', { skip: !CHROME_PATH && 'no local Chrome' }, async () => {
    srv.state.rateLimit.push({ re: /GET \/trends\/api\/explore/, count: 1 });
    const r = await runActor(base({ searchTerms: ['coffee'], useBrowser: 'fallback' }));
    assert.equal(r.code, 0, r.log);
    assert.equal(terms(r)[0].status, 'ok');
    assert.equal(terms(r)[0].dataSource, 'explore/http');
    assert.equal(r.output.requests.switchedToBrowser, false);
});

test('second pass: a part that failed all its retries is fetched again with fresh tokens → complete term, charged', async () => {
    srv.state.rateLimit.push({ re: /multiline/, count: 2 });
    const r = await runActor(base({ searchTerms: ['coffee', 'tea'], relatedQueries: true, maxRetries: 1 }), { env: ppeEnv(10) });
    assert.equal(r.code, 0, r.log);
    const t = terms(r);
    assert.ok(t.every((i) => i.status === 'ok'), JSON.stringify(t.map((i) => i.errors)));
    assert.ok(t.every((i) => !i.errors?.length));
    assert.match(r.log, /trying the missing parts once more with fresh tokens/);
    assert.match(r.log, /second pass: all missing parts recovered/);
    assert.equal(srv.state.exploreBodies.length, 2, 'one fresh explore for the second pass');
    assert.equal(srv.state.widgetRequests.filter((w) => w.kind === 'relatedsearches').length, 2, 'parts that worked are not fetched again');
    assert.equal(r.output.requests.secondPasses, 1);
    assert.equal(r.output.termResultsCharged, 2);
});
