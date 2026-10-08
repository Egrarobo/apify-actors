import { TOPICS, edition, dayWindows } from './feeds.js';

export class InputError extends Error {}

export const BLOCKED_PROXY_GROUPS = ['RESIDENTIAL', 'GOOGLE_SERP'];
export const TIME_RANGES = ['any', '1h', '1d', '7d', '30d', '1y', 'custom'];
const PERIOD_MS = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '1y': 365 * 86400e3 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;
export const FEED_LIMIT = 100; // Google News returns at most ~100 items per feed

const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split('\n');
    return arr.map((x) => (typeof x === 'object' && x !== null ? String(x.url ?? x.value ?? '') : String(x)).trim()).filter(Boolean)
        .filter((x, i, a) => a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i)
        .map((x) => {
            if (x.length > 300) throw new InputError(`A value in "${name}" is too long (max 300 characters): "${x.slice(0, 40)}…"`);
            return x;
        });
};
const toBool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'true');
const toInt = (v, d, min, max, name) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`"${name}" must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)}).`);
    return n;
};

/** Removes the Apify RESIDENTIAL and GOOGLE_SERP groups (billed per GB / per request, and not needed for public RSS). */
export function limitProxy(proxy) {
    const groups = Array.isArray(proxy?.apifyProxyGroups) ? proxy.apifyProxyGroups : [];
    const isBlocked = (g) => BLOCKED_PROXY_GROUPS.includes(String(g).toUpperCase());
    const removedGroups = groups.filter(isBlocked).map((g) => String(g).toUpperCase());
    if (!removedGroups.length) return { proxy, removedGroups };
    const kept = groups.filter((g) => !isBlocked(g));
    const out = { ...proxy, apifyProxyGroups: kept };
    if (!kept.length) delete out.apifyProxyGroups;
    return { proxy: out, removedGroups };
}

/**
 * Validates the input and returns the run plan: one entry per feed with the RSS windows to read.
 * now: injectable for tests.
 */
export function parseInput(input, { now = Date.now() } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('The input must be a JSON object.');

    const queries = toList(input.queries ?? input.keywords, 'queries');
    const topicsRaw = toList(input.topics, 'topics').map((t) => t.toUpperCase().replace(/\s+/g, '_'));
    const locations = toList(input.locations, 'locations');
    const topStories = topicsRaw.includes('TOP_STORIES') || toBool(input.topStories, false);
    const topics = topicsRaw.filter((t) => t !== 'TOP_STORIES');
    const badTopic = topics.find((t) => !TOPICS.includes(t));
    if (badTopic) throw new InputError(`Unknown topic "${badTopic}". Use one of: TOP_STORIES, ${TOPICS.join(', ')}.`);
    if (!queries.length && !topics.length && !locations.length && !topStories) {
        throw new InputError('Add at least one search query to "queries" (e.g. "OpenAI"), a topic (e.g. "BUSINESS") or a location (e.g. "Chicago").');
    }
    if (queries.length + topics.length + locations.length > 500) throw new InputError('Too many feeds: at most 500 queries, topics and locations together per run.');

    const language = String(input.language ?? 'en-US').trim() || 'en-US';
    if (!LANG_RE.test(language)) throw new InputError(`"language" must be a language code such as "en-US", "en", "de", "ro" or "pt-BR" (got "${input.language}").`);
    const country = String(input.country ?? 'US').trim().toUpperCase() || 'US';
    if (!COUNTRY_RE.test(country)) throw new InputError(`"country" must be a two-letter country code such as "US", "GB", "DE" or "RO" (got "${input.country}").`);
    const ed = edition(language, country);

    const timeRange = String(input.timeRange ?? 'any').trim() || 'any';
    if (!TIME_RANGES.includes(timeRange)) throw new InputError(`"timeRange" must be one of: ${TIME_RANGES.join(', ')} (got "${input.timeRange}").`);
    let dateFrom = null;
    let dateTo = null;
    if (timeRange === 'custom') {
        dateFrom = String(input.dateFrom ?? '').trim();
        dateTo = String(input.dateTo ?? '').trim() || new Date(now).toISOString().slice(0, 10);
        if (!DATE_RE.test(dateFrom) || Number.isNaN(Date.parse(dateFrom))) throw new InputError('With "timeRange": "custom", set "dateFrom" as YYYY-MM-DD (e.g. "2026-09-01").');
        if (!DATE_RE.test(dateTo) || Number.isNaN(Date.parse(dateTo))) throw new InputError('"dateTo" must be a date as YYYY-MM-DD.');
        if (dateFrom > dateTo) throw new InputError(`"dateFrom" (${dateFrom}) is after "dateTo" (${dateTo}).`);
    }
    // Time window used to filter every feed (topic and location feeds have no period operator).
    const sinceMs = timeRange === 'custom' ? Date.parse(`${dateFrom}T00:00:00Z`) : PERIOD_MS[timeRange] ? now - PERIOD_MS[timeRange] : null;
    const untilMs = timeRange === 'custom' ? Date.parse(`${dateTo}T00:00:00Z`) + 86400e3 : null;

    const maxArticlesPerFeed = toInt(input.maxArticlesPerFeed ?? input.maxArticles, 100, 1, 5000, 'maxArticlesPerFeed');

    // Search windows: one feed for <= 100 articles; above that, one search per day of the period.
    let searchWindows;
    let splitNote = null;
    if (maxArticlesPerFeed <= FEED_LIMIT || timeRange === '1h' || timeRange === '1d') {
        searchWindows = [timeRange === 'custom' ? { after: dateFrom, before: nextDay(dateTo) } : { when: PERIOD_MS[timeRange] ? timeRange : null }];
    } else {
        const to = timeRange === 'custom' ? dateTo : new Date(now).toISOString().slice(0, 10);
        const days = { '7d': 7, '30d': 30, '1y': 365, any: 30 }[timeRange];
        const from = timeRange === 'custom' ? dateFrom : new Date(now - (days - 1) * 86400e3).toISOString().slice(0, 10);
        searchWindows = dayWindows(from, to);
        splitNote = `More than ${FEED_LIMIT} articles per query: each query is read day by day (${searchWindows.length} day(s), ${from} → ${to})`
            + (timeRange === 'any' ? '; with "any time" the last 30 days are used.' : '.');
    }

    const { proxy, removedGroups } = limitProxy(input.proxyConfiguration ?? { useApifyProxy: true });

    return {
        queries, topics, locations, topStories,
        language, country, edition: ed,
        timeRange, dateFrom, dateTo, sinceMs, untilMs,
        maxArticlesPerFeed, searchWindows, splitNote,
        decodeUrls: toBool(input.decodeUrls, true),
        fetchPublisherDetails: toBool(input.fetchPublisherDetails, false),
        includeRelatedCoverage: toBool(input.includeRelatedCoverage, false),
        deduplicate: toBool(input.deduplicate, true),
        maxConcurrency: toInt(input.maxConcurrency, 3, 1, 10, 'maxConcurrency'),
        requestDelayMs: toInt(input.requestDelayMs, 500, 0, 60000, 'requestDelayMs'),
        maxRetries: toInt(input.maxRetries, 4, 0, 10, 'maxRetries'),
        proxy, removedGroups,
    };
}

function nextDay(d) {
    return new Date(Date.parse(`${d}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
}
