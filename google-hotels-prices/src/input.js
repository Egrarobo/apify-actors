import { parseEntityId, DEFAULT_BASE_URL } from './request.js';

export class InputError extends Error {}

const DAY = 86_400_000;
const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new InputError(`"${name}" must be a list of strings.`);
    return v.map((s) => String(s ?? '').trim()).filter(Boolean);
};
const toInt = (v, name, { min, max, def }) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isInteger(x) || x < min || x > max) throw new InputError(`"${name}" must be a whole number between ${min} and ${max} (got ${JSON.stringify(v)}).`);
    return x;
};
const toNum = (v, name, { min = 0, max = Infinity } = {}) => {
    if (v === undefined || v === null || v === '') return null;
    const x = Number(v);
    if (!Number.isFinite(x) || x < min || x > max) throw new InputError(`"${name}" must be a number between ${min} and ${max === Infinity ? 'any' : max} (got ${JSON.stringify(v)}).`);
    return x;
};
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** "2026-11-12", "+30 days", "30 days", "in 2 weeks", "today", "tomorrow" → "YYYY-MM-DD" (UTC). */
export function parseDay(v, name, now = Date.now()) {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    const today = Math.floor(now / DAY) * DAY;
    if (s === 'today') return isoDay(today);
    if (s === 'tomorrow') return isoDay(today + DAY);
    const rel = s.match(/^(?:in\s+)?\+?\s*(\d+)\s*(day|d|week|w|month)s?(?:\s+from\s+now)?$/);
    if (rel) {
        const n = Number(rel[1]);
        const mult = { day: 1, d: 1, week: 7, w: 7, month: 30 }[rel[2]];
        return isoDay(today + n * mult * DAY);
    }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:t.*)?$/);
    if (m) {
        const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
        if (Number.isFinite(t) && isoDay(t) === `${m[1]}-${m[2]}-${m[3]}`) return isoDay(t);
    }
    throw new InputError(`"${name}" is not a valid date: "${v}". Use "2026-11-12" or a relative value like "+30 days".`);
}

const CLASS_VALUES = [1, 2, 3, 4, 5];

export function parseInput(input, { now = Date.now() } = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('The input must be a JSON object.');

    const queries = [...new Set(toList(input.queries, 'queries'))];
    const hotelNames = [...new Set(toList(input.hotelNames, 'hotelNames'))];
    const rawUrls = toList(input.hotelUrls, 'hotelUrls');
    const entityIds = [];
    const bad = [];
    for (const u of rawUrls) {
        const id = parseEntityId(u);
        if (id) {
            if (!entityIds.includes(id)) entityIds.push(id);
        } else bad.push(u);
    }
    if (bad.length) {
        throw new InputError(`These are not Google Hotels hotel links: ${bad.slice(0, 3).map((b) => `"${b}"`).join(', ')}. `
            + 'Use links like https://www.google.com/travel/hotels/entity/ChoIxPKIzoX4zIfLARoNL2cvMTFwd2g1N2c1NRAB (open a hotel on Google Hotels and copy the address), or put hotel names into "hotelNames".');
    }
    if (!queries.length && !hotelNames.length && !entityIds.length) {
        throw new InputError('Add at least one search in "queries" (e.g. "hotels in Paris"), a hotel name in "hotelNames", or a hotel link in "hotelUrls".');
    }

    const today = isoDay(Math.floor(now / DAY) * DAY);
    const checkIn = parseDay(input.checkInDate, 'checkInDate', now) ?? isoDay(Date.parse(`${today}T00:00:00Z`) + 30 * DAY);
    if (checkIn < today) throw new InputError(`"checkInDate" ${checkIn} is in the past. Google Hotels only has prices for future stays.`);
    let checkOut = parseDay(input.checkOutDate, 'checkOutDate', now);
    const nightsIn = toInt(input.nights, 'nights', { min: 1, max: 30, def: 1 });
    if (!checkOut) checkOut = isoDay(Date.parse(`${checkIn}T00:00:00Z`) + nightsIn * DAY);
    if (checkOut <= checkIn) throw new InputError(`"checkOutDate" (${checkOut}) must be after "checkInDate" (${checkIn}).`);
    const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / DAY);
    if (nights > 30) throw new InputError(`The stay is ${nights} nights; Google Hotels allows at most 30.`);
    if (Date.parse(`${checkIn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) > 330 * DAY) throw new InputError('"checkInDate" is too far ahead; Google Hotels shows prices up to about 11 months in advance.');

    const adults = toInt(input.adults, 'adults', { min: 1, max: 12, def: 2 });
    const children = toInt(input.children, 'children', { min: 0, max: 8, def: 0 });
    const agesRaw = toList(input.childrenAges, 'childrenAges');
    const childrenAges = agesRaw.map((a) => {
        const x = Number(a);
        if (!Number.isInteger(x) || x < 0 || x > 17) throw new InputError(`"childrenAges" must contain ages from 0 to 17 (got "${a}").`);
        return x;
    });
    if (childrenAges.length && childrenAges.length !== children) {
        throw new InputError(`"childrenAges" has ${childrenAges.length} age(s) but "children" is ${children}. Give one age per child or leave the ages empty.`);
    }
    while (childrenAges.length < children) childrenAges.push(8);

    const currency = String(input.currency || 'USD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new InputError(`"currency" must be a 3-letter code such as USD, EUR or GBP (got "${input.currency}").`);
    const language = String(input.language || 'en').trim();
    if (!/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(language)) throw new InputError(`"language" must be a language code such as "en", "de" or "pt-BR" (got "${input.language}").`);
    const country = String(input.country || 'us').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(country)) throw new InputError(`"country" must be a 2-letter country code such as "us", "gb" or "de" (got "${input.country}").`);

    const minPrice = toNum(input.minPrice, 'minPrice');
    const maxPrice = toNum(input.maxPrice, 'maxPrice');
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw new InputError('"minPrice" is higher than "maxPrice".');
    const minRating = toNum(input.minRating, 'minRating', { min: 0, max: 5 });
    const hotelClass = toList(input.hotelClass, 'hotelClass').map((c) => {
        const x = Number(String(c).replace(/[^\d]/g, ''));
        if (!CLASS_VALUES.includes(x)) throw new InputError(`"hotelClass" values must be 1 to 5 (got "${c}").`);
        return x;
    });

    const useBrowser = input.useBrowser === true ? 'always' : input.useBrowser === false ? 'never' : (input.useBrowser || 'fallback');
    if (!['fallback', 'always', 'never'].includes(useBrowser)) throw new InputError('"useBrowser" must be "fallback", "always" or "never".');
    const searchMethod = input.searchMethod || 'auto';
    if (!['auto', 'page', 'rpc'].includes(searchMethod)) throw new InputError('"searchMethod" must be "auto", "page" or "rpc".');

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

    return {
        queries,
        hotelNames,
        entityIds,
        checkIn,
        checkOut,
        nights,
        adults,
        children,
        childrenAges: children ? childrenAges : [],
        currency,
        language,
        country,
        maxHotelsPerQuery: toInt(input.maxHotelsPerQuery, 'maxHotelsPerQuery', { min: 1, max: 5000, def: 20 }),
        maxPagesPerQuery: toInt(input.maxPagesPerQuery, 'maxPagesPerQuery', { min: 1, max: 100, def: 10 }),
        includeOffers: input.includeOffers === true,
        maxOffersPerHotel: toInt(input.maxOffersPerHotel, 'maxOffersPerHotel', { min: 0, max: 200, def: 0 }),
        filters: { minPrice, maxPrice, minRating, hotelClass },
        proxyConfiguration: input.proxyConfiguration ?? null,
        useBrowser,
        searchMethod,
        maxRetries: toInt(input.maxRetries, 'maxRetries', { min: 0, max: 10, def: 4 }),
        maxConcurrency: toInt(input.maxConcurrency, 'maxConcurrency', { min: 1, max: 10, def: 3 }),
        requestTimeoutSecs: toInt(input.requestTimeoutSecs, 'requestTimeoutSecs', { min: 5, max: 180, def: 45 }),
        saveDebugPages: input.saveDebugPages !== false,
        baseUrl,
    };
}

/** Client-side filters; a hotel without a price fails price filters (it can't be compared). */
export function buildFilter({ minPrice, maxPrice, minRating, hotelClass }) {
    return (h) => {
        const price = h.pricePerNight;
        if (minPrice !== null && (price === null || price < minPrice)) return false;
        if (maxPrice !== null && (price === null || price > maxPrice)) return false;
        if (minRating !== null && (h.rating === null || h.rating < minRating)) return false;
        if (hotelClass.length && !hotelClass.includes(h.hotelClass)) return false;
        return true;
    };
}
