// Google Trends request builders.
//
// Endpoint shapes are taken from the source code of open-source clients (Sept 2026 review):
//  - GeneralMills/pytrends (request.py; archived 2025, recorded VCR cassettes in tests/)
//  - sdil87/trendspy (client.py: embed widgets, Trending Now RSS + batchexecute i0OFE)
//  - DobroslavRadosavljevic/trendsearch (TypeScript, June 2026: GET /trends/api/explore, prefix stripping, RSS)
//  - RuochenLyu/google-trends-now (JS, July 2026: i0OFE payload [null,null,geo,cat,hl,hours,sort])

export const DEFAULT_BASE_URL = 'https://trends.google.com';
export const PUBLIC_BASE_URL = 'https://trends.google.com';

export const PATHS = {
    warmup: '/trends/explore',
    explore: '/trends/api/explore',
    embed: '/trends/embed/explore', // + /TIMESERIES | /GEO_MAP | /RELATED_QUERIES | /RELATED_TOPICS
    multiline: '/trends/api/widgetdata/multiline',
    comparedgeo: '/trends/api/widgetdata/comparedgeo',
    relatedsearches: '/trends/api/widgetdata/relatedsearches',
    rss: '/trending/rss',
    batchexecute: '/_/TrendsUi/data/batchexecute',
};

export const TRENDING_RPC_ID = 'i0OFE';

// Consent cookies that skip the EU "Before you continue" page (same values as used by google-hotels-prices).
export const CONSENT_COOKIES = { CONSENT: 'YES+cb', SOCS: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg' };

/** Top-level Google Trends categories (id → name), from pytrends / google-trends-api allCategories.txt. */
export const CATEGORIES = {
    0: 'All categories', 3: 'Arts & Entertainment', 47: 'Autos & Vehicles', 44: 'Beauty & Fitness', 22: 'Books & Literature',
    12: 'Business & Industrial', 5: 'Computers & Electronics', 7: 'Finance', 71: 'Food & Drink', 8: 'Games', 45: 'Health',
    65: 'Hobbies & Leisure', 11: 'Home & Garden', 13: 'Internet & Telecom', 958: 'Jobs & Education', 19: 'Law & Government',
    16: 'News', 299: 'Online Communities', 14: 'People & Society', 66: 'Pets & Animals', 29: 'Real Estate', 533: 'Reference',
    174: 'Science', 18: 'Shopping', 20: 'Sports', 67: 'Travel',
};

/** Trending Now category ids (row[10] of the i0OFE payload), from trendspy constants.py / google-trends-now. */
export const TRENDING_CATEGORIES = {
    1: 'Autos and Vehicles', 2: 'Beauty and Fashion', 3: 'Business and Finance', 4: 'Entertainment', 5: 'Food and Drink',
    6: 'Games', 7: 'Health', 8: 'Hobbies and Leisure', 9: 'Jobs and Education', 10: 'Law and Government', 11: 'Other',
    13: 'Pets and Animals', 14: 'Politics', 15: 'Science', 16: 'Shopping', 17: 'Sports', 18: 'Technology',
    19: 'Travel and Transportation', 20: 'Climate',
};

export const GPROP_NAMES = { '': 'Web Search', images: 'Image Search', news: 'News Search', froogle: 'Google Shopping', youtube: 'YouTube Search' };

const withQuery = (baseUrl, path, params) => {
    const u = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
};

/** The `req` object of /api/explore: one comparison item per term, all with the same geo and time. */
export function buildExploreReq({ terms, geo, time, category, gprop }) {
    return {
        comparisonItem: terms.map((keyword) => ({ keyword, geo, time })),
        category,
        property: gprop,
    };
}

/** GET /trends/api/explore?hl=&tz=&req= (trendsearch uses GET; pytrends sends the same query string with POST). */
export const buildExploreUrl = (baseUrl, { hl, tz, req }) => withQuery(baseUrl, PATHS.explore, { hl, tz, req: JSON.stringify(req) });

/** Embeddable widget page (trendspy): same `req`, answers with an HTML page holding one widget (token + request). */
export const buildEmbedUrl = (baseUrl, widgetId, { hl, tz, req }) => withQuery(baseUrl, `${PATHS.embed}/${widgetId}`, { req: JSON.stringify(req), hl, tz });

/** Widget data URL for a widget returned by explore/embed (token is bound to the exact `request` JSON). */
export function buildWidgetDataUrl(baseUrl, widget, { hl, tz, request = widget.request }) {
    const path = widgetDataPath(widget);
    return withQuery(baseUrl, path, { hl, tz, req: JSON.stringify(request), token: widget.token });
}

export function widgetDataPath(widget) {
    const id = String(widget.id ?? '');
    const type = String(widget.type ?? '');
    if (id.startsWith('TIMESERIES') || type === 'fe_line_chart') return PATHS.multiline;
    if (id.startsWith('GEO_MAP') || type === 'fe_geo_chart_explore' || type === 'fe_multi_heat_map') return PATHS.comparedgeo;
    if (id.startsWith('RELATED_') || type === 'fe_related_searches') return PATHS.relatedsearches;
    throw new Error(`Unknown widget ${id} (${type})`);
}

/** First request of a session: a Trends page that sets the NID cookie (pytrends GetGoogleCookie). */
export const buildWarmupUrl = (baseUrl, { geo, hl }) => withQuery(baseUrl, PATHS.warmup, { geo: (geo || 'US').split('-')[0], hl });

export const buildRssUrl = (baseUrl, { geo }) => withQuery(baseUrl, PATHS.rss, { geo });

/** Trending Now page data: POST batchexecute with rpc i0OFE and inner payload [null, null, geo, category, hl, hours, sort]. */
export function buildTrendingRequest(baseUrl, { geo, hl, hours, category = 0, sort = 1 }) {
    const inner = [null, null, geo, category, hl, hours, sort];
    const outer = [[[TRENDING_RPC_ID, JSON.stringify(inner), null, 'generic']]];
    return {
        url: withQuery(baseUrl, PATHS.batchexecute, { rpcids: TRENDING_RPC_ID, 'source-path': '/trending', hl }),
        body: `f.req=${encodeURIComponent(JSON.stringify(outer))}`,
        inner,
    };
}

/** Public link that opens the same comparison on trends.google.com. */
export function buildPublicExploreUrl({ terms, geo, time, category, gprop, hl }) {
    const u = new URL('/trends/explore', PUBLIC_BASE_URL);
    u.searchParams.set('date', time);
    if (geo) u.searchParams.set('geo', geo);
    u.searchParams.set('q', terms.join(','));
    if (category) u.searchParams.set('cat', String(category));
    if (gprop) u.searchParams.set('gprop', gprop);
    if (hl) u.searchParams.set('hl', hl);
    return u.toString();
}
