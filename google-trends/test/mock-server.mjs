// Local mock of the Google Trends endpoints the Actor uses. Responses are built from real recorded Google
// responses (test/fixtures, see SOURCES.json) with the requested keywords substituted in:
//   GET  /trends/explore                      → warmup page (404) that sets NID
//   GET  /trends/api/explore                  → widgets (multi-term / single-term layout as recorded)
//   GET  /trends/embed/explore/:WIDGET        → embeddable widget HTML with JSON.parse('…')
//   GET  /trends/api/widgetdata/multiline     → timeline (shape of the recorded 5-year pizza series, scaled per keyword popularity)
//   GET  /trends/api/widgetdata/comparedgeo   → regions (COUNTRY/REGION from recordings, CITY synthesized with coordinates)
//   GET  /trends/api/widgetdata/relatedsearches → recorded related queries / topics
//   GET  /trending/rss                        → Trending Now RSS (recorded item + more synthesized items)
//   POST /_/TrendsUi/data/batchexecute        → Trending Now i0OFE rows
// Failure injection: 429s, captcha (/sorry/), EU consent page, blocked explore, session-bound tokens.
// Standalone: node test/mock-server.mjs
import http from 'node:http';
import { readFileSync } from 'node:fs';

const raw = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const gjson = (name) => {
    const t = raw(name);
    return JSON.parse(t.startsWith(")]}'") ? t.slice(t.indexOf('\n') + 1) : t);
};
const clone = (x) => JSON.parse(JSON.stringify(x));

const EXPLORE_MULTI = gjson('explore-pizza-bagel-2021.txt');
const EXPLORE_SINGLE = gjson('explore-pizza-2021.txt');
const TIMELINE_5Y = gjson('multiline-pizza-bagel-5y.txt');
const GEO_COUNTRIES = gjson('comparedgeo-compared-countries.txt');
const GEO_REGIONS = gjson('comparedgeo-single-regions.json');
const RELATED_QUERIES = gjson('relatedsearches-queries-pizza.txt');
const RELATED_TOPICS = gjson('relatedsearches-topics-pizza.txt');
const RSS_RECORDED = raw('trending-rss-recorded.xml');
const I0OFE_RECORDED = raw('batchexecute-i0OFE-recorded.txt');
const WARMUP_HTML = raw('warmup-404.html');

/** Relative popularity used to scale the timeline per keyword (anything else = 30). */
export const POPULARITY = { coffee: 100, tea: 60, pizza: 80, bagel: 5, weather: 50, apple: 90, banana: 40, cherry: 20, date: 10, elderberry: 3, fig: 8, grape: 25, lemon: 35, mango: 15 };
const pop = (kw) => POPULARITY[String(kw).toLowerCase()] ?? 30;

const kwItem = (keyword, geo, time) => ({ geo, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: keyword }] }, ...(time ? { time } : {}) });

/** Widgets for an explore request, following the recorded multi-term / single-term layouts. */
function buildWidgets(req, nid) {
    const items = req.comparisonItem;
    const time = items[0].time;
    const geoObj = items[0].geo ? { country: items[0].geo } : {};
    const tok = (id) => `tok_${nid}_${id}`;
    const opts = { property: req.property ?? '', backend: 'IZG', category: req.category ?? 0 };
    const resolvedTime = time.startsWith('today') || time.startsWith('now') || time === 'all' ? '2021-09-27 2026-09-27' : time;
    const tpl = items.length === 1 ? EXPLORE_SINGLE.widgets : EXPLORE_MULTI.widgets;
    const ts = clone(tpl.find((w) => w.id === 'TIMESERIES'));
    ts.request.time = resolvedTime;
    ts.request.resolution = /^now [14]-H$/.test(time) ? 'MINUTE' : /^now/.test(time) ? 'HOUR' : 'WEEK';
    ts.request.comparisonItem = items.map((it) => kwItem(it.keyword, geoObj));
    ts.request.requestOptions = opts;
    ts.token = tok('TIMESERIES');
    const out = [ts];
    if (items.length === 1) {
        const kw = items[0].keyword;
        for (const id of ['GEO_MAP', 'RELATED_TOPICS', 'RELATED_QUERIES']) {
            const w = clone(tpl.find((x) => x.id === id));
            if (w.request.comparisonItem) w.request.comparisonItem = [kwItem(kw, undefined, resolvedTime)];
            if (w.request.restriction) w.request.restriction.complexKeywordsRestriction.keyword[0].value = kw;
            w.request.geo = geoObj;
            w.request.requestOptions = opts;
            w.token = tok(`${id}:${kw}`);
            out.push(w);
        }
        return out;
    }
    const cmp = clone(tpl.find((w) => w.id === 'GEO_MAP'));
    cmp.request.comparisonItem = items.map((it) => ({ time: resolvedTime, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: it.keyword }] } }));
    cmp.token = tok('GEO_MAP');
    out.push(cmp);
    items.forEach((it, i) => {
        out.push({ text: { text: it.keyword }, id: `TITLE_${i}`, type: 'fe_text' });
        const g = clone(tpl.find((x) => x.id === 'GEO_MAP_0'));
        g.id = `GEO_MAP_${i}`;
        g.request.comparisonItem = [{ time: resolvedTime, complexKeywordsRestriction: { keyword: [{ type: 'BROAD', value: it.keyword }] } }];
        g.request.geo = geoObj;
        g.request.requestOptions = opts;
        g.token = tok(`GEO_MAP_${i}:${it.keyword}`);
        out.push(g);
        const rq = clone(tpl.find((x) => x.id === 'RELATED_QUERIES_0'));
        rq.id = `RELATED_QUERIES_${i}`;
        rq.request.restriction.complexKeywordsRestriction.keyword[0].value = it.keyword;
        rq.request.requestOptions = opts;
        rq.token = tok(`RELATED_QUERIES_${i}:${it.keyword}`);
        out.push(rq);
    });
    return out;
}

/** Timeline: the recorded weekly shape of "pizza" (260 points, last partial), scaled by keyword popularity. */
function buildTimeline(request) {
    const kws = request.comparisonItem.map((c) => c.complexKeywordsRestriction.keyword[0].value);
    const base = TIMELINE_5Y.default.timelineData;
    const shape = base.map((r) => r.value[0]);
    const maxShape = Math.max(...shape);
    const maxPop = Math.max(...kws.map(pop));
    const timelineData = base.map((r, t) => {
        const value = kws.map((k) => Math.round((100 * pop(k) * shape[t]) / (maxPop * maxShape)));
        return { ...r, value, hasData: value.map(() => true), formattedValue: value.map(String) };
    });
    const averages = kws.map((_, i) => Math.round(timelineData.reduce((s, r) => s + r.value[i], 0) / timelineData.length));
    return { default: { timelineData, averages } };
}

function buildGeo(request) {
    const res = request.resolution;
    if (res === 'CITY') {
        return { default: { geoMapData: [
            { coordinates: { lat: 40.7127753, lng: -74.0059728 }, geoName: 'New York', value: [100], formattedValue: ['100'], maxValueIndex: 0, hasData: [true] },
            { coordinates: { lat: 34.0522342, lng: -118.2436849 }, geoName: 'Los Angeles', value: [71], formattedValue: ['71'], maxValueIndex: 0, hasData: [true] },
            { coordinates: { lat: 41.8781136, lng: -87.6297982 }, geoName: 'Chicago', value: [64], formattedValue: ['64'], maxValueIndex: 0, hasData: [true] },
        ] } };
    }
    if (res === 'REGION' || res === 'DMA') return clone(GEO_REGIONS);
    // COUNTRY: the recorded 250-country map, first value only (a per-term widget has one value per region).
    const g = clone(GEO_COUNTRIES);
    for (const r of g.default.geoMapData) {
        r.value = [r.value[0]];
        r.formattedValue = [String(r.value[0])];
        r.hasData = [r.hasData[0]];
    }
    if (!request.includeLowSearchVolumeGeos) g.default.geoMapData = g.default.geoMapData.filter((r) => r.hasData[0]);
    return g;
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildRss(geo) {
    const extra = [
        ['world series', '500K+', 'Game 7 goes to extra innings', 'ESPN'],
        ['hurricane update', '200K+', 'Storm strengthens off the coast', 'Weather Channel'],
        ['new phone launch', '100K+', 'Pre-orders open today', 'The Verge'],
        ['election results', '50K+', 'Counting continues overnight', 'Reuters'],
        ['movie premiere', '20K+', 'Critics react to the premiere', 'Variety'],
        ['stock market', '10K+', 'Markets open higher', 'Bloomberg'],
        ['recipe of the day', '5K+', 'A simple autumn soup', 'NYT Cooking'],
        ['local marathon', '2K+', 'Road closures announced', 'Local News'],
        ['space launch', '2K+', 'Rocket lifts off at dawn', 'NASA'],
        ['concert tickets', '1K+', 'Tour dates announced', 'Billboard'],
        ['science fair', '1K+', 'Students win top prize', 'AP'],
        ['holiday deals', '1K+', 'Early deals start', 'CNET'],
    ].map(([t, traffic, news, src], i) => `
    <item>
      <title>${xmlEsc(t)}</title>
      <ht:approx_traffic>${traffic}</ht:approx_traffic>
      <description/>
      <link>https://trends.google.com/trending/rss?geo=${geo}</link>
      <pubDate>Sat, 27 Sep 2026 0${i % 10}:10:00 -0700</pubDate>
      <ht:picture>https://example.com/${i}.jpg</ht:picture>
      <ht:picture_source>${xmlEsc(src)}</ht:picture_source>
      <ht:news_item>
        <ht:news_item_title>${xmlEsc(news)}</ht:news_item_title>
        <ht:news_item_url>https://example.com/news/${i}</ht:news_item_url>
        <ht:news_item_picture>https://example.com/news/${i}.jpg</ht:news_item_picture>
        <ht:news_item_source>${xmlEsc(src)}</ht:news_item_source>
      </ht:news_item>
    </item>`).join('');
    return RSS_RECORDED.replace(/geo=US/g, `geo=${geo}`).replace('</item>', `</item>${extra}`);
}

function buildI0OFE(inner) {
    const geo = inner?.[2] ?? 'US';
    const frame = JSON.parse(I0OFE_RECORDED.slice(I0OFE_RECORDED.indexOf('\n') + 1).trim());
    const payload = JSON.parse(frame[0][2]);
    const now = 1790000000;
    const more = ['world series', 'hurricane update', 'new phone launch', 'election results', 'movie premiere'].map((t, i) => [t, null, geo, [now - 3600 * (i + 1)], i === 2 ? [now - 600] : null, null, [2000000, 500000, 100000, 50000, 20000][i], null, [1000, 500, 300, 200, 100][i], [t, `${t} live`], [17, 20, 18, 14, 4].slice(i, i + 1), [[i + 10, 'en', geo]], t]);
    payload[1] = [...payload[1].map((r) => { r[2] = geo; return r; }), ...more];
    return `)]}'\n\n${JSON.stringify([['wrb.fr', 'i0OFE', JSON.stringify(payload), null, null, null, 'generic'], ['di', 51], ['af.httprm', 50, '123', 1]])}\n`;
}

/** Embed page: the widget as JSON.parse('…') with \x escapes, like trends.google.com/trends/embed/explore/*. */
export const embedHtml = (widget) => {
    const esc = JSON.stringify(widget).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[{}"[\]]/g, (c) => `\\x${c.charCodeAt(0).toString(16)}`);
    return `<!doctype html><html><head><title>Google Trends embed</title></head><body><div id="root"></div><script nonce="x">var trends = {}; trends.embed = {}; trends.embed.renderWidget = function(){};
trends.embed.renderExploreWidget("${widget.id}", JSON.parse('${esc}'), {"exploreQuery":"q=x","guestPath":"https://trends.google.com:443/trends/embed/"});</script></body></html>`;
};

const CONSENT_HTML = (cont) => `<!doctype html><html><head><title>Before you continue to Google</title></head><body>
<h1>Before you continue to Google</h1><p>We use cookies and data to deliver and maintain Google services.</p>
<form action="/save" method="GET"><input type="hidden" name="continue" value="${cont.replace(/"/g, '&quot;')}"><button type="submit" aria-label="Accept all">Accept all</button></form>
</body></html>`;
const CAPTCHA_HTML = '<!doctype html><html><head><title>Sorry...</title></head><body><div>Our systems have detected unusual traffic from your computer network.</div><form id="captcha-form"><div class="g-recaptcha"></div></form></body></html>';
const HTML_429 = '<!DOCTYPE html><html lang=en><meta charset=utf-8><title>Error 429 (Too Many Requests)!!1</title><p><b>429.</b> <ins>That’s an error.</ins><p>We\'re sorry, but you have sent too many requests to us recently. Please try again later. <ins>That’s all we know.</ins>';

export async function startMockServer() {
    const state = {};
    const reset = () => Object.assign(state, {
        requests: [],
        rateLimit: [], // [{ re: RegExp, count: N }] → next N matching requests answer 429
        captchaNext: 0,
        consent: 'none', // 'always' → every Trends page needs the consent click (HTTP can't pass, the browser can)
        exploreBlocked: false, // /api/explore always 429 → forces the embed fallback
        exploreGetRefused: false, // /api/explore only accepts POST (as pytrends sends it)
        tokenBound: false, // widget tokens are only valid with the NID of the session that got them
        exploreBodies: [],
        widgetRequests: [],
        nidCounter: 0,
        retryAfter: null,
    });
    reset();

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            state.requests.push(`${req.method} ${url.pathname}${url.search.slice(0, 200)}`);
            const cookie = req.headers.cookie ?? '';
            const nid = cookie.match(/NID=([^;]+)/)?.[1] ?? 'none';
            const send = (code, text, headers = {}) => {
                res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
                res.end(text);
            };
            const json = (obj, prefix = ")]}',\n") => send(200, prefix + JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
            const p = url.pathname;
            const guarded = p.startsWith('/trends') || p.startsWith('/trending') || p.startsWith('/_/');

            if (p === '/consent') return send(200, CONSENT_HTML(url.searchParams.get('continue') ?? '/'));
            if (p === '/save') return send(302, '', { location: url.searchParams.get('continue') || '/trends/explore', 'set-cookie': 'SOCS=ACCEPTED; Path=/' });
            if (p.startsWith('/sorry/')) return send(429, CAPTCHA_HTML);
            if (guarded && state.consent === 'always' && !cookie.includes('SOCS=ACCEPTED')) {
                if (req.method === 'POST' || p.startsWith('/trends/api')) return send(302, '', { location: `/consent?continue=${encodeURIComponent(req.url)}` });
                return send(302, '', { location: `/consent?continue=${encodeURIComponent(req.url)}` });
            }
            if (p === '/trends/explore') {
                state.nidCounter++;
                return send(404, WARMUP_HTML, { 'set-cookie': `NID=511=mock${state.nidCounter}; expires=Mon, 25-Sep-2027 08:09:16 GMT; path=/; domain=.google.com; HttpOnly` });
            }
            if (guarded && state.captchaNext > 0) {
                state.captchaNext--;
                return send(302, '', { location: `/sorry/index?continue=${encodeURIComponent(req.url)}` });
            }
            const rl = state.rateLimit.find((r) => r.count > 0 && r.re.test(`${req.method} ${p}`));
            if (rl || (state.exploreBlocked && p === '/trends/api/explore')) {
                if (rl) rl.count--;
                return send(429, HTML_429, state.retryAfter ? { 'retry-after': String(state.retryAfter) } : {});
            }

            if (p === '/trends/api/explore') {
                if (state.exploreGetRefused && req.method === 'GET') return send(405, 'Method Not Allowed');
                let r;
                try {
                    r = JSON.parse(url.searchParams.get('req'));
                } catch {
                    return send(400, 'bad req');
                }
                state.exploreBodies.push({ method: req.method, req: r, hl: url.searchParams.get('hl'), tz: url.searchParams.get('tz') });
                return json({ widgets: buildWidgets(r, nid) }, ")]}'\n");
            }
            const emb = p.match(/^\/trends\/embed\/explore\/(TIMESERIES|GEO_MAP|RELATED_QUERIES|RELATED_TOPICS)$/);
            if (emb) {
                const r = JSON.parse(url.searchParams.get('req'));
                const ws = buildWidgets(r, nid);
                const id = emb[1];
                let w = ws.find((x) => x.id === id) ?? ws.find((x) => x.id.startsWith(`${id}_`));
                if (id === 'RELATED_TOPICS' && r.comparisonItem.length > 1) return send(400, 'embed related topics need one keyword');
                w = { ...w, id, request: { ...w.request, userConfig: { userType: 'USER_TYPE_EMBED' } } };
                return send(200, embedHtml(w));
            }
            const wd = p.match(/^\/trends\/api\/widgetdata\/(multiline|comparedgeo|relatedsearches)$/);
            if (wd) {
                const token = url.searchParams.get('token') ?? '';
                let request;
                try {
                    request = JSON.parse(url.searchParams.get('req'));
                } catch {
                    return send(400, 'bad req');
                }
                state.widgetRequests.push({ kind: wd[1], request, token, tz: url.searchParams.get('tz'), hl: url.searchParams.get('hl') });
                if (!token.startsWith('tok_')) return send(401, 'unauthorized');
                if (state.tokenBound && token.split('_')[1] !== nid) return send(401, '<html>Unauthorized</html>');
                if (wd[1] === 'multiline') return json(buildTimeline(request));
                if (wd[1] === 'comparedgeo') return json(buildGeo(request));
                const kw = request.restriction?.complexKeywordsRestriction?.keyword?.[0]?.value ?? '';
                if (/^empty/i.test(kw)) return json({ default: { rankedList: [{ rankedKeyword: [] }, { rankedKeyword: [] }] } });
                return json(request.keywordType === 'ENTITY' ? RELATED_TOPICS : RELATED_QUERIES);
            }
            if (p === '/trending/rss') return send(200, buildRss(url.searchParams.get('geo') || 'US'), { 'content-type': 'application/rss+xml; charset=utf-8' });
            if (req.method === 'POST' && p === '/_/TrendsUi/data/batchexecute') {
                let inner = null;
                try {
                    inner = JSON.parse(JSON.parse(new URLSearchParams(body).get('f.req'))[0][0][1]);
                } catch {
                    return send(400, 'bad request');
                }
                state.batchInner = inner;
                return send(200, buildI0OFE(inner), { 'content-type': 'application/json; charset=utf-8' });
            }
            return send(404, 'not found');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return { url: `http://127.0.0.1:${port}`, state, reset, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const s = await startMockServer();
    console.log(`Mock Google Trends at ${s.url}`);
}
