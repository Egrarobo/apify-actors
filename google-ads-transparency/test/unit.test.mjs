import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreatives, parseCreativeDetail, parseSuggestions, parseRpcJson, tsToIso, pickAdvertiser, findYoutubeId, creativeUrl } from '../src/parse.js';
import { classifyQuery, parseInput, resolvePeriod, limitProxy, InputError } from '../src/input.js';
import { geoIdFromCountry, countryFromGeoId, ISO_NUMERIC } from '../src/regions.js';
import { isBlockedAnswer } from '../src/atc.js';
import { fixture } from './helpers.mjs';

test('parseCreatives: real Nike page (5 ads, next token, reported total)', () => {
    const r = parseCreatives(fixture('creatives-nike-p1.json'));
    assert.equal(r.ads.length, 5);
    assert.equal(r.totalMin, 8000);
    assert.equal(r.totalMax, 9000);
    assert.ok(r.nextPageToken);
    const a = r.ads[0];
    assert.equal(a.advertiserId, 'AR16735076323512287233');
    assert.equal(a.advertiserName, 'Nike, Inc.');
    assert.equal(a.adId, 'CR16080400334098268161');
    assert.equal(a.format, 'TEXT');
    assert.equal(a.firstShown, '2023-11-16T23:49:45.279Z');
    assert.match(a.lastShown, /^2026-10-0/);
    assert.equal(a.imageUrl, 'https://tpc.googlesyndication.com/archive/simgad/12353189800749445678');
    assert.equal(a.previewUrl, null);
    const img = r.ads[2];
    assert.equal(img.format, 'IMAGE');
    assert.match(img.previewUrl, /^https:\/\/displayads-formats\.googleusercontent\.com\/ads\/preview\/content\.js\?/);
    assert.equal(img.imageUrl, null);
});

test('parseCreativeDetail: regions with country codes and names, variants', () => {
    const d = parseCreativeDetail(fixture('detail-nike-image.json'));
    assert.equal(d.adId, 'CR09534993337476448257');
    assert.equal(d.advertiserName, 'Nike, Inc.');
    assert.deepEqual(d.regions, [{ code: 'US', name: 'United States' }]);
    assert.equal(d.variants.length, 3);
    assert.equal(d.formatCode, 2);
    assert.throws(() => parseCreativeDetail({}), /no creative/);
});

test('parseSuggestions: advertisers with ad ranges, and domains', () => {
    const s = parseSuggestions(fixture('suggestions-nike.json'));
    assert.equal(s.advertisers.length, 10);
    assert.ok(s.domains.includes('nike.com'));
    const inc = s.advertisers.find((a) => a.id === 'AR16735076323512287233');
    assert.deepEqual(inc, { id: 'AR16735076323512287233', name: 'Nike, Inc.', country: 'US', adsMin: 9000, adsMax: 10000 });
});

test('pickAdvertiser: exact name wins, then prefix with most ads; nothing for unrelated names', () => {
    const { advertisers } = parseSuggestions(fixture('suggestions-nike.json'));
    assert.equal(pickAdvertiser('Nike, Inc.', advertisers).advertiser.id, 'AR16735076323512287233');
    assert.equal(pickAdvertiser('nike inc', advertisers).advertiser.id, 'AR16735076323512287233');
    assert.equal(pickAdvertiser('Nike', advertisers).advertiser.id, 'AR06641858037806006273', 'exact "Nike" beats bigger "Nike, Inc."');
    assert.equal(pickAdvertiser('Nike Kl', advertisers).advertiser.name, 'Nike Klara');
    assert.equal(pickAdvertiser('Adidas', advertisers).advertiser, null);
});

test('helpers: timestamps, YouTube ids, links, JSON guard, block detection', () => {
    assert.equal(tsToIso({ 1: '1700000000', 2: 500000000 }), '2023-11-14T22:13:20.500Z');
    assert.equal(tsToIso(null), null);
    assert.equal(findYoutubeId({ a: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }), 'dQw4w9WgXcQ');
    assert.equal(findYoutubeId({ a: 'no video' }), null);
    assert.equal(creativeUrl('AR1', 'CR2', 'US'), 'https://adstransparency.google.com/advertiser/AR1/creative/CR2?region=US');
    assert.deepEqual(parseRpcJson(")]}'\n{\"1\":2}"), { 1: 2 });
    assert.throws(() => parseRpcJson('<html>'), /Not a JSON answer/);
    assert.ok(isBlockedAnswer({ status: 302, url: 'https://www.google.com/sorry/index?x', text: '' }));
    assert.ok(isBlockedAnswer({ status: 429, url: '', text: '' }));
    assert.ok(!isBlockedAnswer({ status: 200, url: 'https://adstransparency.google.com/anji', text: '{"1":[]}' }));
});

test('regions: ISO codes map to Google geo IDs and back', () => {
    assert.equal(Object.keys(ISO_NUMERIC).length, 249);
    assert.equal(geoIdFromCountry('us'), 2840);
    assert.equal(geoIdFromCountry('GB'), 2826);
    assert.equal(geoIdFromCountry('MD'), 2498);
    assert.equal(geoIdFromCountry('anywhere'), null);
    assert.equal(geoIdFromCountry('XX'), undefined);
    assert.deepEqual(countryFromGeoId(2276), { code: 'DE', name: 'Germany' });
    assert.equal(countryFromGeoId(9999).code, null);
});

test('classifyQuery: domains, links, advertiser IDs, names', () => {
    assert.deepEqual(classifyQuery('nike.com'), { type: 'domain', value: 'nike.com', input: 'nike.com' });
    assert.equal(classifyQuery('https://www.Nike.com/shoes').value, 'nike.com');
    assert.equal(classifyQuery('www.bbc.co.uk').value, 'bbc.co.uk');
    assert.deepEqual(classifyQuery('AR16735076323512287233'), { type: 'advertiserId', value: 'AR16735076323512287233', input: 'AR16735076323512287233' });
    assert.equal(classifyQuery('https://adstransparency.google.com/advertiser/AR16735076323512287233?region=US').type, 'advertiserId');
    assert.equal(classifyQuery('Nike, Inc.').type, 'advertiserName');
    assert.equal(classifyQuery('Booking.com B.V.').type, 'advertiserName', 'names with spaces stay names');
    assert.equal(classifyQuery('  '), null);
});

test('parseInput: defaults, validation, de-duplication', () => {
    const c = parseInput({ searchTerms: ['nike.com', 'NIKE.com', 'Nike, Inc.'] });
    assert.equal(c.queries.length, 2);
    assert.equal(c.region, 'anywhere');
    assert.equal(c.geoId, null);
    assert.equal(c.maxAdsPerQuery, 50);
    assert.equal(c.includeDetails, true);
    assert.equal(c.requestDelayMs, 2000);
    assert.equal(c.formatCode, null);
    const v = parseInput({ searchTerms: ['x.com'], region: 'gb', format: 'video', maxAdsPerQuery: 5, includeDetails: false });
    assert.equal(v.geoId, 2826);
    assert.equal(v.region, 'GB');
    assert.equal(v.formatCode, 3);
    assert.throws(() => parseInput({}), InputError);
    assert.throws(() => parseInput({ searchTerms: ['x.com'], region: 'Narnia' }), /Unknown "region"/);
    assert.throws(() => parseInput({ searchTerms: ['x.com'], format: 'gif' }), /Unknown "format"/);
    assert.throws(() => parseInput({ searchTerms: ['x.com'], requestDelaySecs: 0.2 }), /requestDelaySecs/);
    assert.throws(() => parseInput({ searchTerms: ['x.com'], maxAdsPerQuery: 0 }), /maxAdsPerQuery/);
});

test('resolvePeriod: presets and custom dates', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    assert.equal(resolvePeriod({ period: 'anytime' }, now), null);
    assert.deepEqual(resolvePeriod({ period: 'last7days' }, now), { from: 20261003, to: 20261009 });
    assert.deepEqual(resolvePeriod({ period: 'last30days' }, now), { from: 20260910, to: 20261009 });
    assert.deepEqual(resolvePeriod({ period: 'custom', startDate: '2026-01-01', endDate: '2026-03-31' }, now), { from: 20260101, to: 20260331 });
    assert.deepEqual(resolvePeriod({ period: 'custom', startDate: '2026-09-01' }, now), { from: 20260901, to: 20261009 });
    assert.throws(() => resolvePeriod({ period: 'custom' }, now), /startDate/);
    assert.throws(() => resolvePeriod({ period: 'custom', startDate: '2026-05-01', endDate: '2026-04-01' }, now), /before/);
    assert.throws(() => resolvePeriod({ period: 'custom', startDate: '01/05/2026' }, now), /date like/);
});

test('limitProxy: removes RESIDENTIAL and GOOGLE_SERP, keeps the rest', () => {
    assert.deepEqual(limitProxy({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }), { proxy: { useApifyProxy: true }, removedGroups: ['RESIDENTIAL'] });
    assert.deepEqual(limitProxy({ useApifyProxy: true, apifyProxyGroups: ['google_serp', 'BUYPROXIES94952'] }).proxy.apifyProxyGroups, ['BUYPROXIES94952']);
    const own = { useApifyProxy: false, proxyUrls: ['http://u:p@my.proxy:8000'] };
    assert.equal(limitProxy(own).proxy, own);
});
