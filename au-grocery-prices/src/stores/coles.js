// Coles (www.coles.com.au) — Next.js site behind Imperva (Incapsula + reese84).
//
// Verified from open-source code:
//  - buildId from the homepage's <script id="__NEXT_DATA__"> (Javex/hotprices-au coles.py start()).
//  - Category pages: GET /_next/data/{buildId}/en/browse/{slug}.json?slug={slug}&page={n}
//    → pageProps.searchResults {noOfResults, pageSize, results[]} (hotprices-au get_category / get_category_page).
//  - Search: GET /_next/data/{buildId}/en/search/products.json?q={term} (diabolical-ninja/coles-mcp, Sep 2025).
//  - Product page: GET /_next/data/{buildId}/en/product/{slug}.json?slug={slug} → pageProps.product (coles-mcp).
//  - BFF key: window.__RUNTIME_CONFIG__.BFF_API_SUBSCRIPTION_KEY (hotprices-au, Aug 2026; earlier in
//    __NEXT_DATA__.runtimeConfig), sent as `ocp-apim-subscription-key`.
//  - Anti-bot: open the homepage in a browser (camoufox in hotprices-au, selenium in coles-scraper), then call the
//    JSON routes with the browser's cookies (coles-scraper) or through the browser context (hotprices-au).
// Assumed (not seen in code): `page` parameter on search, /on-special listing, multi-level browse slugs,
// product lookup by bare id, the `x-nextjs-data: 1` header (standard Next.js client behaviour).
import { StoreClient, RequestError } from '../client.js';
import { BlockedError } from '../blocks.js';
import { normalizeColes, isColesAdTile, COLES_BASE_URL, slugify } from '../normalize.js';

export function parseColesHome(html) {
    const m = String(html ?? '').match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new BlockedError('the homepage has no __NEXT_DATA__ (not the real Coles site — likely an anti-bot page)', { html });
    let data;
    try {
        data = JSON.parse(m[1]);
    } catch {
        throw new Error('the homepage __NEXT_DATA__ is not valid JSON');
    }
    if (!data.buildId) throw new Error('the homepage __NEXT_DATA__ has no buildId');
    let apiKey = data.runtimeConfig?.BFF_API_SUBSCRIPTION_KEY ?? null;
    if (!apiKey) {
        const rc = String(html).match(/window\.__RUNTIME_CONFIG__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
        if (rc) {
            try {
                apiKey = JSON.parse(rc[1]).BFF_API_SUBSCRIPTION_KEY ?? null;
            } catch { /* optional */ }
        }
    }
    const storeId = data.props?.pageProps?.initialState?.trolley?.storeId ?? null;
    return { buildId: data.buildId, apiKey, storeId };
}

export class ColesClient extends StoreClient {
    constructor(opts) {
        super({ ...opts, store: 'coles', label: 'Coles', baseUrl: opts.baseUrl ?? COLES_BASE_URL, readySelector: 'script#__NEXT_DATA__' });
    }

    parseHome(html) {
        return parseColesHome(html);
    }

    describeHome() {
        return ` buildId=${this.home?.buildId}${this.home?.storeId ? `, storeId=${this.home.storeId}` : ''}, API key ${this.home?.apiKey ? 'found' : 'not found (not needed for these routes)'}.`;
    }

    dataUrl(path, params) {
        const qs = new URLSearchParams();
        for (const [k, v] of params) qs.append(k, String(v));
        const q = qs.toString();
        return `${this.baseUrl}/_next/data/${this.home.buildId}/en${path}.json${q ? `?${q}` : ''}`;
    }

    /** GET a _next/data route. Handles a stale buildId (HTTP 404 after a Coles deployment) and Next.js redirects. */
    async nextData(step, path, params, { allowNotFound = false } = {}) {
        let refreshed = false;
        for (let hop = 0; hop < 4; hop++) {
            await this.ensureSession(step);
            const p = path;
            const q = params;
            const url = () => this.dataUrl(p, q);
            const headers = () => {
                const h = { accept: '*/*', 'x-nextjs-data': '1', referer: `${this.baseUrl}${p}` };
                if (this.home?.apiKey) h['ocp-apim-subscription-key'] = this.home.apiKey;
                return h;
            };
            const data = await this.requestJson({ step, url, headers, allowNotFound: true });
            if (data?.notFound) {
                if (!refreshed) {
                    refreshed = true;
                    const old = this.home.buildId;
                    await this.startSession('a data route answered 404 (Coles may have deployed a new build)').catch(() => {});
                    if (this.home?.buildId && this.home.buildId !== old) continue;
                }
                if (allowNotFound) return null;
                throw new RequestError(`${step}: HTTP 404 for ${path} (buildId ${this.home?.buildId})`, { status: 404, step });
            }
            const redirect = data?.pageProps?.__N_REDIRECT;
            if (redirect) {
                const u = new URL(redirect, this.baseUrl);
                path = u.pathname.replace(/\/+$/, '');
                params = [...u.searchParams.entries()];
                const slug = path.match(/^\/product\/([^/]+)$/)?.[1];
                if (slug && !params.some(([k]) => k === 'slug')) params.push(['slug', slug]);
                continue;
            }
            return data;
        }
        throw new RequestError(`${step}: too many redirects for ${path}`, { step });
    }

    static searchResultsOf(data, step) {
        const sr = data?.pageProps?.searchResults;
        if (!sr || !Array.isArray(sr.results)) {
            const keys = Object.keys(data?.pageProps ?? data ?? {}).slice(0, 12).join(', ');
            throw new RequestError(`${step}: unexpected response shape — no pageProps.searchResults (keys: ${keys || 'none'}). Coles may have changed its site.`, { step });
        }
        return sr;
    }

    /**
     * Walks a listing (search, category or specials). Yields { items, page, total } per page.
     * `kind`: { type: 'search', term } | { type: 'category', slugParts } | { type: 'specials' }
     */
    async* listing(kind, { maxPages = 30 } = {}) {
        let seenRaw = 0;
        for (let page = 1; page <= maxPages; page++) {
            let path;
            const params = [];
            if (kind.type === 'search') {
                path = '/search/products';
                params.push(['q', kind.term]);
            } else if (kind.type === 'category') {
                path = `/browse/${kind.slugParts.join('/')}`;
                for (const s of kind.slugParts) params.push(['slug', s]);
            } else {
                path = '/on-special';
            }
            if (page > 1) params.push(['page', page]);
            const step = `${kind.type === 'search' ? `search "${kind.term}"` : kind.type === 'category' ? `category ${kind.slugParts.join('/')}` : 'specials'} page ${page}`;
            const data = await this.nextData(step, path, params);
            const sr = ColesClient.searchResultsOf(data, step);
            const items = sr.results.filter((r) => !isColesAdTile(r));
            seenRaw += sr.results.length;
            const total = Number(sr.noOfResults) || 0;
            yield { items, page, total, rawCount: sr.results.length };
            const pageSize = Number(sr.pageSize) || 48;
            if (!sr.results.length || page * pageSize >= total || seenRaw >= total + 200) return;
        }
    }

    /** Product by URL slug or id. Returns the raw product object, or null when not found. */
    async product({ slug, id }) {
        const s = slug ?? String(id);
        const data = await this.nextData(`product ${s}`, `/product/${s}`, [['slug', s]], { allowNotFound: true });
        const p = data?.pageProps?.product;
        if (p && p.id !== undefined) return p;
        if (!slug && id) {
            // Assumed fallback for a bare id: search the id and keep the exact match.
            for await (const { items } of this.listing({ type: 'search', term: String(id) }, { maxPages: 1 })) {
                const hit = items.find((r) => String(r.id) === String(id));
                if (hit) return hit;
            }
        }
        return null;
    }
}

export const colesNormalize = normalizeColes;

/** Parses a Coles category URL (https://www.coles.com.au/browse/dairy-eggs-fridge/cheese) into slug parts. */
export function colesCategoryFromUrl(u) {
    const url = new URL(u);
    const m = url.pathname.match(/^\/(browse|on-special)(?:\/(.+?))?\/?$/i);
    if (!m) return null;
    if (m[1].toLowerCase() === 'on-special' && !m[2]) return { type: 'specials' };
    if (!m[2]) return null;
    return { type: 'category', slugParts: m[2].split('/').filter(Boolean).map((s) => s.toLowerCase()) };
}

/** Parses a Coles product URL (…/product/coles-full-cream-milk-2l-8150288) → { slug, id }. */
export function colesProductFromUrl(u) {
    const url = new URL(u);
    const m = url.pathname.match(/^\/product\/([^/?#]+)/i);
    if (!m) return null;
    const slug = m[1].toLowerCase();
    return { slug, id: slug.match(/(\d+)$/)?.[1] ?? null };
}

export { slugify };
