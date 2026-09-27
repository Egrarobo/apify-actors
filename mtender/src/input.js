import { parseOcid, DEFAULT_API_BASE_URL } from './api.js';

const UNITS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };
const STATUSES = ['planning', 'planned', 'active', 'complete', 'cancelled', 'unsuccessful', 'withdrawn'];
const CATEGORIES = ['goods', 'works', 'services'];
const FEEDS = ['all', 'contractNotices', 'plans'];
export const DEFAULT_LOOKBACK_DAYS = 3;

export class InputError extends Error {}

const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new InputError(`"${name}" must be a list of strings, e.g. ["medicamente"].`);
    return v.map((s) => String(s ?? '').trim()).filter(Boolean);
};

const toNum = (v, name, { min = -Infinity, max = Infinity, def = null, int = false } = {}) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isFinite(x) || x < min) throw new InputError(`"${name}" must be a number${min > -Infinity ? ` of at least ${min}` : ''}.`);
    return Math.min(int ? Math.floor(x) : x, max);
};

/**
 * Accepts "2026-09-01", "2026-09-01T08:00:00Z", or relative values like "7 days", "12 hours", "2 weeks"
 * (always meaning "ago"; "+1 day" means in the future). A date without time is the start of that day (UTC),
 * or the end of that day for `endOfDay`.
 */
export function parseDate(v, name, { endOfDay = false, now = Date.now() } = {}) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (s === 'now') return new Date(now).toISOString();
    if (s === 'today') return new Date(Math.floor(now / UNITS.day) * UNITS.day + (endOfDay ? UNITS.day - 1 : 0)).toISOString();
    const rel = s.match(/^([+-])?\s*(\d+(?:\.\d+)?)\s*(minute|min|hour|h|day|d|week|w|month|year|y)s?(?:\s+ago)?$/);
    if (rel) {
        const unit = { min: 'minute', h: 'hour', d: 'day', w: 'week', y: 'year' }[rel[3]] ?? rel[3];
        const ms = Number(rel[2]) * UNITS[unit];
        return new Date(rel[1] === '+' ? now + ms : now - ms).toISOString();
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const t = Date.parse(`${s}T00:00:00Z`);
        if (Number.isFinite(t)) return new Date(t + (endOfDay ? UNITS.day - 1 : 0)).toISOString();
    }
    const t = Date.parse(String(v).trim());
    if (!Number.isFinite(t)) throw new InputError(`"${name}" is not a valid date: "${v}". Use e.g. "2026-09-01", "2026-09-01T08:00:00Z" or "7 days".`);
    return new Date(t).toISOString();
}

export function parseInput(input, { now = Date.now() } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('The input must be a JSON object.');

    const rawIds = toList(input.tenderIds, 'tenderIds');
    const tenderIds = [];
    const badIds = [];
    for (const raw of rawIds) {
        const ocid = parseOcid(raw);
        if (ocid) {
            if (!tenderIds.includes(ocid)) tenderIds.push(ocid);
        } else badIds.push(raw);
    }
    if (badIds.length) {
        throw new InputError(`These tender IDs are not valid MTender OCIDs: ${badIds.slice(0, 5).map((b) => `"${b}"`).join(', ')}. `
            + 'Use IDs like "ocds-b3wdp1-MD-1612345678901" or links like https://mtender.gov.md/tenders/ocds-b3wdp1-MD-1612345678901.');
    }

    const monitorName = String(input.monitorName ?? '').trim();
    const mode = tenderIds.length ? 'details' : monitorName ? 'monitor' : 'search';

    const statuses = toList(input.statuses, 'statuses').map((s) => s.toLowerCase());
    const badStatus = statuses.filter((s) => !STATUSES.includes(s));
    if (badStatus.length) throw new InputError(`Unknown status "${badStatus[0]}". Allowed: ${STATUSES.join(', ')}.`);
    const categories = toList(input.categories, 'categories').map((s) => s.toLowerCase());
    const badCat = categories.filter((s) => !CATEGORIES.includes(s));
    if (badCat.length) throw new InputError(`Unknown category "${badCat[0]}". Allowed: ${CATEGORIES.join(', ')}.`);
    const feed = input.feed || 'all';
    if (!FEEDS.includes(feed)) throw new InputError(`"feed" must be one of: ${FEEDS.join(', ')}.`);
    const keywordsMatch = input.keywordsMatch || 'any';
    if (!['any', 'all'].includes(keywordsMatch)) throw new InputError('"keywordsMatch" must be "any" or "all".');

    const cpvPrefixes = toList(input.cpvPrefixes, 'cpvPrefixes');
    const badCpv = cpvPrefixes.filter((c) => !/^\d{1,8}(-\d)?$/.test(c.replace(/\s/g, '')));
    if (badCpv.length) throw new InputError(`"${badCpv[0]}" is not a CPV code or prefix. Use digits, e.g. "33" (medical), "45233" (road works) or "30200000-1".`);

    const minValue = toNum(input.minValue, 'minValue', { min: 0 });
    const maxValue = toNum(input.maxValue, 'maxValue', { min: 0 });
    if (minValue !== null && maxValue !== null && minValue > maxValue) throw new InputError('"minValue" is larger than "maxValue".');
    const currency = String(input.currency ?? '').trim().toUpperCase() || null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new InputError('"currency" must be a 3-letter code such as MDL, EUR or USD.');

    const dateFrom = parseDate(input.dateFrom, 'dateFrom', { now }) ?? new Date(now - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
    const dateTo = parseDate(input.dateTo, 'dateTo', { endOfDay: true, now });
    if (dateTo && Date.parse(dateTo) < Date.parse(dateFrom)) throw new InputError('"dateTo" is before "dateFrom".');
    if (Date.parse(dateFrom) > now + 60_000) throw new InputError('"dateFrom" is in the future.');

    let apiBaseUrl = String(input.apiBaseUrl ?? '').trim() || DEFAULT_API_BASE_URL;
    try {
        const u = new URL(apiBaseUrl);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        apiBaseUrl = u.href.replace(/\/+$/, '');
    } catch {
        throw new InputError('"apiBaseUrl" must be an http(s) URL. Leave it empty to use the official MTender API.');
    }

    const stateStoreName = String(input.stateStoreName || 'mtender-monitor-state').trim();
    if (!/^[a-zA-Z0-9-]{1,63}$/.test(stateStoreName)) throw new InputError('"stateStoreName" may only contain letters, digits and "-" (max 63 characters).');

    return {
        mode,
        tenderIds,
        monitorName,
        feed,
        dateFrom,
        dateFromGiven: !!input.dateFrom,
        dateTo,
        onlyNewlyPublished: input.onlyNewlyPublished !== false,
        filters: {
            keywords: toList(input.keywords, 'keywords'),
            excludeKeywords: toList(input.excludeKeywords, 'excludeKeywords'),
            keywordsMatch,
            statuses,
            methods: toList(input.methods, 'methods'),
            categories,
            cpvPrefixes,
            buyerNames: toList(input.buyerNames, 'buyerNames'),
            buyerIdnos: toList(input.buyerIdnos, 'buyerIdnos'),
            minValue,
            maxValue,
            currency,
            includeWithoutValue: input.includeWithoutValue === true,
        },
        maxResults: toNum(input.maxResults, 'maxResults', { min: 0, def: 100, int: true }),
        maxScan: toNum(input.maxScan, 'maxScan', { min: 1, def: 3000, max: 100_000, int: true }),
        includeRaw: input.includeRaw === true,
        reportAllOnFirstRun: input.reportAllOnFirstRun === true,
        resetState: input.resetState === true,
        stateStoreName,
        notifyMaxItems: toNum(input.notifyMaxItems, 'notifyMaxItems', { min: 0, max: 100, def: 10, int: true }),
        webhookMaxItems: toNum(input.webhookMaxItems, 'webhookMaxItems', { min: 0, max: 1000, def: 100, int: true }),
        notifyOnNoChanges: input.notifyOnNoChanges === true,
        maxConcurrency: toNum(input.maxConcurrency, 'maxConcurrency', { min: 1, max: 8, def: 4, int: true }),
        requestDelayMs: toNum(input.requestDelayMs, 'requestDelayMs', { min: 0, max: 10_000, def: 150, int: true }),
        apiBaseUrl,
    };
}
