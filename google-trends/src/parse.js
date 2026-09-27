// Parsers for Google Trends responses. All shapes are checked against real recorded responses in test/fixtures.

export class DecodeError extends Error {}

/**
 * Google prefixes JSON with an anti-XSSI line: ")]}'" (explore) or ")]}'," (widgetdata), then a newline.
 * pytrends trims 4 or 5 characters; here everything up to the first newline is dropped when the prefix is present.
 */
export function stripXssiPrefix(text) {
    const s = String(text ?? '');
    const t = s.trimStart();
    if (!t.startsWith(")]}'")) return s;
    const nl = t.indexOf('\n');
    return nl === -1 ? t.replace(/^\)\]\}',?/, '') : t.slice(nl + 1);
}

export function parseGoogleJson(text) {
    const body = stripXssiPrefix(text).trim();
    if (!body) throw new DecodeError('empty response body');
    if (body.startsWith('<')) throw new DecodeError('HTML instead of JSON');
    try {
        return JSON.parse(body);
    } catch (err) {
        throw new DecodeError(`invalid JSON (${err.message.slice(0, 80)}): ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
}

/** What kind of page came back: data, consent wall, captcha, rate limit or HTTP error. */
export function classifyResponse({ status, url = '', text = '' }) {
    const head = String(text).slice(0, 100_000);
    const lower = head.toLowerCase();
    let host = '';
    let pathname = '';
    try {
        ({ hostname: host, pathname } = new URL(url));
    } catch { /* ignore */ }
    const consent = /^consent\./i.test(host)
        || (/^\/consent\b/.test(pathname) && /<form[^>]+action="[^"]*\/save"/i.test(head))
        || /action="https:\/\/consent\.google\.[a-z.]+\/save"/i.test(head)
        || (/<title>\s*Before you continue/i.test(head) && /<form[^>]+action="[^"]*\/save"/i.test(head));
    const captcha = /\/sorry\/(index)?/.test(url)
        || lower.includes('our systems have detected unusual traffic')
        || lower.includes('id="captcha-form"');
    const rateLimited = status === 429 || (lower.includes('error 429') && lower.includes('too many requests'));
    let kind = 'ok';
    if (captcha) kind = 'captcha';
    else if (consent) kind = 'consent';
    else if (rateLimited) kind = 'rate-limited';
    else if (status === 403) kind = 'blocked';
    else if (status === 401) kind = 'unauthorized';
    else if (status >= 400) kind = 'http-error';
    return { kind, consent, captcha, rateLimited, status };
}

// ── explore / widgets ───────────────────────────────────────────────────────────────────────

export function parseExplore(json) {
    const widgets = json?.widgets;
    if (!Array.isArray(widgets)) throw new DecodeError('explore response has no "widgets" list');
    return widgets.filter((w) => w && typeof w === 'object' && w.id);
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** Keywords a widget is about (one for per-term widgets, all terms for TIMESERIES / compared GEO_MAP). */
export function widgetKeywords(widget) {
    const r = widget?.request ?? {};
    const fromItems = (items) => (items ?? []).map((it) => it?.complexKeywordsRestriction?.keyword?.[0]?.value).filter((v) => v !== undefined);
    if (Array.isArray(r.comparisonItem)) return fromItems(r.comparisonItem);
    const kw = r.restriction?.complexKeywordsRestriction?.keyword?.[0]?.value;
    return kw !== undefined ? [kw] : [];
}

/**
 * Picks the widgets needed for `terms` (same order as the explore request).
 * Multi-term explore → TIMESERIES, GEO_MAP (compared), GEO_MAP_i, RELATED_QUERIES_i (no related topics).
 * Single-term explore → TIMESERIES, GEO_MAP, RELATED_TOPICS, RELATED_QUERIES (verified on recorded responses).
 */
export function selectWidgets(widgets, terms) {
    const out = { timeseries: null, comparedGeo: null, geo: new Map(), relatedQueries: new Map(), relatedTopics: new Map() };
    const single = terms.length === 1;
    const byTerm = (w, fallbackIdx) => {
        const kws = widgetKeywords(w);
        if (kws.length === 1) {
            const i = terms.findIndex((t) => norm(t) === norm(kws[0]));
            if (i !== -1) return terms[i];
        }
        return fallbackIdx !== null && fallbackIdx < terms.length ? terms[fallbackIdx] : null;
    };
    for (const w of widgets) {
        const id = String(w.id);
        if (!w.token) continue;
        const m = id.match(/^(TIMESERIES|GEO_MAP|RELATED_QUERIES|RELATED_TOPICS)(?:_(\d+))?$/);
        if (!m) continue;
        const [, kind, idx] = m;
        const fallbackIdx = idx !== undefined ? Number(idx) : single ? 0 : null;
        if (kind === 'TIMESERIES') out.timeseries = w;
        else if (kind === 'GEO_MAP') {
            if (w.type === 'fe_multi_heat_map' || (!single && idx === undefined)) out.comparedGeo = w;
            else {
                const t = byTerm(w, fallbackIdx);
                if (t !== null && !out.geo.has(t)) out.geo.set(t, w);
            }
        } else {
            const isTopics = kind === 'RELATED_TOPICS' || w.request?.keywordType === 'ENTITY';
            const t = byTerm(w, fallbackIdx);
            if (t === null) continue;
            const map = isTopics ? out.relatedTopics : out.relatedQueries;
            if (!map.has(t)) map.set(t, w);
        }
    }
    return out;
}

/** Embeddable widget page → the widget object (trendspy `_extract_embedded_data`: JSON.parse('…') with \x escapes). */
export function parseEmbedHtml(html) {
    const m = String(html).match(/JSON\.parse\('((?:[^'\\]|\\.)*)'\)/);
    if (!m) throw new DecodeError('no widget data in the embed page');
    const decoded = m[1]
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    let w;
    try {
        w = JSON.parse(decoded);
    } catch (err) {
        throw new DecodeError(`embed widget JSON could not be parsed: ${err.message}`);
    }
    if (!w?.token || !w?.request) throw new DecodeError('embed widget has no token');
    return w;
}

// ── widget data ────────────────────────────────────────────────────────────────────────────

const FINE_RESOLUTIONS = /MINUTE|HOUR/i;

/** multiline → per comparison-item series of { date, timestamp, value, hasData, isPartial, formattedTime } + Google's averages. */
export function parseTimeline(json, count, { resolution = '' } = {}) {
    const d = json?.default;
    if (!d || !Array.isArray(d.timelineData)) throw new DecodeError('multiline response has no timelineData');
    const fine = FINE_RESOLUTIONS.test(resolution);
    const series = Array.from({ length: count }, () => []);
    for (const row of d.timelineData) {
        const ts = Number(row.time);
        const iso = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;
        for (let i = 0; i < count; i++) {
            const v = row.value?.[i];
            series[i].push({
                date: iso ? (fine ? iso.replace('.000Z', 'Z') : iso.slice(0, 10)) : null,
                timestamp: Number.isFinite(ts) ? ts : null,
                value: typeof v === 'number' ? v : v === undefined || v === null || v === '' ? null : Number(v),
                hasData: row.hasData ? row.hasData[i] !== false : true,
                isPartial: row.isPartial === true,
                formattedTime: row.formattedTime ?? null,
            });
        }
    }
    const averages = Array.isArray(d.averages) && d.averages.length ? d.averages : null;
    return { series, averages };
}

/** comparedgeo → regions for value index `idx` (per-term widgets have one value). CITY resolution uses coordinates. */
export function parseGeo(json, { idx = 0, includeNoData = false } = {}) {
    const d = json?.default;
    if (!d || !Array.isArray(d.geoMapData)) throw new DecodeError('comparedgeo response has no geoMapData');
    const rows = [];
    for (const g of d.geoMapData) {
        const hasData = Array.isArray(g.hasData) ? g.hasData[idx] !== false : true;
        if (!hasData && !includeNoData) continue;
        const v = g.value?.[idx];
        rows.push({
            geoCode: g.geoCode ?? null,
            geoName: g.geoName ?? null,
            value: typeof v === 'number' ? v : v === undefined || v === null ? null : Number(v),
            formattedValue: g.formattedValue?.[idx] ?? null,
            hasData,
            ...(g.coordinates ? { lat: g.coordinates.lat ?? null, lng: g.coordinates.lng ?? null } : {}),
        });
    }
    rows.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || String(a.geoName).localeCompare(String(b.geoName)));
    return rows;
}

const PUBLIC = 'https://trends.google.com';

/** relatedsearches → { top, rising }. rankedList[0] = TOP, [1] = RISING. Values may be numbers or 'Breakout'. */
export function parseRelated(json, { topics = false } = {}) {
    const d = json?.default;
    if (!d || !Array.isArray(d.rankedList)) throw new DecodeError('relatedsearches response has no rankedList');
    const conv = (list, rising) => (list?.rankedKeyword ?? []).map((k, i) => {
        const breakout = k.formattedValue === 'Breakout' || k.value === 'Breakout';
        const value = typeof k.value === 'number' ? k.value : Number.isFinite(Number(k.value)) ? Number(k.value) : null;
        const base = topics
            ? { topicId: k.topic?.mid ?? null, title: k.topic?.title ?? null, topicType: k.topic?.type ?? null }
            : { query: k.query ?? null };
        return {
            rank: i + 1,
            ...base,
            value,
            formattedValue: k.formattedValue ?? (value !== null ? String(value) : null),
            ...(rising ? { isBreakout: breakout } : {}),
            link: k.link ? `${PUBLIC}${k.link}` : null,
        };
    });
    return { top: conv(d.rankedList[0], false), rising: conv(d.rankedList[1], true) };
}

// ── Trending now ───────────────────────────────────────────────────────────────────────────

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => String(s ?? '')
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        const t = e.toLowerCase();
        if (t[0] === '#') {
            const cp = t[1] === 'x' ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return XML_ENTITIES[t] ?? m;
    })
    .trim();
const tag = (block, name) => {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    const v = m ? decodeXml(m[1]) : '';
    return v || null;
};
const blocks = (xml, name) => [...String(xml).matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => m[1]);

/** "20,000+" / "10K+" / "2M+" → 20000 / 10000 / 2000000. */
export function parseTraffic(label) {
    if (!label) return null;
    const m = String(label).replace(/,/g, '').trim().match(/^([\d.]+)\s*([KkMmBb]?)\+?$/);
    if (!m) return null;
    const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
    return Math.round(Number(m[1]) * mult);
}

/** Trending Now RSS (trends.google.com/trending/rss?geo=XX): tags from trendspy/trendsearch parsers. */
export function parseTrendingRss(xml) {
    const s = String(xml ?? '');
    if (!/<rss[\s>]/i.test(s) || !/<channel[\s>]/i.test(s)) throw new DecodeError('not an RSS feed');
    return blocks(s, 'item').map((b, i) => {
        const pub = tag(b, 'pubDate');
        const t = pub ? Date.parse(pub) : NaN;
        const approx = tag(b, 'ht:approx_traffic');
        return {
            rank: i + 1,
            title: tag(b, 'title'),
            approxTraffic: approx,
            approxTrafficMin: parseTraffic(approx),
            startedAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
            picture: tag(b, 'ht:picture'),
            pictureSource: tag(b, 'ht:picture_source'),
            news: blocks(b, 'ht:news_item').map((n) => ({
                title: tag(n, 'ht:news_item_title'),
                url: tag(n, 'ht:news_item_url'),
                source: tag(n, 'ht:news_item_source'),
                picture: tag(n, 'ht:news_item_picture'),
                snippet: tag(n, 'ht:news_item_snippet'),
            })),
        };
    });
}

/** Every top-level JSON array in a batchexecute body (tolerates ")]}'" and the length lines of rt=c). */
function jsonArrays(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '[') continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        const start = i;
        for (; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === '[') depth++;
            else if (c === ']' && --depth === 0) {
                out.push(text.slice(start, i + 1));
                break;
            }
        }
    }
    return out;
}

/** batchexecute → the decoded inner payload of `rpcId` ("wrb.fr" frame). */
export function parseBatchExecute(text, rpcId) {
    const body = String(text ?? '').trim().replace(/^\)\]\}'/, '');
    let sawFrame = false;
    for (const chunk of jsonArrays(body)) {
        let arr;
        try {
            arr = JSON.parse(chunk);
        } catch {
            continue;
        }
        const frame = Array.isArray(arr) ? arr.find((f) => Array.isArray(f) && f[0] === 'wrb.fr' && f[1] === rpcId) : null;
        if (!frame) continue;
        sawFrame = true;
        if (typeof frame[2] !== 'string') continue;
        try {
            return JSON.parse(frame[2]);
        } catch {
            throw new DecodeError(`${rpcId} payload is not valid JSON`);
        }
    }
    throw new DecodeError(sawFrame ? `${rpcId} answered with an empty payload` : `no ${rpcId} frame in the batchexecute response`);
}

const tsOf = (v) => (Array.isArray(v) && Number.isFinite(Number(v[0])) ? Number(v[0]) : Number.isFinite(v) ? v : null);
const isoOf = (s) => (s ? new Date(s * 1000).toISOString() : null);
const volumeLabel = (n) => {
    if (!Number.isFinite(n)) return null;
    if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M+`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K+`;
    return `${n}+`;
};

/**
 * Trending Now rows (i0OFE payload[1]). Row layout (trendspy TrendKeyword / google-trends-now normalize.js):
 * [title, news, geo, [startTs], [endTs]|null, ?, volume, ?, growthPct, [breakdownQueries], [categoryIds], [[articleId,lang,geo]], normalizedTitle]
 */
export function parseTrendingRows(payload, categoryNames = {}) {
    const rows = Array.isArray(payload?.[1]) ? payload[1] : [];
    return rows.filter((r) => Array.isArray(r) && typeof r[0] === 'string').map((r, i) => {
        const start = tsOf(r[3]);
        const end = tsOf(r[4]);
        const volume = Number.isFinite(Number(r[6])) && r[6] !== null ? Number(r[6]) : null;
        const cats = Array.isArray(r[10]) ? r[10].filter((c) => Number.isFinite(Number(c))).map(Number) : [];
        return {
            rank: i + 1,
            title: r[0],
            approxTraffic: volumeLabel(volume),
            approxTrafficMin: volume,
            increasePercent: Number.isFinite(Number(r[8])) && r[8] !== null ? Number(r[8]) : null,
            startedAt: isoOf(start),
            endedAt: isoOf(end),
            isActive: end === null,
            relatedQueries: Array.isArray(r[9]) ? r[9].filter((q) => typeof q === 'string') : [],
            categories: cats.map((c) => categoryNames[c] ?? `Category ${c}`),
            geo: typeof r[2] === 'string' ? r[2] : null,
        };
    });
}
