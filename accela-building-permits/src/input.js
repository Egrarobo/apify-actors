import { resolveAgency, DEFAULT_AGENCIES } from './agencies.js';

export class InputError extends Error {}

const DAY = 86_400_000;

const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new InputError(`"${name}" must be a list of strings.`);
    return v.map((s) => String(s ?? '').trim()).filter(Boolean);
};

const toNum = (v, name, { min = -Infinity, max = Infinity, def = null } = {}) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isFinite(x) || x < min) throw new InputError(`"${name}" must be a number${min > -Infinity ? ` of at least ${min}` : ''}.`);
    return Math.min(Math.floor(x), max);
};

/** Today in US Eastern time as YYYY-MM-DD (portals are in US time zones; UTC "today" can be tomorrow there). */
export function usToday(now = Date.now()) {
    return new Date(now - 5 * 3_600_000).toISOString().slice(0, 10);
}

const addDays = (isoDay, n) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function parseDay(v, name, now) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim();
    const rel = s.toLowerCase().match(/^(\d+)\s*(day|d|week|w|month)s?(?:\s+ago)?$/);
    if (rel) {
        const n = Number(rel[1]) * ({ day: 1, d: 1, week: 7, w: 7, month: 30 }[rel[2]]);
        return addDays(usToday(now), -n);
    }
    if (s.toLowerCase() === 'today') return usToday(now);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    throw new InputError(`"${name}" is not a valid date: "${v}". Use e.g. "2026-09-01" or "14 days".`);
}

export function parseInput(input, { now = Date.now(), hostOverride = null } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('The input must be a JSON object.');

    const rawAgencies = [...toList(input.agencies, 'agencies'), ...toList(input.customAgencies, 'customAgencies')];
    if (!rawAgencies.length) rawAgencies.push(...DEFAULT_AGENCIES);
    const moduleOverride = String(input.module ?? '').trim();
    if (moduleOverride && !/^[A-Za-z0-9_ -]{2,40}$/.test(moduleOverride)) throw new InputError('"module" must be a module name such as Building, Permits or Development.');
    const agencies = [];
    const bad = [];
    for (const raw of rawAgencies) {
        const a = resolveAgency(raw, { hostOverride });
        if (!a) {
            bad.push(raw);
            continue;
        }
        const module = a.moduleFromUrl ? a.module : (moduleOverride || a.module || 'Building');
        if (!agencies.some((x) => x.baseUrl.toLowerCase() === a.baseUrl.toLowerCase() && x.module.toLowerCase() === module.toLowerCase())) agencies.push({ ...a, module });
    }
    if (bad.length) {
        throw new InputError(`Not an Accela agency code or portal URL: ${bad.slice(0, 5).map((b) => `"${b}"`).join(', ')}. `
            + 'Use the code after aca-prod.accela.com/ in the portal address (e.g. "TAMPA") or the full URL of the portal\'s search page.');
    }
    if (agencies.length > 50) throw new InputError('At most 50 agencies per run.');

    const today = usToday(now);
    const lastNDays = toNum(input.lastNDays, 'lastNDays', { min: 1, max: 3650, def: 7 });
    let dateFrom = parseDay(input.dateFrom, 'dateFrom', now);
    let dateTo = parseDay(input.dateTo, 'dateTo', now) ?? today;
    if (!dateFrom) dateFrom = addDays(today, -(lastNDays - 1));
    if (dateTo < dateFrom) throw new InputError(`"dateTo" (${dateTo}) is before "dateFrom" (${dateFrom}).`);
    if (dateFrom > addDays(today, 1)) throw new InputError(`"dateFrom" (${dateFrom}) is in the future.`);
    const spanDays = Math.round((Date.parse(dateTo) - Date.parse(dateFrom)) / DAY) + 1;
    if (spanDays > 3660) throw new InputError('The date range can be at most 10 years.');

    const exportMode = input.exportMode || 'auto';
    if (!['auto', 'grid', 'csv'].includes(exportMode)) throw new InputError('"exportMode" must be "auto", "grid" or "csv".');

    const stateStoreName = String(input.stateStoreName || 'accela-permits-monitor').trim();
    if (!/^[a-zA-Z0-9-]{1,63}$/.test(stateStoreName)) throw new InputError('"stateStoreName" may only contain letters, digits and "-" (max 63 characters).');

    return {
        agencies,
        dateFrom,
        dateTo,
        dateFromGiven: !!input.dateFrom,
        lastNDays,
        spanDays,
        permitTypes: toList(input.permitTypes, 'permitTypes'),
        excludeKeywords: toList(input.excludeKeywords, 'excludeKeywords'),
        statuses: toList(input.statuses, 'statuses'),
        recordTypes: toList(input.recordTypes, 'recordTypes'),
        maxRecordsPerAgency: toNum(input.maxRecordsPerAgency, 'maxRecordsPerAgency', { min: 0, def: 500 }),
        maxPagesPerAgency: toNum(input.maxPagesPerAgency, 'maxPagesPerAgency', { min: 1, max: 2000, def: 100 }),
        searchWindowDays: toNum(input.searchWindowDays, 'searchWindowDays', { min: 1, max: 366, def: 7 }),
        includeDetails: input.includeDetails === true,
        includePersonalNames: input.includePersonalNames === true,
        exportMode,
        monitorName: String(input.monitorName ?? '').trim(),
        reportAllOnFirstRun: input.reportAllOnFirstRun === true,
        resetState: input.resetState === true,
        stateStoreName,
        notifyMaxItems: toNum(input.notifyMaxItems, 'notifyMaxItems', { min: 0, max: 100, def: 10 }),
        webhookMaxItems: toNum(input.webhookMaxItems, 'webhookMaxItems', { min: 0, max: 1000, def: 100 }),
        notifyOnNoChanges: input.notifyOnNoChanges === true,
        browserFallback: input.browserFallback !== false,
        forceBrowser: input.forceBrowser === true,
        requestDelayMs: toNum(input.requestDelayMs, 'requestDelayMs', { min: 0, max: 20_000, def: 700 }),
        maxRetries: toNum(input.maxRetries, 'maxRetries', { min: 0, max: 8, def: 3 }),
        saveDebugPages: input.saveDebugPages !== false,
        proxyConfiguration: input.proxyConfiguration,
    };
}

/** Splits [from, to] into windows of `days` days, newest first. */
export function dateWindows(from, to, days) {
    const out = [];
    let end = to;
    while (end >= from) {
        let start = addDays(end, -(days - 1));
        if (start < from) start = from;
        out.push({ from: start, to: end });
        end = addDays(start, -1);
    }
    return out;
}
