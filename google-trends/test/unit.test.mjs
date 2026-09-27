// Unit tests: request builders and parsers, on real recorded Google Trends responses (test/fixtures, see SOURCES.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    stripXssiPrefix, parseGoogleJson, parseExplore, selectWidgets, parseTimeline, parseGeo, parseRelated, parseTrendingRss,
    parseBatchExecute, parseTrendingRows, parseEmbedHtml, classifyResponse, parseTraffic, widgetKeywords, DecodeError,
} from '../src/parse.js';
import { buildExploreReq, buildExploreUrl, buildWidgetDataUrl, buildTrendingRequest, buildEmbedUrl, buildPublicExploreUrl, TRENDING_CATEGORIES } from '../src/request.js';
import { parseInput, parseTimeRange, buildGroups, InputError } from '../src/input.js';
import { computeComparable, buildTermItem, flattenTermItem } from '../src/output.js';
import { embedHtml } from './mock-server.mjs';

const raw = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-27T12:00:00Z');

test('XSSI prefixes: ")]}\'" (explore) and ")]}\'," (widgetdata) are stripped', () => {
    const explore = raw('explore-pizza-bagel-2021.txt');
    const multiline = raw('multiline-pizza-bagel-days.txt');
    assert.ok(explore.startsWith(")]}'\n"));
    assert.ok(multiline.startsWith(")]}',\n"));
    assert.ok(stripXssiPrefix(explore).startsWith('{"widgets"'));
    assert.ok(stripXssiPrefix(multiline).startsWith('{"default"'));
    assert.equal(stripXssiPrefix('{"a":1}'), '{"a":1}');
    assert.throws(() => parseGoogleJson('<!doctype html><title>Error 429 (Too Many Requests)!!1</title>'), DecodeError);
    assert.throws(() => parseGoogleJson(")]}'\n"), /empty/);
});

test('explore with 2 terms: TIMESERIES, compared GEO_MAP, per-term GEO_MAP_i and RELATED_QUERIES_i, no related topics', () => {
    const widgets = parseExplore(parseGoogleJson(raw('explore-pizza-bagel-2021.txt')));
    const sel = selectWidgets(widgets, ['pizza', 'bagel']);
    assert.equal(sel.timeseries.id, 'TIMESERIES');
    assert.equal(sel.timeseries.request.resolution, 'WEEK');
    assert.equal(sel.timeseries.request.userConfig.userType, 'USER_TYPE_SCRAPER');
    assert.equal(sel.comparedGeo.type, 'fe_multi_heat_map');
    assert.equal(sel.geo.get('pizza').id, 'GEO_MAP_0');
    assert.equal(sel.geo.get('bagel').id, 'GEO_MAP_1');
    assert.equal(sel.relatedQueries.get('bagel').id, 'RELATED_QUERIES_1');
    assert.equal(sel.relatedTopics.size, 0, 'Google sends no RELATED_TOPICS widgets for multi-term comparisons');
    assert.deepEqual(widgetKeywords(sel.timeseries), ['pizza', 'bagel']);
    // Matching is by keyword (case-insensitive), not only by position.
    const sel2 = selectWidgets(widgets, ['BAGEL', 'Pizza']);
    assert.equal(sel2.geo.get('BAGEL').id, 'GEO_MAP_1');
});

test('explore with 1 term: GEO_MAP, RELATED_TOPICS (ENTITY) and RELATED_QUERIES without suffix', () => {
    const sel = selectWidgets(parseExplore(parseGoogleJson(raw('explore-pizza-2021.txt'))), ['pizza']);
    assert.equal(sel.geo.get('pizza').type, 'fe_geo_chart_explore');
    assert.equal(sel.relatedTopics.get('pizza').request.keywordType, 'ENTITY');
    assert.equal(sel.relatedQueries.get('pizza').request.keywordType, 'QUERY');
    assert.equal(sel.comparedGeo, null);
});

test('timeline: 260 weekly points of the recorded 5-year series, last point partial, Google averages', () => {
    const r = parseTimeline(parseGoogleJson(raw('multiline-pizza-bagel-5y.txt')), 2, { resolution: 'WEEK' });
    assert.equal(r.series.length, 2);
    assert.equal(r.series[0].length, 260);
    assert.deepEqual(r.averages, [77, 2]);
    const last = r.series[0].at(-1);
    assert.equal(last.isPartial, true);
    assert.equal(last.date, '2023-03-19');
    assert.equal(last.value, 58);
    assert.equal(r.series[1].at(-1).value, 2);
    assert.equal(r.series[0].filter((p) => p.isPartial).length, 1);
    const d = parseTimeline(parseGoogleJson(raw('multiline-pizza-bagel-days.txt')), 2, { resolution: 'DAY' });
    assert.deepEqual(d.series[0].map((p) => [p.date, p.value]), [['2021-01-01', 100], ['2021-01-02', 83], ['2021-01-03', 78], ['2021-01-04', 49], ['2021-01-05', 50]]);
    assert.equal(d.series[1][0].value, 2);
    const hourly = parseTimeline({ default: { timelineData: [{ time: '1790000000', value: [5], hasData: [true] }] } }, 1, { resolution: 'HOUR' });
    assert.equal(hourly.series[0][0].date, '2026-09-21T14:13:20Z', 'hourly/minute data keeps the time');
    assert.throws(() => parseTimeline({ default: {} }, 1), DecodeError);
});

test('interest by region: recorded 250-country map, hasData filter, per-term value index, CITY coordinates', () => {
    const json = parseGoogleJson(raw('comparedgeo-compared-countries.txt'));
    assert.equal(json.default.geoMapData.length, 250);
    const all = parseGeo(json, { idx: 1, includeNoData: true });
    assert.equal(all.length, 250);
    const withData = parseGeo(json, { idx: 1 });
    assert.ok(withData.length < 250 && withData.length > 10);
    assert.ok(withData.every((r) => r.hasData));
    const us = withData.find((r) => r.geoCode === 'US');
    assert.equal(us.value, 3);
    assert.equal(us.formattedValue, '3%');
    assert.ok(withData[0].value >= withData[1].value, 'sorted by value');
    const regions = parseGeo(JSON.parse(raw('comparedgeo-single-regions.json')));
    assert.deepEqual(regions.map((r) => [r.geoCode, r.value]), [['US-CA', 100], ['US-TX', 84]]);
    const city = parseGeo({ default: { geoMapData: [{ coordinates: { lat: 40.71, lng: -74 }, geoName: 'New York', value: [100], hasData: [true] }] } });
    assert.deepEqual(city[0], { geoCode: null, geoName: 'New York', value: 100, formattedValue: null, hasData: true, lat: 40.71, lng: -74 });
});

test('related queries: top 25 and rising 11 with "Breakout" and growth percentages', () => {
    const r = parseRelated(parseGoogleJson(raw('relatedsearches-queries-pizza.txt')));
    assert.equal(r.top.length, 25);
    assert.equal(r.rising.length, 11);
    assert.deepEqual(r.top[0], { rank: 1, query: 'pizza hut', value: 100, formattedValue: '100', link: 'https://trends.google.com/trends/explore?q=pizza+hut&date=2021-01-01+2021-12-31' });
    assert.equal(r.rising[0].query, 'licorice pizza');
    assert.equal(r.rising[0].isBreakout, true);
    assert.equal(r.rising[0].formattedValue, 'Breakout');
    assert.equal(r.rising[1].formattedValue, '+400%');
    assert.equal(r.rising[1].isBreakout, false);
    const b = parseRelated(parseGoogleJson(raw('relatedsearches-queries-bagel.txt')));
    assert.ok(b.top.length > 0 && b.top.every((q) => typeof q.query === 'string'));
});

test('related topics: topic id, title and type; "Breakout" given as a string value', () => {
    const r = parseRelated(parseGoogleJson(raw('relatedsearches-topics-pizza.txt')), { topics: true });
    assert.equal(r.top.length, 21);
    assert.equal(r.rising.length, 4);
    assert.deepEqual({ ...r.top[0], link: undefined }, { rank: 1, topicId: '/m/0663v', title: 'Pizza', topicType: 'Dish', value: 100, formattedValue: '100', link: undefined });
    assert.equal(r.rising[0].title, 'Sam Goody');
    assert.equal(r.rising[0].isBreakout, true);
    const s = parseRelated(JSON.parse(raw('relatedsearches-topics-string-value.json')), { topics: true });
    assert.equal(s.rising[0].value, null);
    assert.equal(s.rising[0].isBreakout, true);
    const empty = parseRelated({ default: { rankedList: [{ rankedKeyword: [] }, { rankedKeyword: [] }] } });
    assert.deepEqual(empty, { top: [], rising: [] });
});

test('Trending Now RSS: approx traffic, start time, picture and news items (entities decoded)', () => {
    const items = parseTrendingRss(raw('trending-rss-recorded.xml'));
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.title, 'typescript & effect');
    assert.equal(it.approxTraffic, '10K+');
    assert.equal(it.approxTrafficMin, 10000);
    assert.equal(it.startedAt, '2026-06-12T08:40:00.000Z');
    assert.equal(it.picture, 'https://example.com/image.png');
    assert.equal(it.pictureSource, 'Example News');
    assert.equal(it.news.length, 2);
    assert.deepEqual(it.news[0], { title: 'Effect v4 beta ships for TypeScript developers', url: 'https://example.com/effect-v4', source: 'Example News', picture: 'https://example.com/effect.png', snippet: 'Runtime and schema updates.' });
    assert.equal(it.news[1].snippet, null, 'self-closing <ht:news_item_snippet/>');
    assert.throws(() => parseTrendingRss('<html>429</html>'), DecodeError);
    assert.deepEqual(parseTrendingRss('<rss><channel><title>x</title></channel></rss>'), []);
    assert.equal(parseTraffic('20,000+'), 20000);
    assert.equal(parseTraffic('2M+'), 2000000);
    assert.equal(parseTraffic('1.5K+'), 1500);
    assert.equal(parseTraffic('lots'), null);
});

test('Trending Now page (batchexecute i0OFE): rows with volume, growth, start time, related queries', () => {
    const payload = parseBatchExecute(raw('batchexecute-i0OFE-recorded.txt'), 'i0OFE');
    const rows = parseTrendingRows(payload, TRENDING_CATEGORIES);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
        rank: 1, title: 'typescript', approxTraffic: '500K+', approxTrafficMin: 500000, increasePercent: 120, startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: null, isActive: true, relatedQueries: ['typescript tutorial', 'typescript node'], categories: [], geo: 'US',
    });
    // Length-prefixed (rt=c) framing and a second rpc id are tolerated; categories are named.
    const framed = `)]}'\n\n123\n[["wrb.fr","other","[]"],["wrb.fr","i0OFE","[null,[[\\"a\\",null,\\"GB\\",[1790000000],[1790003600],null,20000,null,500,[],[17,18],[],\\"a\\"]]]",null,null,null,"generic"]]\n25\n[["e",4]]`;
    const r2 = parseTrendingRows(parseBatchExecute(framed, 'i0OFE'), TRENDING_CATEGORIES);
    assert.equal(r2[0].isActive, false);
    assert.equal(r2[0].endedAt, '2026-09-21T15:13:20.000Z');
    assert.deepEqual(r2[0].categories, ['Sports', 'Technology']);
    assert.throws(() => parseBatchExecute('[["wrb.fr","i0OFE",null]]', 'i0OFE'), /empty payload/);
    assert.throws(() => parseBatchExecute('<html></html>', 'i0OFE'), /no i0OFE frame/);
});

test('embeddable widget page: JSON.parse(\'…\') with \\x escapes is decoded to a widget', () => {
    const w = { id: 'TIMESERIES', type: 'fe_line_chart', token: 'APP6_abc', request: { time: '2025-01-01 2025-12-31', comparisonItem: [{ geo: {}, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: "o'reilly [x]" }] } }] } };
    const back = parseEmbedHtml(embedHtml(w));
    assert.deepEqual(back, w);
    assert.throws(() => parseEmbedHtml('<html>nothing</html>'), DecodeError);
});

test('response classification: 429 page, /sorry/ captcha, consent wall', () => {
    const h429 = '<!DOCTYPE html><title>Error 429 (Too Many Requests)!!1</title>';
    assert.equal(classifyResponse({ status: 429, url: 'https://trends.google.com/trends/api/explore', text: h429 }).kind, 'rate-limited');
    assert.equal(classifyResponse({ status: 200, url: 'https://trends.google.com/x', text: h429 }).rateLimited, true);
    assert.equal(classifyResponse({ status: 200, url: 'https://www.google.com/sorry/index?continue=x', text: '' }).kind, 'captcha');
    assert.equal(classifyResponse({ status: 200, url: 'https://consent.google.com/ml?continue=x', text: '' }).kind, 'consent');
    assert.equal(classifyResponse({ status: 401, url: 'https://trends.google.com/x', text: '' }).kind, 'unauthorized');
    assert.equal(classifyResponse({ status: 200, url: 'https://trends.google.com/x', text: '{}' }).kind, 'ok');
});

test('request builders: explore / widget data / trending shapes', () => {
    const req = buildExploreReq({ terms: ['a', 'b'], geo: 'US', time: 'today 12-m', category: 71, gprop: 'youtube' });
    assert.deepEqual(req, { comparisonItem: [{ keyword: 'a', geo: 'US', time: 'today 12-m' }, { keyword: 'b', geo: 'US', time: 'today 12-m' }], category: 71, property: 'youtube' });
    const u = new URL(buildExploreUrl('https://trends.google.com', { hl: 'en-US', tz: 0, req }));
    assert.equal(u.pathname, '/trends/api/explore');
    assert.deepEqual(JSON.parse(u.searchParams.get('req')), req);
    assert.equal(u.searchParams.get('tz'), '0');
    const w = { id: 'GEO_MAP_0', token: 'T', request: { resolution: 'REGION' } };
    const wu = new URL(buildWidgetDataUrl('https://trends.google.com', w, { hl: 'en-US', tz: 0, request: { resolution: 'CITY' } }));
    assert.equal(wu.pathname, '/trends/api/widgetdata/comparedgeo');
    assert.equal(wu.searchParams.get('token'), 'T');
    assert.equal(wu.searchParams.get('req'), '{"resolution":"CITY"}');
    assert.equal(new URL(buildEmbedUrl('https://trends.google.com', 'TIMESERIES', { hl: 'en', tz: 0, req })).pathname, '/trends/embed/explore/TIMESERIES');
    const t = buildTrendingRequest('https://trends.google.com', { geo: 'US', hl: 'en-US', hours: 24 });
    assert.deepEqual(t.inner, [null, null, 'US', 0, 'en-US', 24, 1]);
    assert.ok(t.url.includes('rpcids=i0OFE') && t.url.includes('source-path=%2Ftrending'));
    assert.deepEqual(JSON.parse(decodeURIComponent(t.body.slice(6))), [[['i0OFE', '[null,null,"US",0,"en-US",24,1]', null, 'generic']]]);
    assert.equal(buildPublicExploreUrl({ terms: ['a', 'b'], geo: 'US', time: 'today 12-m', category: 0, gprop: '', hl: 'en-US' }), 'https://trends.google.com/trends/explore?date=today+12-m&geo=US&q=a%2Cb&hl=en-US');
});

test('time ranges: presets, custom dates, hourly windows and clear errors', () => {
    assert.equal(parseTimeRange('today 12-m', { now: NOW }), 'today 12-m');
    assert.equal(parseTimeRange(' 2024-01-01   2024-06-30 ', { now: NOW }), '2024-01-01 2024-06-30');
    assert.equal(parseTimeRange('2026-09-20T00 2026-09-26T23', { now: NOW }), '2026-09-20T00 2026-09-26T23');
    assert.equal(parseTimeRange('today 2-y'), 'today 2-y');
    assert.equal(parseTimeRange('now 3-d'), 'now 3-d');
    assert.throws(() => parseTimeRange('2024-06-30 2024-01-01', { now: NOW }), /before the end/);
    assert.throws(() => parseTimeRange('2003-01-01 2004-06-30', { now: NOW }), /2004-01-01/);
    assert.throws(() => parseTimeRange('2026-09-01T00 2026-09-20T00', { now: NOW }), /7 days/);
    assert.throws(() => parseTimeRange('2024-02-30 2024-03-01', { now: NOW }), /invalid date/);
    assert.throws(() => parseTimeRange('last year', { now: NOW }), /not valid/);
    assert.throws(() => parseTimeRange('now 9-d'), /7 days/);
});

test('batching: groups of 5, or anchor + 4 per group; "separate" = one term per group', () => {
    const terms = Array.from({ length: 9 }, (_, i) => `t${i + 1}`);
    assert.deepEqual(buildGroups(terms).map((g) => g.length), [5, 4]);
    const a = buildGroups(terms, { anchor: 'anchor' });
    assert.deepEqual(a.map((g) => g.length), [5, 5, 2]);
    assert.ok(a.every((g) => g[0] === 'anchor'));
    assert.deepEqual(a.flatMap((g) => g.slice(1)), terms);
    assert.deepEqual(buildGroups(['x', 'anchor', 'y'], { anchor: 'anchor' }), [['anchor', 'x', 'y']], 'anchor listed among the terms is not duplicated');
    assert.deepEqual(buildGroups(['a', 'b'], { mode: 'separate' }), [['a'], ['b']]);
    const cfg = parseInput({ searchTerms: terms, anchorTerm: 'weather' }, { now: NOW });
    assert.deepEqual(cfg.searchTerms[0], 'weather', 'the anchor is added as a term');
    assert.equal(cfg.groups.length, 3);
    const cfg2 = parseInput({ searchTerms: ['Weather', 'x'], anchorTerm: 'weather' }, { now: NOW });
    assert.equal(cfg2.anchorTerm, 'Weather', 'anchor matches a listed term case-insensitively');
    assert.deepEqual(cfg2.groups, [['Weather', 'x']]);
});

test('input: defaults, normalization and validation errors', () => {
    const c = parseInput({ searchTerms: ['coffee', 'Coffee', ' tea '] }, { now: NOW });
    assert.deepEqual(c.searchTerms, ['coffee', 'tea'], 'duplicates removed');
    assert.equal(c.time, 'today 12-m');
    assert.equal(c.geo, '');
    assert.equal(c.language, 'en-US');
    assert.equal(c.tz, 0);
    assert.equal(c.maxConcurrency, 1);
    assert.equal(c.interestOverTime, true);
    assert.equal(c.interestByRegion, false);
    assert.equal(parseInput({ searchTerms: ['x'], geo: 'us-ca' }).geo, 'US-CA');
    assert.equal(parseInput({ searchTerms: ['x'], category: '71' }).categoryName, 'Food & Drink');
    assert.equal(parseInput({ searchTerms: ['x'], categoryId: 1227, category: '71' }).category, 1227);
    assert.equal(parseInput({ searchTerms: ['x'], gprop: 'shopping' }).gprop, 'froogle');
    assert.equal(parseInput({ trendingNow: true }).trendingGeo, 'US');
    assert.equal(parseInput({ trendingNow: true, geo: 'GB-ENG' }).trendingGeo, 'GB');
    const bad = [
        [{}, /at least one term/],
        [{ searchTerms: ['x'], geo: 'United States' }, /country or region code/],
        [{ searchTerms: ['x'], timeRange: 'custom' }, /customTimeRange/],
        [{ searchTerms: ['x'], gprop: 'maps' }, /gprop/],
        [{ searchTerms: ['x'], interestOverTime: false }, /Nothing to collect/],
        [{ searchTerms: ['x'], geo: 'DE', regionResolution: 'DMA' }, /only for the United States/],
        [{ searchTerms: ['x'], geo: 'DE', regionResolution: 'COUNTRY' }, /worldwide/],
        [{ trendingNow: true, trendingHours: 12 }, /4, 24, 48 or 168/],
        [{ searchTerms: ['x'], maxRetries: 50 }, /between 0 and 10/],
    ];
    for (const [input, re] of bad) assert.throws(() => parseInput(input, { now: NOW }), (e) => e instanceof InputError && re.test(e.message), JSON.stringify(input));
});

test('anchor scaling: groups are put on one scale through the anchor, max = 100', () => {
    const mk = (vals) => vals.map((v) => ({ value: v, isPartial: false }));
    // Group 1: anchor peaks at 50 next to a term twice as popular. Group 2: anchor is the most popular (100) next to a small term.
    const groups = [
        { groupId: 1, terms: ['A', 'big'], series: new Map([['A', mk([50, 50])], ['big', mk([100, 100])]]) },
        { groupId: 2, terms: ['A', 'small'], series: new Map([['A', mk([100, 100])], ['small', mk([10, 10])]]) },
    ];
    const r = computeComparable(groups, 'A');
    assert.deepEqual(r.values.get('big'), [100, 100]);
    assert.deepEqual(r.values.get('A'), [50, 50]);
    assert.deepEqual(r.values.get('small'), [5, 5], '10 in a group where the anchor is 100 = 5 on the scale where the anchor is 50');
    assert.deepEqual(r.diagnostics.map((d) => d.scaleFactor), [1, 0.5]);
    const none = computeComparable([{ groupId: 1, terms: ['A', 'x'], series: new Map([['A', mk([0, 0])], ['x', mk([1, 2])]]) }], 'A');
    assert.match(none.error, /no search interest/);
});

test('term item and flat rows', () => {
    const cfg = parseInput({ searchTerms: ['pizza', 'bagel'], interestByRegion: true, relatedQueries: true }, { now: NOW });
    const timeline = { ...parseTimeline(parseGoogleJson(raw('multiline-pizza-bagel-days.txt')), 2, { resolution: 'DAY' }), resolution: 'DAY', timeResolved: '2021-01-01 2021-01-05' };
    const slot = { errors: [], region: { regions: parseGeo(JSON.parse(raw('comparedgeo-single-regions.json'))), resolution: 'REGION' }, queries: parseRelated(parseGoogleJson(raw('relatedsearches-queries-pizza.txt'))) };
    const it = buildTermItem({ term: 'pizza', cfg, group: ['pizza', 'bagel'], groupId: 1, timeline, seriesIdx: 0, slot, tokenSource: 'explore/http', scrapedAt: 'x' });
    assert.equal(it.status, 'ok');
    assert.equal(it.averageInterest, 72);
    assert.equal(it.peakValue, 100);
    assert.equal(it.peakDate, '2021-01-01');
    assert.equal(it.latestValue, 50);
    assert.equal(it.topRegion, 'California');
    assert.equal(it.relatedQueriesTop.length, 25);
    assert.deepEqual(it.comparedWith, ['bagel']);
    const partial = buildTermItem({ term: 'bagel', cfg, group: ['pizza', 'bagel'], groupId: 1, timeline, seriesIdx: 1, slot: { errors: ['related queries: HTTP 429'], region: slot.region }, scrapedAt: 'x' });
    assert.equal(partial.status, 'partial');
    assert.equal(partial.relatedQueriesTop, null);
    const rows = flattenTermItem(it);
    assert.equal(rows.filter((r) => r.rowType === 'term').length, 1);
    assert.equal(rows.filter((r) => r.rowType === 'timeline').length, 5);
    assert.equal(rows.filter((r) => r.rowType === 'region').length, 2);
    assert.equal(rows.filter((r) => r.rowType === 'relatedQuery').length, 36);
    assert.deepEqual(rows.find((r) => r.rowType === 'timeline'), { rowType: 'timeline', term: 'pizza', groupId: 1, geo: 'Worldwide', timeRange: 'today 12-m', date: '2021-01-01', value: 100, isPartial: false, hasData: true });
});
