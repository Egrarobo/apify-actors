import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edition, searchQueryText, searchFeedUrl, topicFeedUrl, locationFeedUrl, parseFeed, cleanTitle, dayWindows, decodeEntities } from '../src/feeds.js';
import { decodeOffline, parseArticlePage, batchBody, parseBatchResponse } from '../src/decode.js';
import { parsePublisherHead } from '../src/publisher.js';
import { parseInput, limitProxy, InputError } from '../src/input.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-09T00:00:00Z');

test('edition: hl / gl / ceid like the Google News editions', () => {
    assert.deepEqual(edition('en-US', 'US'), { hl: 'en-US', gl: 'US', ceid: 'US:en' });
    assert.deepEqual(edition('en', 'GB'), { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' });
    assert.deepEqual(edition('ro', 'RO'), { hl: 'ro', gl: 'RO', ceid: 'RO:ro' });
    assert.deepEqual(edition('pt-BR', 'BR'), { hl: 'pt-BR', gl: 'BR', ceid: 'BR:pt-419' });
    assert.deepEqual(edition('es-419', 'MX'), { hl: 'es-419', gl: 'MX', ceid: 'MX:es-419' });
    assert.deepEqual(edition('de', 'AT'), { hl: 'de', gl: 'AT', ceid: 'AT:de' });
});

test('feed URLs: search with period operators, topic and location', () => {
    const ed = edition('en-US', 'US');
    assert.equal(searchQueryText('OpenAI', { when: '7d' }), 'OpenAI when:7d');
    assert.equal(searchQueryText('"climate change" site:reuters.com', { after: '2026-10-01', before: '2026-10-02', when: '7d' }), '"climate change" site:reuters.com after:2026-10-01 before:2026-10-02');
    assert.equal(searchFeedUrl('https://news.google.com', ed, 'OpenAI when:7d'), 'https://news.google.com/rss/search?q=OpenAI+when%3A7d&hl=en-US&gl=US&ceid=US%3Aen');
    assert.equal(topicFeedUrl('https://news.google.com', ed, 'business'), 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US%3Aen');
    assert.equal(locationFeedUrl('https://news.google.com', ed, 'New York'), 'https://news.google.com/rss/headlines/section/geo/New%20York?hl=en-US&gl=US&ceid=US%3Aen');
});

test('parseFeed: real search feed (OpenAI, 9 Oct 2026)', () => {
    const f = parseFeed(fx('search-openai.xml'));
    assert.equal(f.ok, true);
    assert.equal(f.title, '"OpenAI" - Google News');
    assert.equal(f.items.length, 12);
    const a = f.items[0];
    assert.equal(a.title, 'Nvidia, Oracle, CoreWeave and other AI stocks sink on OpenAI revenue report');
    assert.equal(a.source, 'CNBC');
    assert.equal(a.sourceUrl, 'https://www.cnbc.com');
    assert.equal(a.publishedAt, '2026-10-08T18:14:54.000Z');
    assert.match(a.googleNewsUrl, /^https:\/\/news\.google\.com\/rss\/articles\/CBMi.+\?oc=5$/);
    assert.ok(a.articleId.startsWith('CBMi'));
    for (const it of f.items) {
        assert.ok(it.title && it.source && it.publishedAt && it.googleNewsUrl, JSON.stringify(it));
        assert.ok(!it.title.endsWith(` - ${it.source}`));
    }
});

test('parseFeed: Romanian feed keeps diacritics; topic feed has clustered related coverage', () => {
    const ro = parseFeed(fx('search-moldova-ro.xml'));
    assert.equal(ro.title, '"Moldova" - Știri Google');
    assert.match(ro.items[0].title, /înaltă tensiune/);
    const biz = parseFeed(fx('topic-business.xml'));
    assert.equal(biz.items.length, 12);
    const withRelated = biz.items.filter((i) => i.related.length);
    assert.ok(withRelated.length > 0);
    const r = withRelated[0].related[0];
    assert.ok(r.title && r.source && r.googleNewsUrl.startsWith('https://news.google.com/'));
});

test('parseFeed: non-feed bodies are rejected', () => {
    assert.equal(parseFeed('<html><body>Before you continue to Google</body></html>').ok, false);
    assert.equal(parseFeed('').ok, false);
});

test('cleanTitle and entities', () => {
    assert.equal(cleanTitle('Big news - The New York Times', 'The New York Times'), 'Big news');
    assert.equal(cleanTitle('A - B - Reuters', 'Reuters'), 'A - B');
    assert.equal(cleanTitle('No suffix here', 'CNBC'), 'No suffix here');
    assert.equal(decodeEntities('Tom &amp; Jerry &#8217;s &#x41;'), 'Tom & Jerry ’s A');
});

test('decodeOffline: old ids carry the URL, new AU_yqL ids need the online decoder', () => {
    const url = 'https://www.example.com/2024/01/02/story.html';
    const buf = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, url.length]), Buffer.from(url), Buffer.from([0xd2, 0x01, 0x00])]);
    const id = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodeOffline(id), url);
    const realNewId = parseFeed(fx('search-openai.xml')).items[0].articleId;
    assert.equal(decodeOffline(realNewId), null);
    assert.equal(decodeOffline(''), null);
});

test('batchexecute: body round trip and real answer parsing', () => {
    const body = batchBody([{ articleId: 'AAA', timestamp: 1, signature: 'S1' }, { articleId: 'BBB', timestamp: 2, signature: 'S2' }]);
    const freq = JSON.parse(decodeURIComponent(body.slice('f.req='.length)));
    assert.equal(freq[0].length, 2);
    assert.equal(freq[0][1][0], 'Fbv4je');
    assert.equal(freq[0][1][3], '2');
    assert.deepEqual(JSON.parse(freq[0][1][1]).slice(2), ['BBB', 2, 'S2']);
    // Real answer captured on 9 Oct 2026 (two articles, "generic" index).
    const map = parseBatchResponse(fx('batchexecute-response.txt'));
    assert.ok([...map.values()].some((u) => u.startsWith('https://www.cnbc.com/2026/10/08/')));
    assert.equal(parseBatchResponse('garbage').size, 0);
    assert.deepEqual(parseArticlePage('<div data-n-a-ts="1760" data-n-a-sg="AbC_1"></div>'), { signature: 'AbC_1', timestamp: 1760 });
    assert.equal(parseArticlePage('<html></html>'), null);
});

test('publisher head: description, image, author, canonical', () => {
    const d = parsePublisherHead('<html lang="en-GB"><head><meta name="description" content="Plain"><meta property="og:description" content="Rich &amp; long"><meta content="https://i/x.jpg" property="og:image"><meta name="author" content="A. Writer"><link rel="canonical" href="https://site/a"></head><body><meta name="author" content="ignored"></body>');
    assert.equal(d.snippet, 'Rich & long');
    assert.equal(d.author, 'A. Writer');
    assert.equal(d.canonicalUrl, 'https://site/a');
    assert.equal(d.language, 'en-GB');
    // A profile link is not an author name (seen on rfi.fr, 9 Oct 2026).
    assert.equal(parsePublisherHead('<head><meta name="author" content="https://www.facebook.com/RFI.Romania.FM/"></head>').author, null);
});

test('parseInput: defaults, validation and day splitting above 100 articles', () => {
    const c = parseInput({ queries: ['OpenAI', 'openai', ' '] }, { now: NOW });
    assert.deepEqual(c.queries, ['OpenAI']);
    assert.equal(c.maxArticlesPerFeed, 100);
    assert.equal(c.decodeUrls, true);
    assert.deepEqual(c.searchWindows, [{ when: null }]);
    assert.deepEqual(c.edition, { hl: 'en-US', gl: 'US', ceid: 'US:en' });
    const t = parseInput({ topics: ['TOP_STORIES', 'business'] }, { now: NOW });
    assert.equal(t.topStories, true);
    assert.deepEqual(t.topics, ['BUSINESS']);
    const w = parseInput({ queries: ['x'], timeRange: '7d', maxArticlesPerFeed: 500 }, { now: NOW });
    assert.equal(w.searchWindows.length, 7);
    assert.deepEqual(w.searchWindows[0], { after: '2026-10-09', before: '2026-10-10', day: '2026-10-09' });
    const cu = parseInput({ queries: ['x'], timeRange: 'custom', dateFrom: '2026-10-01', dateTo: '2026-10-03' }, { now: NOW });
    assert.deepEqual(cu.searchWindows, [{ after: '2026-10-01', before: '2026-10-04' }]);
    assert.equal(dayWindows('2026-10-01', '2026-10-03').length, 3);
    assert.throws(() => parseInput({}), InputError);
    assert.throws(() => parseInput({ topics: ['POLITICS'] }), /Unknown topic/);
    assert.throws(() => parseInput({ queries: ['x'], country: 'USA' }), /country/);
    assert.throws(() => parseInput({ queries: ['x'], timeRange: 'custom' }), /dateFrom/);
    assert.throws(() => parseInput({ queries: ['x'], maxArticlesPerFeed: 0 }), /maxArticlesPerFeed/);
});

test('limitProxy removes RESIDENTIAL and GOOGLE_SERP', () => {
    assert.deepEqual(limitProxy({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL', 'GOOGLE_SERP'] }), { proxy: { useApifyProxy: true }, removedGroups: ['RESIDENTIAL', 'GOOGLE_SERP'] });
    assert.deepEqual(limitProxy({ useApifyProxy: true }).removedGroups, []);
});
