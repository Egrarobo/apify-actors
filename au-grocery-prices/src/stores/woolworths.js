// Woolworths (www.woolworths.com.au) — SPA whose catalogue arrives over its own JSON API, fronted by Akamai.
//
// Verified from open-source code:
//  - POST /apis/ui/Search/products (body copied from the site's own requests on 2026-09-16 by
//    2scraper/woolworths-scraper product_parser.search_request_body) → {Products: [{Products: [product]}], SearchResultsCount}
//  - POST /apis/ui/browse/category (same source + Javex/hotprices-au woolies.py) → {Bundles: [...], TotalRecordCount};
//    categoryId is an opaque NodeId (e.g. "1_DEB537E"), NOT the slug; specials are NodeId "specialsgroup".
//  - GET  /apis/ui/PiesCategoriesWithSpecials → {Categories: [{NodeId, Description, UrlFriendlyName, Children}]}
//  - GET  /apis/ui/products/{stockcode} → [product] (2scraper, "by stockcode")
//  - Plain `requests` after a homepage GET works for hotprices-au (daily scrape); 2scraper measured that a HEADLESS
//    browser is refused by Akamai from a datacentre IP while a HEADFUL one is served, and that
//    --disable-blink-features=AutomationControlled avoids the /unauthorisederror redirect.
//  - Past the last real page the API keeps returning sponsored rows only (2scraper), so paging stops when a page has
//    no organic (non-sponsored) rows.
// Assumed: GET /apis/ui/product/detail/{stockcode} as a secondary product endpoint.
import { StoreClient } from '../client.js';
import { normalizeWoolworths, flattenWoolworths, WOOLWORTHS_BASE_URL } from '../normalize.js';

export const PAGE_SIZE = 36;

export function searchBody(term, page) {
    return {
        SearchTerm: term,
        PageNumber: page,
        PageSize: PAGE_SIZE,
        SortType: 'TraderRelevance',
        Filters: [],
        IsSpecial: false,
        Location: `/shop/search/products?searchTerm=${term}`,
        formatObject: JSON.stringify({ name: term }),
        isBundle: false,
        isMobile: false,
        isHideUnavailableProducts: false,
        isRegisteredRewardCardPromotion: false,
        enableAdReRanking: false,
        groupEdmVariants: true,
        categoryVersion: 'v2',
    };
}

export function categoryBody(categoryId, slug, page, displayName) {
    const urlPath = `/shop/browse/${slug}`;
    return {
        categoryId,
        pageNumber: page,
        pageSize: PAGE_SIZE,
        sortType: 'TraderRelevance',
        url: urlPath,
        location: urlPath,
        formatObject: JSON.stringify({ name: displayName || slug }),
        isSpecial: categoryId === 'specialsgroup',
        isBundle: false,
        isMobile: false,
        isHideUnavailableProducts: false,
        isRegisteredRewardCardPromotion: false,
        isHideEverydayMarketProducts: false,
        filters: [],
        categoryVersion: 'v2',
    };
}

/** Resolves a /shop/browse/{a}/{b} slug path to the NodeId via the category tree (walks children). */
export function categoryIdForSlug(tree, slugPath) {
    const parts = String(slugPath).toLowerCase().split('/').filter(Boolean);
    let nodes = tree?.Categories ?? tree;
    let match = null;
    for (const part of parts) {
        match = (Array.isArray(nodes) ? nodes : []).find((n) => String(n?.UrlFriendlyName ?? '').toLowerCase() === part) ?? null;
        if (!match) return null;
        nodes = match.Children ?? [];
    }
    return match ? { id: String(match.NodeId), name: match.Description ?? parts.at(-1) } : null;
}

export class WoolworthsClient extends StoreClient {
    constructor(opts) {
        super({ ...opts, store: 'woolworths', label: 'Woolworths', baseUrl: opts.baseUrl ?? WOOLWORTHS_BASE_URL, readySelector: null });
        this.tree = null;
    }

    parseHome() {
        return {};
    }

    apiHeaders(referer) {
        return {
            accept: 'application/json, text/plain, */*',
            origin: this.baseUrl,
            referer: `${this.baseUrl}${referer}`,
        };
    }

    async categoryTree() {
        if (this.tree) return this.tree;
        this.tree = await this.requestJson({ step: 'category tree', url: `${this.baseUrl}/apis/ui/PiesCategoriesWithSpecials`, headers: this.apiHeaders('/') });
        return this.tree;
    }

    /**
     * Walks a listing. kind: { type: 'search', term } | { type: 'category', slug } | { type: 'specials' }
     * Yields { items (raw products), page, total }.
     */
    async* listing(kind, { maxPages = 30 } = {}) {
        let category = null;
        if (kind.type === 'specials') category = { id: 'specialsgroup', name: 'Specials', slug: 'specials' };
        if (kind.type === 'category') {
            if (kind.slug.toLowerCase() === 'specials') category = { id: 'specialsgroup', name: 'Specials', slug: 'specials' };
            else {
                const tree = await this.categoryTree();
                const found = categoryIdForSlug(tree, kind.slug);
                if (!found) {
                    const top = (tree?.Categories ?? []).map((c) => c.UrlFriendlyName).filter(Boolean).slice(0, 30).join(', ');
                    throw Object.assign(new Error(`category "${kind.slug}" was not found in the Woolworths category tree. Top-level categories: ${top}`), { step: 'category lookup' });
                }
                category = { ...found, slug: kind.slug };
            }
        }
        let total = null;
        let seen = 0;
        for (let page = 1; page <= maxPages; page++) {
            let data;
            if (kind.type === 'search') {
                const step = `search "${kind.term}" page ${page}`;
                data = await this.requestJson({
                    step, method: 'POST', url: `${this.baseUrl}/apis/ui/Search/products`, body: searchBody(kind.term, page),
                    headers: this.apiHeaders(`/shop/search/products?searchTerm=${encodeURIComponent(kind.term)}`),
                });
                if (page === 1) total = Number(data?.SearchResultsCount ?? 0);
            } else {
                const step = `${category.id === 'specialsgroup' ? 'specials' : `category ${category.slug}`} page ${page}`;
                data = await this.requestJson({
                    step, method: 'POST', url: `${this.baseUrl}/apis/ui/browse/category`, body: categoryBody(category.id, category.slug, page, category.name),
                    headers: this.apiHeaders(`/shop/browse/${category.slug}`),
                });
                if (page === 1) total = Number(data?.TotalRecordCount ?? 0);
            }
            if (data && typeof data === 'object' && !Array.isArray(data) && !('Products' in data) && !('Bundles' in data)) {
                const keys = Object.keys(data).slice(0, 12).join(', ');
                throw Object.assign(new Error(`unexpected response shape — no Products/Bundles (keys: ${keys || 'none'}). Woolworths may have changed its API.`), { step: `${kind.type} page ${page}` });
            }
            const items = flattenWoolworths(data);
            const organic = items.filter((p) => p.IsSponsoredAd !== true).length;
            seen += organic;
            yield { items, page, total };
            // Sponsored rows never run out, so stop on a page without organic rows (measured by 2scraper).
            if (!items.length || organic === 0 || (total !== null && seen >= total)) return;
        }
    }

    async product(stockcode) {
        const code = String(stockcode);
        const data = await this.requestJson({
            step: `product ${code}`, url: `${this.baseUrl}/apis/ui/products/${code}`, headers: this.apiHeaders(`/shop/productdetails/${code}`), allowNotFound: true,
        });
        let hit = data?.notFound ? null : flattenWoolworths(data).find((p) => String(p.Stockcode) === code) ?? null;
        if (!hit) {
            const d2 = await this.requestJson({
                step: `product ${code} (detail)`, url: `${this.baseUrl}/apis/ui/product/detail/${code}?isMobile=false`,
                headers: this.apiHeaders(`/shop/productdetails/${code}`), allowNotFound: true,
            }).catch(() => null);
            hit = d2 && !d2.notFound ? flattenWoolworths(d2).find((p) => String(p.Stockcode) === code) ?? null : null;
        }
        return hit;
    }
}

export const woolworthsNormalize = normalizeWoolworths;

/** https://www.woolworths.com.au/shop/browse/fruit-veg/fruit → { type:'category', slug:'fruit-veg/fruit' } */
export function woolworthsCategoryFromUrl(u) {
    const url = new URL(u);
    const m = url.pathname.match(/^\/shop\/browse\/(.+?)\/?$/i);
    if (!m) return null;
    const slug = m[1].toLowerCase();
    return slug === 'specials' ? { type: 'specials' } : { type: 'category', slug };
}

/** https://www.woolworths.com.au/shop/productdetails/277728/woolworths-white-sandwich-bread-loaf → '277728' */
export function woolworthsProductFromUrl(u) {
    const url = new URL(u);
    return url.pathname.match(/^\/shop\/productdetails\/(\d+)/i)?.[1] ?? null;
}
