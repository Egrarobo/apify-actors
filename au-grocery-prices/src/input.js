import { colesCategoryFromUrl, colesProductFromUrl } from './stores/coles.js';
import { woolworthsCategoryFromUrl, woolworthsProductFromUrl } from './stores/woolworths.js';

export class InputError extends Error {}

export const STORES = ['coles', 'woolworths'];
const STORE_ALIASES = { coles: 'coles', woolworths: 'woolworths', woolies: 'woolworths', ww: 'woolworths', wow: 'woolworths' };

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

function hostStore(u) {
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    } catch {
        return { url: null, store: null };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'coles.com.au' || host === 'shop.coles.com.au') return { url, store: 'coles' };
    if (host === 'woolworths.com.au') return { url, store: 'woolworths' };
    return { url, store: null };
}

/** Parses and validates the Actor input. Throws InputError with a message meant for the user. */
export function parseInput(input = {}) {
    const rawStores = list(input.stores ?? STORES, 'stores').map((s) => s.toLowerCase());
    const bad = rawStores.filter((s) => !STORE_ALIASES[s]);
    if (bad.length) throw new InputError(`Unknown store(s) in "stores": ${bad.join(', ')}. Use "coles" and/or "woolworths".`);
    const stores = [...new Set(rawStores.map((s) => STORE_ALIASES[s]))];
    if (!stores.length) throw new InputError('Select at least one store in "stores" (coles, woolworths).');

    const searchTerms = list(input.searchTerms, 'searchTerms');
    const categories = [];
    const badUrls = [];
    for (const raw of list(input.categoryUrls, 'categoryUrls')) {
        const { url, store } = hostStore(raw);
        const parsed = store === 'coles' ? colesCategoryFromUrl(url.href) : store === 'woolworths' ? woolworthsCategoryFromUrl(url.href) : null;
        if (!parsed) badUrls.push(raw);
        else categories.push({ store, url: url.href, ...parsed });
    }
    if (badUrls.length) {
        throw new InputError(`These "categoryUrls" are not Coles or Woolworths category pages: ${badUrls.slice(0, 5).join(', ')}. `
            + 'Use links like https://www.coles.com.au/browse/dairy-eggs-fridge or https://www.woolworths.com.au/shop/browse/fruit-veg.');
    }

    const products = [];
    const badIds = [];
    for (const raw of list(input.productIds, 'productIds')) {
        const prefixed = raw.match(/^(coles|woolworths|woolies|ww|wow)\s*[:#]\s*(\d{1,12})$/i);
        if (prefixed) {
            products.push({ store: STORE_ALIASES[prefixed[1].toLowerCase()], id: prefixed[2], input: raw });
            continue;
        }
        if (/^\d{1,12}$/.test(raw)) {
            for (const store of stores) products.push({ store, id: raw, input: raw });
            continue;
        }
        const { url, store } = hostStore(raw);
        if (store === 'coles') {
            const p = colesProductFromUrl(url.href);
            if (p) {
                products.push({ store, id: p.id, slug: p.slug, input: raw });
                continue;
            }
        } else if (store === 'woolworths') {
            const id = woolworthsProductFromUrl(url.href);
            if (id) {
                products.push({ store, id, input: raw });
                continue;
            }
        }
        badIds.push(raw);
    }
    if (badIds.length) {
        throw new InputError(`Could not understand these "productIds": ${badIds.slice(0, 5).join(', ')}. `
            + 'Use product links (https://www.coles.com.au/product/…-1234567, https://www.woolworths.com.au/shop/productdetails/123456/…), '
            + '"coles:1234567" / "woolworths:123456", or a bare product number (looked up in every selected store).');
    }

    const onlySpecials = input.onlySpecials === true;
    if (!searchTerms.length && !categories.length && !products.length && !onlySpecials) {
        throw new InputError('Nothing to do: add at least one search term, category URL or product ID — or turn on "Only specials" to get all current specials.');
    }

    return {
        stores,
        searchTerms,
        categories,
        products,
        onlySpecials,
        includeSponsored: input.includeSponsored === true,
        maxItemsPerSearch: clampInt(input.maxItemsPerSearch, 100, 1, 20_000, 'maxItemsPerSearch'),
        maxPagesPerSearch: clampInt(input.maxPagesPerSearch, 30, 1, 500, 'maxPagesPerSearch'),
        useBrowserForCookies: input.useBrowserForCookies !== false,
        browserFallback: input.browserFallback !== false,
        maxRetries: clampInt(input.maxRetries, 4, 0, 10, 'maxRetries'),
        requestDelayMs: clampInt(input.requestDelayMs, 800, 0, 30_000, 'requestDelayMs'),
        saveDebugPages: input.saveDebugPages !== false,
        includeRaw: input.includeRaw === true,
        proxyConfiguration: input.proxyConfiguration ?? { useApifyProxy: true },
        colesBaseUrl: input.colesBaseUrl ? String(input.colesBaseUrl).replace(/\/+$/, '') : undefined,
        woolworthsBaseUrl: input.woolworthsBaseUrl ? String(input.woolworthsBaseUrl).replace(/\/+$/, '') : undefined,
    };
}
