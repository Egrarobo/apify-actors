import { tescoCategoryFromUrl, tescoProductFromUrl } from './store.js';

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

function tescoUrl(u) {
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'tesco.com' ? url : null;
}

/** Parses and validates the Actor input. Throws InputError with a message meant for the user. */
export function parseInput(input = {}) {
    const searchTerms = list(input.searchTerms, 'searchTerms');

    const categories = [];
    const badUrls = [];
    for (const raw of list(input.categoryUrls, 'categoryUrls')) {
        const url = tescoUrl(raw);
        const parsed = url ? tescoCategoryFromUrl(url.href) : null;
        if (!parsed) badUrls.push(raw);
        else categories.push({ url: url.href, ...parsed });
    }
    if (badUrls.length) {
        throw new InputError(`These "categoryUrls" are not Tesco category pages: ${badUrls.slice(0, 5).join(', ')}. `
            + 'Use links like https://www.tesco.com/shop/en-GB/browse/fresh-food/all or https://www.tesco.com/groceries/en-GB/shop/fresh-food/milk-butter-and-eggs/milk. '
            + 'For Clubcard Prices use "Only Clubcard Prices".');
    }

    const products = [];
    const badIds = [];
    for (const raw of list(input.productIds, 'productIds')) {
        const bare = raw.match(/^(?:tesco\s*[:#]\s*)?(\d{5,12})$/i);
        if (bare) {
            products.push({ id: bare[1], input: raw });
            continue;
        }
        const url = tescoUrl(raw);
        const id = url ? tescoProductFromUrl(url.href) : null;
        if (id) products.push({ id, input: raw });
        else badIds.push(raw);
    }
    if (badIds.length) {
        throw new InputError(`Could not understand these "productIds": ${badIds.slice(0, 5).join(', ')}. `
            + 'Use product links (https://www.tesco.com/shop/en-GB/products/254656543) or Tesco product numbers (254656543).');
    }

    const onlyClubcardPrices = input.onlyClubcardPrices === true;
    const onlySpecials = input.onlySpecials === true || onlyClubcardPrices;
    if (!searchTerms.length && !categories.length && !products.length && !onlySpecials) {
        throw new InputError('Nothing to do: add at least one search term, category URL or product — or turn on "Only offers" / "Only Clubcard Prices" to scan all departments for offers.');
    }
    const apiKey = input.apiKey ? String(input.apiKey).trim() : null;
    if (apiKey && !/^[A-Za-z0-9_-]{16,64}$/.test(apiKey)) throw new InputError('"apiKey" does not look like a Tesco API key (16–64 letters and digits). Leave it empty to use the built-in key.');

    return {
        searchTerms,
        categories,
        products,
        onlySpecials,
        onlyClubcardPrices,
        apiKey,
        maxItemsPerSearch: clampInt(input.maxItemsPerSearch, 100, 1, 20_000, 'maxItemsPerSearch'),
        maxPagesPerSearch: clampInt(input.maxPagesPerSearch, 30, 1, 500, 'maxPagesPerSearch'),
        useBrowserForCookies: input.useBrowserForCookies === true,
        browserFallback: input.browserFallback !== false,
        maxRetries: clampInt(input.maxRetries, 4, 0, 10, 'maxRetries'),
        requestDelayMs: clampInt(input.requestDelayMs, 1000, 0, 30_000, 'requestDelayMs'),
        saveDebugPages: input.saveDebugPages !== false,
        includeRaw: input.includeRaw === true,
        proxyConfiguration: input.proxyConfiguration ?? { useApifyProxy: true },
        apiBaseUrl: input.apiBaseUrl ? String(input.apiBaseUrl).replace(/\/+$/, '') : undefined,
        siteBaseUrl: input.siteBaseUrl ? String(input.siteBaseUrl).replace(/\/+$/, '') : undefined,
    };
}
