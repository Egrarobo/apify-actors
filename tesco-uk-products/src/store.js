// Tesco UK — the grocery catalogue is served by a GraphQL API at https://xapi.tesco.com/ (Tesco's "mango" backend).
//
// Verified from open-source code:
//  - POST https://xapi.tesco.com/ with a JSON ARRAY of operations [{operationName, variables, extensions: {mfeName},
//    query}] → JSON array of {data, errors?} in the same order (basketeer src/graphql.ts, UK, July 2026;
//    open-supermarkets src/providers/tesco/api.ts + tesco-hu/api.ts, Mar–Sep 2026).
//  - Headers: x-apikey (public key "baked into Tesco's web JS", page config `mangoApiKey`), region: UK,
//    language: en-GB, accept-language: en-GB, traceid, trkid (basketeer). Key TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA is
//    used by both repos from March to September 2026; basketeer says it "rotates roughly monthly" and a wrong key
//    answers HTTP 403 "Invalid Client".
//  - ANONYMOUS reads need only the key — no cookies, no browser: search(query, page, count), category(facet, page,
//    count), product(tpnc), taxonomy (basketeer README "Anonymous reads (search, product, browse, nutrition) need
//    only the public x-apikey"; open-supermarkets: "Unlike the storefront, xapi answers plain HTTP clients — no
//    Akamai challenge", verified live 2026-09-17). The website www.tesco.com itself is Akamai-protected.
//  - Category facet = "b;" + base64(department name), or lifted from a category page URL's `facet` parameter
//    (basketeer operations.ts categoryFacet()).
//  - search/category return { info { total page count pageSize offset }, results [{ node }] } (open-supermarkets,
//    tesco-hu; used in the "full" field set only).
// ASSUMED: count up to 48 per page; that taxonomy child `id`s are usable as facets; that UK product nodes accept the
// HU-verified fields gtin / superDepartmentName / departmentName / aisleName / shelfName — if the API rejects them
// ("Cannot query field"), the client drops to basketeer's exact field set and says so in the log.
import { randomUUID } from 'node:crypto';
import { log } from 'apify';
import { StoreClient, RequestError } from './client.js';
import { HttpTransport } from './http.js';
import { BrowserSession } from './browser.js';
import { findBlockMarkers } from './blocks.js';
import { SITE_URL, API_URL } from './normalize.js';

export const PUBLIC_API_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';
export const PAGE_SIZE = 48;
const PRODUCT_BATCH = 10;

const PROMO_FIELDS = 'promotions { description startDate endDate attributes price { afterDiscount beforeDiscount } }';
const BASE_NODE = 'tpnc tpnb title brandName defaultImageUrl isForSale productType averageWeight bulkBuyLimit';
const EXTRA_NODE = 'gtin superDepartmentName departmentName aisleName shelfName';

export function listingQuery(kind, full) {
    const node = `${BASE_NODE}${full ? ` ${EXTRA_NODE}` : ''}
          sellers { results { price { actual unitPrice unitOfMeasure } ${PROMO_FIELDS} } }`;
    const info = full ? 'info { total page count pageSize offset }' : '';
    if (kind === 'search') {
        return `query Search($query: String!, $page: Int = 1, $count: Int) {
  search(query: $query, page: $page, count: $count) {
    ${info}
    results { node { __typename ... on ProductInterface { ${node} } } }
  }
}`;
    }
    return `query GetCategoryProducts($facet: ID, $page: Int = 1, $count: Int) {
  category(facet: $facet, page: $page, count: $count) {
    ${info}
    results { node { __typename ... on ProductInterface { ${node} } } }
  }
}`;
}

/** One aliased operation for several products, so a set of products costs one HTTP request (basketeer). */
export function productsQuery(count, full) {
    const fields = `${BASE_NODE}${full ? ` ${EXTRA_NODE}` : ''} price { actual unitPrice unitOfMeasure } ${PROMO_FIELDS} details { packSize { value units } }`;
    const vars = Array.from({ length: count }, (_, i) => `$tpnc${i}: String!`).join(', ');
    const body = Array.from({ length: count }, (_, i) => `p${i}: product(tpnc: $tpnc${i}) { ${fields} }`).join('\n  ');
    return `query GetProducts(${vars}) {\n  ${body}\n}`;
}

export const TAXONOMY_QUERY = `query Taxonomy($includeChildren: Boolean = true) {
  taxonomy(includeInspirationEvents: false) {
    name
    label
    children @include(if: $includeChildren) { id name label children { id name label } }
  }
}`;

export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const facetFor = (name) => `b;${Buffer.from(String(name), 'utf8').toString('base64')}`;

/** Resolves slug parts (["fresh-food", "milk-butter-and-eggs"]) to { facet, name, path } via the taxonomy tree. */
export function facetForSlugs(tree, parts) {
    let nodes = Array.isArray(tree) ? tree : [];
    let match = null;
    const names = [];
    for (const part of parts) {
        match = nodes.find((n) => [n?.name, n?.label].some((x) => x && slugify(x) === part)) ?? null;
        if (!match) return null;
        names.push(match.name ?? match.label);
        nodes = Array.isArray(match.children) ? match.children : [];
    }
    if (!match) return null;
    const id = match.id ? String(match.id) : null;
    return { facet: id && id.startsWith('b;') ? id : facetFor(match.name ?? match.label), name: names.join(' > '), id };
}

const gqlErrors = (r) => (Array.isArray(r?.errors) ? r.errors : []).map((e) => String(e?.message ?? e)).filter(Boolean);
const isSchemaError = (msgs) => msgs.some((m) => /cannot query field|unknown field|unknown argument/i.test(m));

export class TescoClient extends StoreClient {
    constructor({ apiUrl, siteUrl, apiKey = null, ...opts }) {
        super({ ...opts, store: 'tesco', label: 'Tesco', siteUrl: siteUrl ?? SITE_URL, apiUrl: apiUrl ?? API_URL, httpProfiles: ['browser'], locale: 'en-GB', timezoneId: 'Europe/London' });
        this.apiKey = apiKey || PUBLIC_API_KEY;
        this.keySource = apiKey ? 'input' : 'built-in';
        this.keyRefreshed = false;
        this.full = true;
        this.tree = null;
    }

    headers() {
        return {
            accept: 'application/json',
            'content-type': 'application/json',
            'accept-language': 'en-GB',
            'x-apikey': this.apiKey,
            region: 'UK',
            language: 'en-GB',
            traceid: `${randomUUID()}:${randomUUID()}`,
            trkid: randomUUID(),
            origin: this.siteUrl,
            referer: `${this.siteUrl}/shop/en-GB/`,
        };
    }

    /**
     * Runs one GraphQL operation (as a one-element batch). Returns `data`. Partial errors (e.g. one unknown product in
     * an aliased batch) are tolerated when data came back. Schema errors in the "full" field set switch to the basic set.
     */
    async gql(step, operationName, queryFn, variables, mfeName) {
        for (let pass = 0; pass < 2; pass++) {
            let res;
            try {
                res = await this.requestJson({
                    step, method: 'POST', url: `${this.apiUrl}/`, headers: () => this.headers(),
                    body: () => [{ operationName, variables, extensions: { mfeName }, query: queryFn(this.full) }],
                });
            } catch (err) {
                // Apollo answers query validation errors with HTTP 400.
                if (this.full && err.status === 400 && isSchemaError([err.message])) {
                    this.useBasicFields(step, err.message);
                    continue;
                }
                throw err;
            }
            const first = Array.isArray(res) ? res[0] : res;
            const msgs = gqlErrors(first);
            if (msgs.length && !first?.data) {
                if (this.full && isSchemaError(msgs)) {
                    this.useBasicFields(step, msgs[0]);
                    continue;
                }
                const unauth = msgs.some((m) => /unauthori[sz]ed|401/i.test(m));
                throw new RequestError(`${step}: Tesco API error: ${msgs.slice(0, 2).join('; ').slice(0, 300)}${unauth ? ' (anonymous access refused)' : ''}`, { step });
            }
            if (!first || typeof first !== 'object' || !('data' in first)) {
                const keys = Object.keys(first ?? {}).slice(0, 12).join(', ');
                throw new RequestError(`${step}: unexpected response shape — no "data" (keys: ${keys || 'none'}). Tesco may have changed its API.`, { step });
            }
            return first.data ?? {};
        }
        throw new RequestError(`${step}: the Tesco API rejected the query twice.`, { step });
    }

    useBasicFields(step, why) {
        this.full = false;
        this.stats.fieldSet = 'basic';
        log.warning(`${this.tag(step)} The API does not accept the extended fields (${String(why).slice(0, 160)}); continuing with the basic field set (no category names / GTIN / result totals).`);
    }

    /** Called on HTTP 403 "Invalid Client": reads the current public key (`mangoApiKey`) from the website. */
    async onApiKeyRejected() {
        if (this.keyRefreshed) return false;
        this.keyRefreshed = true;
        const pattern = /["']?mangoApiKey["']?\s*[:=]\s*["']([A-Za-z0-9_-]{16,64})["']/;
        const pages = ['/groceries/en-GB/', '/shop/en-GB/'];
        const tryHtml = (html, how) => {
            const key = String(html ?? '').match(pattern)?.[1] ?? null;
            if (key && key !== this.apiKey) {
                log.info(`${this.tag()} Found a new public API key on the website (${how}): ${key.slice(0, 4)}…${key.slice(-4)}. Retrying.`);
                this.apiKey = key;
                this.keySource = `website (${how})`;
                this.stats.apiKeySource = this.keySource;
                return true;
            }
            return false;
        };
        log.warning(`${this.tag()} The API key (${this.keySource}) was rejected; looking for the current key on the website…`);
        try {
            const t = new HttpTransport({ proxyUrl: await this.newProxyUrl(), locale: this.locale });
            for (const p of pages) {
                const res = await t.request({ url: `${this.siteUrl}${p}`, headers: { accept: 'text/html,application/xhtml+xml' } });
                this.stats.requests++;
                if (tryHtml(res.text, 'plain HTTP')) return true;
                const markers = findBlockMarkers(res.text);
                log.info(`${this.tag()} ${p} answered HTTP ${res.status}${markers.length ? ` (${markers.join(', ')})` : ''} without a key.`);
            }
        } catch (err) {
            log.info(`${this.tag()} Loading the website failed: ${err.message}`);
        }
        if (this.browserFallback) {
            const b = new BrowserSession({ store: this.store, label: this.label, baseUrl: this.siteUrl, proxyUrl: await this.newProxyUrl(), locale: this.locale, timezoneId: this.timezoneId });
            try {
                this.stats.browserLaunches++;
                await b.open();
                for (const p of pages) {
                    const w = await b.warmup(p);
                    if (tryHtml(w.html, 'browser')) return true;
                }
            } catch (err) {
                log.info(`${this.tag()} Browser could not read the key: ${err.message}`);
            } finally {
                await b.close();
            }
        }
        log.error(`${this.tag()} No new API key found. Set "apiKey" in the input (from DevTools → Network → xapi.tesco.com → request header x-apikey).`);
        return false;
    }

    async taxonomy() {
        if (this.tree) return this.tree;
        const data = await this.gql('category tree', 'Taxonomy', () => TAXONOMY_QUERY, { includeChildren: true }, 'mfe-plp');
        this.tree = Array.isArray(data?.taxonomy) ? data.taxonomy : [];
        return this.tree;
    }

    /** Resolves a category input { facet } | { slugs } to { facet, name }. */
    async resolveCategory(kind) {
        if (kind.facet) return { facet: kind.facet, name: kind.facet };
        const tree = await this.taxonomy();
        const hit = facetForSlugs(tree, kind.slugs);
        if (!hit) {
            const top = tree.map((n) => slugify(n.name ?? n.label)).filter(Boolean).slice(0, 30).join(', ');
            throw Object.assign(new Error(`category "${kind.slugs.join('/')}" was not found in the Tesco category tree. Top-level categories: ${top || 'none'}`), { step: 'category lookup' });
        }
        return hit;
    }

    /** Top-level departments (for "all offers"). */
    async departments() {
        const tree = await this.taxonomy();
        return tree.filter((n) => n?.name || n?.label).map((n) => ({ facet: facetFor(n.name ?? n.label), name: n.name ?? n.label, slug: slugify(n.name ?? n.label) }));
    }

    /**
     * Walks a listing. kind: { type: 'search', term } | { type: 'category', facet?, slugs? }
     * Yields { items (product nodes), page, total }.
     */
    async* listing(kind, { maxPages = 30, maxItems = 100 } = {}) {
        const count = Math.min(PAGE_SIZE, Math.max(1, maxItems));
        let cat = null;
        if (kind.type === 'category') cat = kind.resolved ?? await this.resolveCategory(kind);
        const label = kind.type === 'search' ? `search "${kind.term}"` : `category ${cat.name}`;
        const seen = new Set();
        let total = null;
        for (let page = 1; page <= maxPages; page++) {
            const step = `${label} page ${page}`;
            const data = kind.type === 'search'
                ? await this.gql(step, 'Search', (full) => listingQuery('search', full), { query: kind.term, page, count }, 'mfe-plp')
                : await this.gql(step, 'GetCategoryProducts', (full) => listingQuery('category', full), { facet: cat.facet, page, count }, 'mfe-plp');
            const block = kind.type === 'search' ? data?.search : data?.category;
            if (block === undefined || (block !== null && !Array.isArray(block.results))) {
                const keys = Object.keys(block ?? data ?? {}).slice(0, 12).join(', ');
                throw new RequestError(`${step}: unexpected response shape — no results (keys: ${keys || 'none'}). Tesco may have changed its API.`, { step });
            }
            const nodes = (block?.results ?? []).map((r) => r?.node).filter((n) => n && n.tpnc !== undefined && n.tpnc !== null);
            if (page === 1) {
                const t = num(block?.info?.total);
                total = t;
            }
            const fresh = nodes.filter((n) => !seen.has(String(n.tpnc)));
            for (const n of fresh) seen.add(String(n.tpnc));
            yield { items: fresh, page, total };
            // Stop on an empty page, a page with nothing new (API ignoring `page`), or when the total is reached.
            if (!nodes.length || !fresh.length || (total !== null && seen.size >= total)) return;
        }
    }

    /** Looks up products by tpnc, PRODUCT_BATCH per request. Returns Map tpnc → node. */
    async products(ids) {
        const out = new Map();
        const want = [...new Set(ids.map(String))];
        for (let i = 0; i < want.length; i += PRODUCT_BATCH) {
            const batch = want.slice(i, i + PRODUCT_BATCH);
            const fetchSet = async (set) => {
                const variables = Object.fromEntries(set.map((id, j) => [`tpnc${j}`, id]));
                const data = await this.gql(`products ${set.length === 1 ? set[0] : `${i + 1}-${i + set.length}`}`, 'GetProducts',
                    (full) => productsQuery(set.length, full), variables, 'mfe-pdp');
                set.forEach((id, j) => {
                    const node = data?.[`p${j}`];
                    if (node && (node.tpnc ?? node.title)) out.set(id, { ...node, tpnc: String(node.tpnc ?? id) });
                });
            };
            try {
                await fetchSet(batch);
            } catch (err) {
                if (err.blocked || err.apiKeyRejected || batch.length === 1) {
                    if (batch.length === 1 && !err.blocked && !err.apiKeyRejected && /not.?found/i.test(err.message)) continue;
                    throw err;
                }
                // One bad id can fail the whole aliased query: look the batch up one by one.
                log.info(`${this.tag()} Batch product lookup failed (${err.message}); looking products up one by one.`);
                for (const id of batch) {
                    try {
                        await fetchSet([id]);
                    } catch (e) {
                        if (e.blocked || e.apiKeyRejected) throw e;
                        log.info(`${this.tag()} product ${id}: ${e.message}`);
                    }
                }
            }
        }
        return out;
    }
}

function num(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

/**
 * Tesco listing URLs:
 *  https://www.tesco.com/shop/en-GB/browse/fresh-food/all            → { slugs: ['fresh-food'] }
 *  https://www.tesco.com/groceries/en-GB/shop/fresh-food/milk-butter-and-eggs/milk → { slugs: [...3] }
 *  https://www.tesco.com/shop/en-GB/category/bakery                  → { slugs: ['bakery'] }
 *  any of these with ?facet=b;…                                        → { facet }
 */
export function tescoCategoryFromUrl(u) {
    const url = new URL(u);
    const facet = url.searchParams.get('facet');
    if (facet) return { type: 'category', facet };
    const m = url.pathname.match(/^\/(?:shop\/en-GB\/(?:browse|category)|groceries\/en-GB\/shop)\/(.+?)\/?$/i);
    if (!m) return null;
    const slugs = m[1].toLowerCase().split('/').filter(Boolean);
    if (slugs.at(-1) === 'all') slugs.pop();
    return slugs.length ? { type: 'category', slugs } : null;
}

/** https://www.tesco.com/shop/en-GB/products/321525706 or /groceries/en-GB/products/254656543 → tpnc */
export function tescoProductFromUrl(u) {
    const url = new URL(u);
    return url.pathname.match(/^\/(?:shop|groceries)\/en-GB\/products\/(\d{5,12})\/?$/i)?.[1] ?? null;
}
