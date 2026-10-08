// Google News public RSS feeds: URL building and parsing. No JavaScript pages, no Google Search.
//   search:    https://news.google.com/rss/search?q=<query>&hl=en-US&gl=US&ceid=US:en
//   top:       https://news.google.com/rss?hl=...
//   topic:     https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=...   (302 → /rss/topics/<id>)
//   location:  https://news.google.com/rss/headlines/section/geo/Chicago?hl=...      (302 → /rss/topics/<id>)
// A feed returns at most ~100 items, so long periods are split into one search per day (after:/before:).

export const DEFAULT_BASE_URL = 'https://news.google.com';

export const TOPICS = ['WORLD', 'NATION', 'BUSINESS', 'TECHNOLOGY', 'ENTERTAINMENT', 'SPORTS', 'SCIENCE', 'HEALTH'];

// Editions whose ceid language differs from the plain language code (Google News edition list).
const CEID_LANGUAGE = {
    BR: 'pt-419', MX: 'es-419', AR: 'es-419', CO: 'es-419', CL: 'es-419', PE: 'es-419', VE: 'es-419', CU: 'es-419',
    CN: 'zh-Hans', TW: 'zh-Hant', HK: 'zh-Hant',
};

/** hl / gl / ceid for a language ("en-US", "ro", "de") and a country ("US", "RO"). */
export function edition(language, country) {
    const gl = country.toUpperCase();
    const base = language.split('-')[0].toLowerCase();
    let hl = language;
    if (base === 'en' && !language.includes('-')) hl = `en-${gl}`;
    const ceidLang = CEID_LANGUAGE[gl] && ['pt', 'es', 'zh'].includes(base) ? CEID_LANGUAGE[gl] : base;
    return { hl, gl, ceid: `${gl}:${ceidLang}` };
}

const qs = (ed) => `hl=${encodeURIComponent(ed.hl)}&gl=${encodeURIComponent(ed.gl)}&ceid=${encodeURIComponent(ed.ceid)}`;

/** Search query text sent to Google: the user's query plus the period operators. */
export function searchQueryText(query, { when, after, before } = {}) {
    const parts = [query.trim()];
    if (after) parts.push(`after:${after}`);
    if (before) parts.push(`before:${before}`);
    if (!after && !before && when) parts.push(`when:${when}`);
    return parts.join(' ');
}

export function searchFeedUrl(baseUrl, ed, text) {
    return `${baseUrl}/rss/search?q=${encodeURIComponent(text).replace(/%20/g, '+')}&${qs(ed)}`;
}

export function topStoriesFeedUrl(baseUrl, ed) {
    return `${baseUrl}/rss?${qs(ed)}`;
}

export function topicFeedUrl(baseUrl, ed, topic) {
    return `${baseUrl}/rss/headlines/section/topic/${encodeURIComponent(topic.toUpperCase())}?${qs(ed)}`;
}

export function locationFeedUrl(baseUrl, ed, location) {
    return `${baseUrl}/rss/headlines/section/geo/${encodeURIComponent(location.trim())}?${qs(ed)}`;
}

/** Days (YYYY-MM-DD, newest first) from `from` to `to` inclusive, for one search per day. */
export function dayWindows(from, to) {
    const out = [];
    const start = Date.parse(`${from}T00:00:00Z`);
    for (let t = Date.parse(`${to}T00:00:00Z`); t >= start; t -= 86400000) {
        const day = new Date(t).toISOString().slice(0, 10);
        const next = new Date(t + 86400000).toISOString().slice(0, 10);
        out.push({ after: day, before: next, day });
    }
    return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
    return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const unCdata = (s) => String(s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
const tag = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
    return m ? { attrs: m[1] ?? '', text: decodeEntities(unCdata(m[2])) } : null;
};
const attr = (attrs, name) => {
    const m = String(attrs).match(new RegExp(`\\s${name}="([^"]*)"`));
    return m ? decodeEntities(m[1]) : null;
};
export const stripHtml = (html) => decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** "Headline - Publisher" → "Headline" when the suffix is the source name. */
export function cleanTitle(title, source) {
    const t = String(title ?? '').trim();
    if (source) {
        for (const sep of [' - ', ' | ', ' – ', ' — ']) {
            const suffix = `${sep}${source}`;
            if (t.endsWith(suffix)) return t.slice(0, -suffix.length).trim();
        }
    }
    return t;
}

/** Related coverage from a clustered item's description: <ol><li><a href>title</a> <font>source</font></li>... */
export function parseRelated(descriptionHtml) {
    const out = [];
    const re = /<li>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:[\s\S]*?<font[^>]*>([\s\S]*?)<\/font>)?/g;
    let m;
    while ((m = re.exec(descriptionHtml))) {
        out.push({ title: stripHtml(m[2]), source: m[3] ? stripHtml(m[3]) : null, googleNewsUrl: decodeEntities(m[1]) });
    }
    return out;
}

/**
 * Parses a Google News RSS document.
 * Returns { ok, title, items: [{ title, source, sourceUrl, publishedAt, googleNewsUrl, articleId, snippet, related }] }.
 * ok=false when the body is not an RSS feed (consent page, captcha, HTML error).
 */
export function parseFeed(xml) {
    const text = String(xml ?? '');
    if (!/<rss[\s>]/.test(text) || !/<channel>/.test(text)) return { ok: false, title: null, items: [] };
    const channelTitle = tag(text.slice(0, Math.max(0, text.indexOf('<item>')) || text.length), 'title')?.text ?? null;
    const items = [];
    for (const m of text.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const x = m[1];
        const src = tag(x, 'source');
        const source = src ? src.text.trim() : null;
        const rawTitle = tag(x, 'title')?.text ?? '';
        const link = (tag(x, 'link')?.text ?? '').trim();
        const guid = (tag(x, 'guid')?.text ?? '').trim();
        const pub = tag(x, 'pubDate')?.text;
        const ts = pub ? Date.parse(pub) : NaN;
        const descHtml = tag(x, 'description')?.text ?? '';
        const related = parseRelated(descHtml);
        const title = cleanTitle(rawTitle, source);
        // The feed has no real summary: the description repeats the headline (+ source), or lists the cluster.
        let snippet = null;
        if (!related.length) {
            let d = stripHtml(descHtml);
            if (source && d.endsWith(source)) d = d.slice(0, -source.length).trim();
            if (d && d !== title && d !== rawTitle) snippet = d;
        }
        items.push({
            title,
            source,
            sourceUrl: src ? attr(src.attrs, 'url') : null,
            publishedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
            googleNewsUrl: link,
            articleId: guid || articleIdFromUrl(link),
            snippet,
            related: related.slice(1), // the first entry is the item itself
        });
    }
    return { ok: true, title: channelTitle, items };
}

export function articleIdFromUrl(url) {
    const m = String(url ?? '').match(/\/(?:rss\/)?articles\/([^?/#]+)/);
    return m ? m[1] : null;
}
