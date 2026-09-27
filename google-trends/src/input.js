import { DEFAULT_BASE_URL, CATEGORIES } from './request.js';

export class InputError extends Error {}

const MAX_GROUP = 5; // Google Trends compares at most 5 terms at once.

const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new InputError(`"${name}" must be a list of strings.`);
    return v.map((s) => String(s ?? '').trim()).filter(Boolean);
};
const toInt = (v, name, { min, max, def }) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isInteger(x) || x < min || x > max) throw new InputError(`"${name}" must be a whole number between ${min} and ${max} (got ${JSON.stringify(v)}).`);
    return x;
};
const toBool = (v, def) => (v === undefined || v === null || v === '' ? def : v === true || v === 'true');

export const TIME_PRESETS = ['now 1-H', 'now 4-H', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y', 'all'];
const FIRST_DAY = '2004-01-01';

const validDay = (s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/**
 * Validates a Google Trends time string. Accepts the presets, "today N-m"/"today N-y", "now N-H"/"now N-d",
 * "YYYY-MM-DD YYYY-MM-DD" (from 2004) and hourly "YYYY-MM-DDTHH YYYY-MM-DDTHH" (at most 7 days).
 */
export function parseTimeRange(raw, { now = Date.now() } = {}) {
    const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!s) throw new InputError('"customTimeRange" is empty. Use e.g. "2025-01-01 2025-06-30".');
    if (TIME_PRESETS.includes(s)) return s;
    let m = s.match(/^now (\d+)-([Hd])$/);
    if (m) {
        const hours = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
        if (hours < 1 || hours > 7 * 24) throw new InputError(`Time range "${s}": "now" ranges can cover at most 7 days.`);
        return s;
    }
    m = s.match(/^today (\d+)-([my])$/);
    if (m) {
        if (Number(m[1]) < 1) throw new InputError(`Time range "${s}" is not valid.`);
        return s;
    }
    const today = new Date(now).toISOString().slice(0, 10);
    m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{4}-\d{2}-\d{2})$/);
    if (m) {
        const [, a, b] = m;
        if (!validDay(a) || !validDay(b)) throw new InputError(`Time range "${s}" contains an invalid date.`);
        if (a >= b) throw new InputError(`Time range "${s}": the start date must be before the end date.`);
        if (a < FIRST_DAY) throw new InputError(`Time range "${s}": Google Trends data starts on ${FIRST_DAY}.`);
        if (a > today) throw new InputError(`Time range "${s}" starts in the future.`);
        return s;
    }
    m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}) (\d{4}-\d{2}-\d{2})T(\d{2})$/);
    if (m) {
        const [, a, ha, b, hb] = m;
        const ta = Date.parse(`${a}T${ha}:00:00Z`);
        const tb = Date.parse(`${b}T${hb}:00:00Z`);
        if (!validDay(a) || !validDay(b) || !Number.isFinite(ta) || !Number.isFinite(tb) || Number(ha) > 23 || Number(hb) > 23) throw new InputError(`Time range "${s}" contains an invalid date or hour.`);
        if (ta >= tb) throw new InputError(`Time range "${s}": the start must be before the end.`);
        if (tb - ta > 7 * 86_400_000) throw new InputError(`Time range "${s}": hourly ranges can cover at most 7 days.`);
        return s;
    }
    throw new InputError(`Time range "${s}" is not valid. Use "2025-01-01 2025-06-30", "2026-09-20T00 2026-09-26T23", "today 2-y", "now 3-d" or a preset such as "today 12-m".`);
}

const GEO_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3}(-\d{3})?)?$/;

/** Splits terms into comparison groups of at most 5; with an anchor, each group is anchor + 4 other terms. */
export function buildGroups(terms, { anchor = null, mode = 'groups' } = {}) {
    if (mode === 'separate') return terms.map((t) => [t]);
    const others = anchor ? terms.filter((t) => t.toLowerCase() !== anchor.toLowerCase()) : terms;
    const size = anchor ? MAX_GROUP - 1 : MAX_GROUP;
    const groups = [];
    for (let i = 0; i < others.length; i += size) groups.push(anchor ? [anchor, ...others.slice(i, i + size)] : others.slice(i, i + size));
    if (anchor && !groups.length) groups.push([anchor]);
    return groups;
}

export function parseInput(input, { now = Date.now() } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('The input must be a JSON object.');

    const seen = new Set();
    const searchTerms = [];
    for (const t of toList(input.searchTerms, 'searchTerms')) {
        if (t.length > 100) throw new InputError(`Search term "${t.slice(0, 40)}…" is too long (max 100 characters).`);
        if (seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        searchTerms.push(t);
    }
    const trendingNow = toBool(input.trendingNow, false);
    if (!searchTerms.length && !trendingNow) throw new InputError('Add at least one term to "searchTerms" (e.g. "coffee"), or turn on "trendingNow".');
    if (searchTerms.length > 1000) throw new InputError(`Too many search terms (${searchTerms.length}); the maximum is 1000 per run.`);

    const comparisonMode = input.comparisonMode || 'groups';
    if (!['groups', 'separate'].includes(comparisonMode)) throw new InputError('"comparisonMode" must be "groups" or "separate".');
    let anchorTerm = String(input.anchorTerm ?? '').trim() || null;
    if (comparisonMode === 'separate') anchorTerm = null;
    if (anchorTerm) {
        const same = searchTerms.find((t) => t.toLowerCase() === anchorTerm.toLowerCase());
        if (same) anchorTerm = same;
    }

    const geo = String(input.geo ?? '').trim().toUpperCase();
    if (geo && !GEO_RE.test(geo)) throw new InputError(`"geo" must be a country or region code such as "US", "GB", "US-CA" or "" for worldwide (got "${input.geo}").`);

    const timeRange = String(input.timeRange || 'today 12-m').trim();
    let time;
    if (timeRange === 'custom') time = parseTimeRange(input.customTimeRange, { now });
    else if (TIME_PRESETS.includes(timeRange)) time = timeRange;
    else time = parseTimeRange(timeRange, { now }); // API users may pass any valid time string directly

    let category = 0;
    if (input.categoryId !== undefined && input.categoryId !== null && input.categoryId !== '') category = toInt(input.categoryId, 'categoryId', { min: 0, max: 100000, def: 0 });
    else if (input.category !== undefined && input.category !== null && input.category !== '') {
        category = Number(input.category);
        if (!Number.isInteger(category) || category < 0) throw new InputError(`"category" must be a Google Trends category id such as "0" (all) or "71" (Food & Drink) (got "${input.category}").`);
    }

    const gprop = String(input.gprop ?? '').trim().toLowerCase();
    const gpropAliases = { web: '', 'web search': '', shopping: 'froogle', 'google shopping': 'froogle' };
    const property = gprop in gpropAliases ? gpropAliases[gprop] : gprop;
    if (!['', 'images', 'news', 'froogle', 'youtube'].includes(property)) throw new InputError('"gprop" must be "" (web search), "images", "news", "froogle" (Google Shopping) or "youtube".');

    const language = String(input.language || 'en-US').trim();
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,4})?$/.test(language)) throw new InputError(`"language" must be a code such as "en-US", "de" or "pt-BR" (got "${input.language}").`);
    const tz = toInt(input.timezoneOffset, 'timezoneOffset', { min: -840, max: 720, def: 0 });

    const regionResolution = String(input.regionResolution ?? '').trim().toUpperCase();
    if (!['', 'COUNTRY', 'REGION', 'CITY', 'DMA'].includes(regionResolution)) throw new InputError('"regionResolution" must be "", "COUNTRY", "REGION", "CITY" or "DMA".');
    if (regionResolution === 'DMA' && geo && !geo.startsWith('US')) throw new InputError('"regionResolution" DMA (metro areas) exists only for the United States (geo "US").');
    if (regionResolution === 'COUNTRY' && geo) throw new InputError('"regionResolution" COUNTRY only works worldwide (empty "geo"); use REGION or CITY inside a country.');

    const interestOverTime = toBool(input.interestOverTime, true);
    const interestByRegion = toBool(input.interestByRegion, false);
    const relatedQueries = toBool(input.relatedQueries, false);
    const relatedTopics = toBool(input.relatedTopics, false);
    if (searchTerms.length && !interestOverTime && !interestByRegion && !relatedQueries && !relatedTopics) {
        throw new InputError('Nothing to collect for the search terms: turn on at least one of "interestOverTime", "interestByRegion", "relatedQueries" or "relatedTopics".');
    }

    const trendingGeo = String(input.trendingGeo ?? '').trim().toUpperCase() || (geo ? geo.split('-')[0] : 'US');
    if (trendingNow && !GEO_RE.test(trendingGeo)) throw new InputError(`"trendingGeo" must be a country code such as "US", "GB" or "IN" (got "${input.trendingGeo}").`);
    const trendingSource = input.trendingSource || 'rss';
    if (!['rss', 'trendingPage'].includes(trendingSource)) throw new InputError('"trendingSource" must be "rss" or "trendingPage".');
    const trendingHours = Number(input.trendingHours ?? 24);
    if (![4, 24, 48, 168].includes(trendingHours)) throw new InputError('"trendingHours" must be 4, 24, 48 or 168.');

    const useBrowser = input.useBrowser === true ? 'always' : input.useBrowser === false ? 'never' : (input.useBrowser || 'fallback');
    if (!['fallback', 'always', 'never'].includes(useBrowser)) throw new InputError('"useBrowser" must be "fallback", "always" or "never".');

    let baseUrl = DEFAULT_BASE_URL;
    if (input.baseUrl) {
        try {
            const u = new URL(String(input.baseUrl));
            if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
            baseUrl = u.origin;
        } catch {
            throw new InputError(`"baseUrl" is not a valid http(s) address: "${input.baseUrl}".`);
        }
    }

    const groups = buildGroups(searchTerms, { anchor: anchorTerm, mode: comparisonMode });
    const allTerms = anchorTerm && !searchTerms.some((t) => t === anchorTerm) ? [anchorTerm, ...searchTerms] : searchTerms;

    return {
        searchTerms: allTerms,
        groups,
        comparisonMode,
        anchorTerm,
        geo,
        time,
        timeRange,
        category,
        categoryName: CATEGORIES[category] ?? `Category ${category}`,
        gprop: property,
        language,
        tz,
        interestOverTime,
        interestByRegion,
        regionResolution,
        includeLowSearchVolumeRegions: toBool(input.includeLowSearchVolumeRegions, false),
        relatedQueries,
        relatedTopics,
        maxRelatedItems: toInt(input.maxRelatedItems, 'maxRelatedItems', { min: 0, max: 100, def: 25 }),
        flattenTimeline: toBool(input.flattenTimeline, false),
        trendingNow,
        trendingGeo,
        trendingSource,
        trendingHours,
        maxTrendingItems: toInt(input.maxTrendingItems, 'maxTrendingItems', { min: 1, max: 1000, def: 50 }),
        includeNews: toBool(input.includeNews, true),
        proxyConfiguration: input.proxyConfiguration ?? null,
        useBrowser,
        useEmbedFallback: toBool(input.useEmbedFallback, true),
        maxRetries: toInt(input.maxRetries, 'maxRetries', { min: 0, max: 10, def: 5 }),
        maxConcurrency: toInt(input.maxConcurrency, 'maxConcurrency', { min: 1, max: 5, def: 1 }),
        requestDelayMs: toInt(input.requestDelayMs, 'requestDelayMs', { min: 0, max: 60000, def: 1500 }),
        requestTimeoutSecs: toInt(input.requestTimeoutSecs, 'requestTimeoutSecs', { min: 5, max: 180, def: 30 }),
        saveDebugPages: toBool(input.saveDebugPages, true),
        baseUrl,
    };
}
