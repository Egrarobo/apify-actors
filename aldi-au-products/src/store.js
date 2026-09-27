// ALDI Australia — the www.aldi.com.au product catalogue (launched 2024 on the ALDI SÜD "aldi.cx" platform) is served by
// a public JSON API on api.aldi.com.au.
//
// Verified from open-source code for the SAME platform (ALDI SÜD group: DE, CH, AU, UK, US share it):
//  - GET /v3/product-search?serviceType=walk-in&servicePoint=…&currency=…&limit=…&offset=…&sort=relevance
//        [&q=term | &categoryKey=… | &promotionKey=YYYY-MM-DD]
//        → {meta: {pagination: {offset, limit, totalCount}, facets}, data: [product]}
//        (ByteSizedMarius/aldiscount pkg/search.go, api.aldi-sued.de, Aug 2026; nicktcode/swissgroceries-mcp
//        scripts/capture-aldi-fixtures.sh, api.aldi-suisse.ch, Jun 2026).
//  - limit must be one of 12, 16, 24, 30, 32, 48, 60 — anything else is rejected with code 3731 (aldiscount util.go).
//  - sort: relevance | name_asc | name_desc | price_asc | price_desc (aldiscount).
//  - GET /v2/products?skus=a,b,…&limit=60 (batch by SKU; aldiscount catalog.go) and GET /v2/products/{sku}
//    (swissgroceries-mcp) → {data: product | [product]}.
//  - GET /v2/service-points?offset=0&limit=60 → {data: [{id, name, address…}]} (aldiscount); a servicePoint is required
//    by some endpoints (code 3801 without one). Errors come as {"errors":[{code, message}]}, sometimes with HTTP 200.
//  - Plain HTTP works on DE and CH without cookies or a browser. aldiscount notes that overriding the User-Agent got
//    requests rejected on DE, so the client can fall back from browser-like headers to minimal API headers.
// Verified on www.aldi.com.au (2026-09-27): category pages /products/{slug…}/k/{categoryKey}
// (e.g. /products/dairy-eggs-fridge/k/960000000), Special Buys pages /special-buys/YYYY-MM-DD (Wednesdays and
// Saturdays), "Lower Prices" /products/lower-prices/k/1588161425841179, "Super Savers"
// /products/super-savers/k/1588161426952145, product pages /product/{slug}-{18-digit sku}.
// ASSUMED (not seen in code for AU): the host api.aldi.com.au with currency=AUD (same pattern as api.aldi-sued.de,
// api.aldi-suisse.ch, api.aldi.us); that a Special Buys date maps to promotionKey=YYYY-MM-DD like the dated offer
// pages of aldi-sued.de (/angebote/YYYY-MM-DD ↔ promotionKey).
import { log } from 'apify';
import { StoreClient, RequestError } from './client.js';
import { SITE_URL, API_URL, padSku } from './normalize.js';

export const ALLOWED_LIMITS = [12, 16, 24, 30, 32, 48, 60];
export const MAX_LIMIT = 60;
export const SORTS = ['relevance', 'name_asc', 'name_desc', 'price_asc', 'price_desc'];

// From the www.aldi.com.au navigation (2026-09-27); resolved from the live category tree first when possible.
export const SPECIAL_CATEGORIES = {
    'lower-prices': { key: '1588161425841179', name: 'Lower Prices' },
    'super-savers': { key: '1588161426952145', name: 'Super Savers' },
};

/** Smallest accepted page size that covers `want` products (fewer products transferred for small requests). */
export function pageLimit(want) {
    return ALLOWED_LIMITS.find((l) => l >= want) ?? MAX_LIMIT;
}

/** Special Buys drop days (Wednesday, Saturday) around `now`, in Australian time: the last `back` and next `ahead`. */
export function specialBuysDates(now = new Date(), { back = 2, ahead = 2 } = {}) {
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const today = new Date(`${ymd}T00:00:00Z`);
    const isDrop = (d) => d.getUTCDay() === 3 || d.getUTCDay() === 6;
    const past = [];
    const future = [];
    for (let i = 0; past.length < back && i < 14; i++) {
        const d = new Date(today.getTime() - i * 86_400_000);
        if (isDrop(d)) past.push(d);
    }
    for (let i = 1; future.length < ahead && i < 14; i++) {
        const d = new Date(today.getTime() + i * 86_400_000);
        if (isDrop(d)) future.push(d);
    }
    return [...past.reverse(), ...future].map((d) => d.toISOString().slice(0, 10));
}

export class AldiClient extends StoreClient {
    constructor({ apiUrl, siteUrl, servicePoint = null, sort = 'relevance', ...opts }) {
        super({
            ...opts, store: 'aldi', label: 'ALDI', siteUrl: siteUrl ?? SITE_URL, apiUrl: apiUrl ?? API_URL,
            httpProfiles: ['browser', 'plain'], locale: 'en-AU', timezoneId: 'Australia/Sydney',
        });
        this.servicePoint = servicePoint;
        this.servicePointSource = servicePoint ? 'input' : null;
        this.sort = sort;
        this.tree = null;
    }

    headers() {
        return { accept: 'application/json, text/plain, */*', origin: this.siteUrl, referer: `${this.siteUrl}/` };
    }

    query(params) {
        const qs = new URLSearchParams();
        qs.set('serviceType', 'walk-in');
        if (this.servicePoint) qs.set('servicePoint', this.servicePoint);
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
        return qs.toString();
    }

    /** GET an API path; the query is rebuilt per attempt so a service point found meanwhile is used. */
    async get(step, path, params, opts = {}) {
        const data = await this.requestJson({ step, url: () => `${this.apiUrl}${path}?${this.query(params)}`, headers: () => this.headers(), ...opts });
        // The API reports some failures with HTTP 200 and an {"errors": [...]} body.
        if (data && !data.notFound && Array.isArray(data.errors) && data.errors.length && !data.data) {
            const e = data.errors[0];
            throw new RequestError(`${step}: ALDI API error [${e.code ?? '?'}] ${e.message ?? ''}`.trim(), { step, apiCode: e.code ?? null });
        }
        return data;
    }

    /** Picks a store (servicePoint) once: from input, else the store the aldi.com.au website itself uses (G452). Never throws. */
    async ensureServicePoint() {
        if (this.servicePointSource) return this.servicePoint;
        this.servicePointSource = 'none';
        try {
            // Verified 2026-09-27: the website queries servicePoint=G452; many other listed stores return 0 results.
            this.servicePoint = 'G452';
            this.servicePointSource = 'website-default';
            log.info(`${this.tag()} Using store G452 (the default store of aldi.com.au). Prices are national; set "storeId" to choose another.`);
        } catch (err) {
            if (err.blocked) {
                // Blocked even on this small request: the listing would be blocked too — report it on the task.
                this.servicePointSource = null;
                throw err;
            }
            log.warning(`${this.tag()} Could not list stores (${err.message}); continuing without a store id.`);
        }
        return this.servicePoint;
    }

    async categoryTree() {
        if (this.tree) return this.tree;
        await this.ensureServicePoint();
        const data = await this.get('category tree', '/v2/product-category-tree', {});
        this.tree = Array.isArray(data?.data) ? data.data : [];
        return this.tree;
    }

    /** Finds the key of a category by its URL slug (e.g. "super-savers") in the live tree; null if not found. */
    async categoryKeyForSlug(slug) {
        let tree;
        try {
            tree = await this.categoryTree();
        } catch (err) {
            log.info(`${this.tag()} Category tree not available (${err.message}); using the known key for "${slug}".`);
            return null;
        }
        const stack = [...tree];
        while (stack.length) {
            const n = stack.shift();
            if (n?.urlSlugText === slug || String(n?.urlSlugText ?? '').split('/').pop() === slug) return String(n.key);
            if (Array.isArray(n?.children)) stack.push(...n.children);
        }
        return null;
    }

    /**
     * Walks a listing. kind: { type: 'search', term } | { type: 'category', key, slug } | { type: 'specialBuys', date }
     * Yields { items, page, total } per page.
     */
    async* listing(kind, { maxPages = 30, maxItems = 100 } = {}) {
        await this.ensureServicePoint();
        const filter = kind.type === 'search' ? { q: kind.term }
            : kind.type === 'category' ? { categoryKey: kind.key }
                : { promotionKey: kind.date };
        const label = kind.type === 'search' ? `search "${kind.term}"` : kind.type === 'category' ? `category ${kind.slug ?? kind.key}` : `Special Buys ${kind.date}`;
        const limit = pageLimit(maxItems);
        let offset = 0;
        let total = null;
        for (let page = 1; page <= maxPages; page++) {
            const step = `${label} page ${page}`;
            const data = await this.get(step, '/v3/product-search', { currency: 'AUD', ...filter, sort: this.sort, limit, offset });
            if (!data || typeof data !== 'object' || !Array.isArray(data.data)) {
                const keys = Object.keys(data ?? {}).slice(0, 12).join(', ');
                throw new RequestError(`${step}: unexpected response shape — no "data" array (keys: ${keys || 'none'}). ALDI may have changed its API.`, { step });
            }
            if (page === 1) total = Number(data.meta?.pagination?.totalCount ?? data.data.length);
            const items = data.data;
            yield { items, page, total };
            offset += items.length;
            if (!items.length || (total !== null && offset >= total)) return;
        }
    }

    /** Looks up products by SKU (batch endpoint, then one by one). Returns Map sku → product. */
    async products(skus) {
        await this.ensureServicePoint();
        const out = new Map();
        const want = [...new Set(skus.map(padSku))];
        for (let i = 0; i < want.length; i += MAX_LIMIT) {
            const batch = want.slice(i, i + MAX_LIMIT);
            let list = null;
            try {
                const data = await this.get(`products ${batch.length === 1 ? batch[0] : `${i + 1}-${i + batch.length}`}`, '/v2/products',
                    { skus: batch.join(','), limit: MAX_LIMIT }, { allowNotFound: true });
                list = data?.notFound ? [] : Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
            } catch (err) {
                if (err.blocked) throw err;
                log.info(`${this.tag()} Batch product lookup failed (${err.message}); looking products up one by one.`);
            }
            for (const p of list ?? []) if (p?.sku) out.set(padSku(p.sku), p);
            const missing = batch.filter((s) => !out.has(s));
            if (list !== null && list.length && !missing.length) continue;
            for (const sku of missing) {
                const data = await this.get(`product ${sku}`, `/v2/products/${sku}`, {}, { allowNotFound: true });
                const p = data?.notFound ? null : Array.isArray(data?.data) ? data.data[0] : data?.data ?? null;
                if (p?.sku) out.set(padSku(p.sku), p);
            }
        }
        return out;
    }
}

/**
 * Parses an ALDI AU listing URL:
 *  /products/dairy-eggs-fridge/k/960000000 → { type: 'category', key, slug }
 *  /special-buys/2026-09-30               → { type: 'specialBuys', date }
 */
export function aldiListingFromUrl(u) {
    const url = new URL(u);
    const k = url.pathname.match(/^\/(?:en\/)?products\/(.+?)\/k\/(\d+)\/?$/i);
    if (k) return { type: 'category', key: k[2], slug: k[1].toLowerCase() };
    const sb = url.pathname.match(/^\/(?:en\/)?special-buys\/(\d{4}-\d{2}-\d{2})\/?$/i);
    if (sb) return { type: 'specialBuys', date: sb[1] };
    return null;
}

/** https://www.aldi.com.au/product/lodge-farms-cage-eggs-700g-000000000000399451 → '000000000000399451' */
export function aldiSkuFromUrl(u) {
    const url = new URL(u);
    const m = url.pathname.match(/^\/(?:en\/)?product\/(?:.*-)?(\d{6,18})\/?$/i);
    return m ? padSku(m[1]) : null;
}
