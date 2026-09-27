import { aldiListingFromUrl, aldiSkuFromUrl, SORTS } from './store.js';
import { padSku } from './normalize.js';

export class InputError extends Error {}

const clampInt = (v, def, min, max, name) => {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new InputError(`"${name}" must be a number.`);
    return Math.min(max, Math.max(min, Math.round(n)));
};

const list = (v, name) => {
    if (v === undefined || v === null) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/\n/);
    return [...new Set(arr.map((x) => (typeof x === 'object' && x !== null ? (x.url ?? x.value ?? '') : x)).map((x) => String(x ?? '').trim()).filter(Boolean))]
        .map((x) => {
            if (x.length > 500) throw new InputError(`A value in "${name}" is too long.`);
            return x;
        });
};

function aldiUrl(u) {
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'aldi.com.au' ? url : null;
}

/** Parses and validates the Actor input. Throws InputError with a message meant for the user. */
export function parseInput(input = {}) {
    const searchTerms = list(input.searchTerms, 'searchTerms');

    const listings = [];
    const badUrls = [];
    for (const raw of list(input.categoryUrls, 'categoryUrls')) {
        const url = aldiUrl(raw);
        const parsed = url ? aldiListingFromUrl(url.href) : null;
        if (!parsed) badUrls.push(raw);
        else listings.push({ url: url.href, ...parsed });
    }
    if (badUrls.length) {
        throw new InputError(`These "categoryUrls" are not ALDI Australia category or Special Buys pages: ${badUrls.slice(0, 5).join(', ')}. `
            + 'Use links like https://www.aldi.com.au/products/dairy-eggs-fridge/k/960000000 or https://www.aldi.com.au/special-buys/2026-09-30.');
    }

    const skus = [];
    const badIds = [];
    for (const raw of list(input.productIds, 'productIds')) {
        const bare = raw.match(/^(?:aldi\s*[:#]\s*)?(\d{4,18})$/i);
        if (bare) {
            skus.push({ sku: padSku(bare[1]), input: raw });
            continue;
        }
        const url = aldiUrl(raw);
        const sku = url ? aldiSkuFromUrl(url.href) : null;
        if (sku) skus.push({ sku, input: raw });
        else badIds.push(raw);
    }
    if (badIds.length) {
        throw new InputError(`Could not understand these "productIds": ${badIds.slice(0, 5).join(', ')}. `
            + 'Use product links (https://www.aldi.com.au/product/lodge-farms-cage-eggs-700g-000000000000399451) or ALDI product numbers (399451 or 000000000000399451).');
    }

    const onlySpecials = input.onlySpecials === true;
    if (!searchTerms.length && !listings.length && !skus.length && !onlySpecials) {
        throw new InputError('Nothing to do: add at least one search term, category URL or product — or turn on "Only specials" to get the current Special Buys, Super Savers and Lower Prices.');
    }

    const sort = String(input.sortBy ?? 'relevance');
    if (!SORTS.includes(sort)) throw new InputError(`"sortBy" must be one of: ${SORTS.join(', ')}.`);
    const storeId = input.storeId ? String(input.storeId).trim() : null;
    if (storeId && !/^[A-Za-z0-9-]{1,20}$/.test(storeId)) throw new InputError('"storeId" should look like an ALDI store code, e.g. "G452". Leave it empty to pick one automatically.');

    return {
        searchTerms,
        listings,
        skus,
        onlySpecials,
        sort,
        storeId,
        maxItemsPerSearch: clampInt(input.maxItemsPerSearch, 100, 1, 20_000, 'maxItemsPerSearch'),
        maxPagesPerSearch: clampInt(input.maxPagesPerSearch, 30, 1, 500, 'maxPagesPerSearch'),
        useBrowserForCookies: input.useBrowserForCookies === true,
        browserFallback: input.browserFallback !== false,
        maxRetries: clampInt(input.maxRetries, 4, 0, 10, 'maxRetries'),
        requestDelayMs: clampInt(input.requestDelayMs, 500, 0, 30_000, 'requestDelayMs'),
        saveDebugPages: input.saveDebugPages !== false,
        includeRaw: input.includeRaw === true,
        proxyConfiguration: input.proxyConfiguration ?? { useApifyProxy: true },
        apiBaseUrl: input.apiBaseUrl ? String(input.apiBaseUrl).replace(/\/+$/, '') : undefined,
        siteBaseUrl: input.siteBaseUrl ? String(input.siteBaseUrl).replace(/\/+$/, '') : undefined,
    };
}
