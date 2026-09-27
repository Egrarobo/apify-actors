import { INSTANCES, isAuctionId, isProcedureId } from './api.js';

export const STATUSES = [
    'active_rectification', 'active_tendering', 'active_auction', 'active_qualification', 'qualification',
    'active_awarded', 'pending_payment', 'pending_admission', 'complete', 'unsuccessful', 'cancelled',
];

const UNITS = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };

/**
 * Accepts "2026-09-01", "2026-09-01T10:00:00Z", "today", "now", "7 days" / "-7 days" (in the past) or "+14 days" (in the future).
 * `endOfDay` turns a plain date into 23:59:59.999 UTC (used for "to" bounds).
 */
export function parseDate(value, name, { endOfDay = false } = {}) {
    if (value === undefined || value === null || value === '') return null;
    const s = String(value).trim().toLowerCase();
    const now = Date.now();
    if (s === 'now') return new Date(now).toISOString();
    if (s === 'today') {
        const d = new Date(now);
        d.setUTCHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
        return d.toISOString();
    }
    const rel = /^([+-])?\s*(\d+(?:\.\d+)?)\s*(minute|hour|day|week|month|year)s?(\s+ago)?$/.exec(s);
    if (rel) {
        const sign = rel[1] === '+' && !rel[4] ? 1 : -1;
        return new Date(now + sign * Number(rel[2]) * UNITS[rel[3]]).toISOString();
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return `${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
    }
    const t = Date.parse(value);
    if (Number.isNaN(t)) {
        throw new Error(`"${name}" is not a valid date: "${value}". Use e.g. "2026-09-01", "2026-09-01T08:00:00Z", "7 days" (ago) or "+14 days" (from now).`);
    }
    return new Date(t).toISOString();
}

const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new Error(`"${name}" must be a list of text values.`);
    return v.map((s) => String(s).trim()).filter(Boolean);
};

const toNum = (v, name, { def = null, min = -Infinity, max = Infinity, int = false } = {}) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isFinite(x) || x < min) throw new Error(`"${name}" must be a number${min > -Infinity ? ` of at least ${min}` : ''}.`);
    return Math.min(int ? Math.floor(x) : x, max);
};

/** Validates and normalizes the raw input. Throws readable errors. */
export function parseInput(input) {
    const auctionIds = toList(input.auctionIds, 'auctionIds');
    let mode = String(input.mode ?? '').trim() || 'search';
    // The platform fills in the default "search"; auction IDs only make sense in details mode.
    if (mode === 'search' && auctionIds.length) mode = 'details';
    if (!['search', 'details', 'types'].includes(mode)) throw new Error(`"mode" must be "search", "details" or "types" (got "${mode}").`);
    if (mode === 'details' && !auctionIds.length) {
        throw new Error('Mode "details" needs at least one auction ID in "auctionIds", e.g. "LRE001-UA-20260916-77195" (as shown on prozorro.sale) or a 24-character procedure ID.');
    }
    const badIds = auctionIds.filter((id) => !isAuctionId(id) && !isProcedureId(id));
    if (mode === 'details' && badIds.length) {
        throw new Error(`These auction IDs do not look valid: ${badIds.slice(0, 5).join(', ')}. Expected e.g. "LRE001-UA-20260916-77195" or a 24-character procedure ID like "60655e344125bce9ef511a7b".`);
    }

    const statuses = toList(input.statuses, 'statuses').map((s) => s.toLowerCase());
    const unknownStatuses = statuses.filter((s) => !STATUSES.includes(s));

    const instance = String(input.instance ?? 'main').trim() || 'main';
    if (!INSTANCES[instance]) throw new Error(`"instance" must be one of: ${Object.keys(INSTANCES).join(', ')}.`);
    const apiBaseUrl = String(input.apiBaseUrl ?? '').trim() || INSTANCES[instance];
    if (!/^https?:\/\/[^\s/]+/i.test(apiBaseUrl)) throw new Error(`"apiBaseUrl" must be an http(s) URL, e.g. ${INSTANCES.main}`);

    const minPrice = toNum(input.minPrice, 'minPrice', { min: 0 });
    const maxPrice = toNum(input.maxPrice, 'maxPrice', { min: 0 });
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw new Error('"minPrice" is higher than "maxPrice".');

    const filters = {
        sellingMethods: toList(input.sellingMethods, 'sellingMethods'),
        statuses,
        openForBidsOnly: input.openForBidsOnly === true,
        keywords: String(input.keywords ?? '').trim() || null,
        regions: toList(input.regions, 'regions'),
        classificationCodes: toList(input.classificationCodes, 'classificationCodes'),
        organizerCodes: toList(input.organizerCodes, 'organizerCodes'),
        minPrice,
        maxPrice,
        publishedFrom: parseDate(input.publishedFrom, 'publishedFrom'),
        publishedTo: parseDate(input.publishedTo, 'publishedTo', { endOfDay: true }),
        auctionDateFrom: parseDate(input.auctionDateFrom, 'auctionDateFrom'),
        auctionDateTo: parseDate(input.auctionDateTo, 'auctionDateTo', { endOfDay: true }),
    };
    if (filters.publishedFrom && filters.publishedTo && filters.publishedFrom > filters.publishedTo) throw new Error('"publishedFrom" is after "publishedTo".');
    if (filters.auctionDateFrom && filters.auctionDateTo && filters.auctionDateFrom > filters.auctionDateTo) throw new Error('"auctionDateFrom" is after "auctionDateTo".');

    const monitorName = String(input.monitorName ?? '').trim() || null;
    const scanMode = String(input.scanMode ?? 'auto').trim() || 'auto';
    if (!['auto', 'changeFeed', 'latestByType'].includes(scanMode)) throw new Error('"scanMode" must be "auto", "changeFeed" or "latestByType".');
    if (scanMode === 'latestByType' && !filters.sellingMethods.length) throw new Error('"scanMode": "latestByType" needs at least one value in "sellingMethods".');
    const alertOn = String(input.alertOn ?? 'newlyPublished').trim();
    if (!['newlyPublished', 'newlyMatching'].includes(alertOn)) throw new Error('"alertOn" must be "newlyPublished" or "newlyMatching".');
    const storeName = String(input.stateStoreName ?? '').trim() || 'prozorro-sale-monitor';
    if (!/^[a-zA-Z0-9-]{1,63}$/.test(storeName)) throw new Error('"stateStoreName" may only contain letters, digits and "-" (max 63 characters).');

    return {
        mode,
        auctionIds: [...new Set(auctionIds)],
        filters,
        unknownStatuses,
        changedSince: parseDate(input.changedSince, 'changedSince'),
        lookbackHours: toNum(input.lookbackHours, 'lookbackHours', { def: 24, min: 1, max: 24 * 365 }),
        maxPages: toNum(input.maxPages, 'maxPages', { def: 50, min: 1, max: 5000, int: true }),
        maxResults: toNum(input.maxResults, 'maxResults', { def: 200, min: 0, int: true }),
        scanMode,
        includeItems: input.includeItems !== false,
        includeDocuments: input.includeDocuments !== false,
        includeRaw: input.includeRaw === true,
        monitorName,
        alertOn,
        reportAllOnFirstRun: input.reportAllOnFirstRun === true,
        resetState: input.resetState === true,
        storeName,
        notifyMaxItems: toNum(input.notifyMaxItems, 'notifyMaxItems', { def: 10, min: 0, max: 100, int: true }),
        webhookMaxItems: toNum(input.webhookMaxItems, 'webhookMaxItems', { def: 100, min: 0, max: 1000, int: true }),
        notifyOnNoChanges: input.notifyOnNoChanges === true,
        instance,
        apiBaseUrl,
        requestIntervalMs: toNum(input.requestIntervalMs, 'requestIntervalMs', { def: 300, min: 100, max: 10_000, int: true }),
    };
}
