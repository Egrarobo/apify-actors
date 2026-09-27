// Local mock of the Coles (Next.js data routes) and Woolworths (/apis/ui) endpoints, serving product objects taken
// from real captures (see fixtures/build-fixtures.mjs). Includes switchable anti-bot behaviour:
//   Coles: Imperva "Pardon Our Interruption" HTML (HTTP 200) when cookies are missing or on demand; stale buildId → 404.
//   Woolworths: Akamai "Access Denied" (HTTP 403) when cookies are missing or on demand; sponsored-only pages past the end.
// Usage: const srv = await startMockServer(); srv.colesUrl; srv.woolUrl; srv.state.coles.blockData = 2; await srv.close();
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

export const IMPERVA_PAGE = '<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"><title>Pardon Our Interruption</title>'
    + '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script></head><body>Request unsuccessful. Incapsula incident ID: 1234-5678</body></html>';
export const AKAMAI_PAGE = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don&#39;t have permission to access '
    + '"http&#58;&#47;&#47;www&#46;woolworths&#46;com&#46;au&#47;apis&#47;ui&#47;Search&#47;products" on this server.<P>\nReference&#32;&#35;18&#46;abc\n'
    + '<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;abc</P>\n</BODY>\n</HTML>\n';

const cookiesOf = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), c.slice(i + 1)];
}));

function buildColesCatalogue(size) {
    const base = fx('coles.json');
    const out = [];
    for (let i = 0; out.length < size; i++) {
        const src = base.products[i % base.products.length];
        const p = structuredClone(src);
        if (i >= base.products.length) {
            p.id = Number(`9${String(i).padStart(6, '0')}`);
            p.adId = null; // clones are organic
        }
        out.push(p);
    }
    return { base, products: out };
}

function buildWoolCatalogue(size) {
    const base = fx('woolworths.json');
    const organic = base.products.filter((p) => !p.IsSponsoredAd);
    const sponsored = base.products.filter((p) => p.IsSponsoredAd);
    const out = [];
    for (let i = 0; out.length < size; i++) {
        const p = structuredClone(organic[i % organic.length]);
        if (i >= organic.length) p.Stockcode = 800000 + i;
        out.push(p);
    }
    return { base, products: out, sponsored };
}

export async function startMockServer({ colesSize = 100, colesPageSize = 48, woolSize = 50 } = {}) {
    const coles = buildColesCatalogue(colesSize);
    const wool = buildWoolCatalogue(woolSize);
    const state = {
        coles: { buildId: 'test-build-1', blockData: 0, blockHome: 0, requireJsCookie: false, alwaysBlock: false, requests: [], homeLoads: 0, rotateBuildAfter: 0, dataCount: 0 },
        woolworths: { blockApi: 0, blockHome: 0, requireJsCookie: false, alwaysBlock: false, fail500: 0, requests: [], homeLoads: 0 },
    };

    const send = (res, code, body, headers = {}) => {
        const isStr = typeof body === 'string';
        res.writeHead(code, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
        res.end(isStr ? body : JSON.stringify(body));
    };

    const matchesTerm = (text, term) => {
        const t = term.toLowerCase();
        if (t === 'nothing') return false;
        if (t === 'milk' || t === 'bread' || t === '*') return true;
        return String(text).toLowerCase().includes(t);
    };

    // ── Coles ──────────────────────────────────────────────────────────────────────
    const colesHome = () => {
        const nd = { props: { pageProps: { initialState: { trolley: { storeId: '0584' } } } }, page: '/', query: {}, buildId: state.coles.buildId, runtimeConfig: {} };
        return `<!DOCTYPE html><html><head><title>Coles Supermarkets Australia | Shop Online</title>
<script>window.__RUNTIME_CONFIG__={"BFF_API_SUBSCRIPTION_KEY":"mock-key-123","COLES_ENV":"test"};</script>
<script>document.cookie = "reese84=js-token-" + Date.now() + "; path=/";</script>
</head><body><div id="__next">Coles</div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script></body></html>`;
    };

    const colesListing = (products, page, pageSize, keyword) => {
        const start = (page - 1) * pageSize;
        const results = products.slice(start, start + pageSize);
        if (page === 1 && results.length > 2) results.splice(2, 0, coles.base.adTile);
        return {
            pageProps: {
                searchResults: {
                    didYouMean: null, noOfResults: products.length, start, pageSize, keyword, resultType: 1, results, filters: [],
                },
            },
            __N_SSP: true,
        };
    };

    function handleColes(req, res, url) {
        const s = state.coles;
        s.requests.push(`${req.method} ${url.pathname}${url.search}`);
        const ck = cookiesOf(req);
        if (url.pathname === '/') {
            s.homeLoads++;
            if (s.blockHome > 0) {
                s.blockHome--;
                return send(res, 200, IMPERVA_PAGE);
            }
            return send(res, 200, colesHome(), { 'set-cookie': ['visid_incap_2800108=mockvisid; path=/', 'incap_ses_780_2800108=mockses; path=/'] });
        }
        const m = url.pathname.match(/^\/_next\/data\/([^/]+)\/en\/(.+)\.json$/);
        if (!m) return send(res, 404, { message: 'unknown path' });
        // Simulates a Coles deployment in the middle of a run: the old buildId starts answering 404.
        if (s.rotateBuildAfter && ++s.dataCount > s.rotateBuildAfter) s.buildId = 'test-build-2';
        if (m[1] !== s.buildId) return send(res, 404, { notFound: true });
        const hasCookies = Boolean(ck.visid_incap_2800108) && (!s.requireJsCookie || Boolean(ck.reese84));
        if (s.alwaysBlock || !hasCookies || s.blockData > 0) {
            if (s.blockData > 0) s.blockData--;
            return send(res, 200, IMPERVA_PAGE);
        }
        const route = m[2];
        const page = Number(url.searchParams.get('page') ?? 1);
        if (route === 'search/products') {
            const q = url.searchParams.get('q') ?? '';
            const hits = coles.products.filter((p) => matchesTerm(`${p.brand} ${p.name} ${p.id}`, q) || String(p.id) === q);
            return send(res, 200, colesListing(hits, page, colesPageSize, q));
        }
        if (route.startsWith('browse/')) {
            const slugs = url.searchParams.getAll('slug');
            if (route !== `browse/${slugs.join('/')}`) return send(res, 200, { pageProps: { searchResults: { noOfResults: 0, pageSize: colesPageSize, results: [] } } });
            return send(res, 200, colesListing(coles.products.slice(0, 60), page, colesPageSize, null));
        }
        if (route === 'on-special') {
            const specials = coles.products.filter((p) => p.pricing && (p.pricing.was > p.pricing.now || p.pricing.promotionType === 'SPECIAL'));
            return send(res, 200, colesListing(specials, page, colesPageSize, null));
        }
        const pm = route.match(/^product\/(.+)$/);
        if (pm) {
            const slug = pm[1];
            const id = slug.match(/(\d+)$/)?.[1];
            const p = coles.products.find((x) => String(x.id) === id);
            if (!p) return send(res, 404, { notFound: true });
            if (/^\d+$/.test(slug)) return send(res, 200, { pageProps: { __N_REDIRECT: `/product/some-product-${id}`, __N_REDIRECT_STATUS: 308 }, __N_SSP: true });
            return send(res, 200, { pageProps: { product: p }, __N_SSP: true });
        }
        return send(res, 404, { notFound: true });
    }

    // ── Woolworths ─────────────────────────────────────────────────────────────────
    const woolHome = () => `<!DOCTYPE html><html><head><title>Woolworths Supermarket - Buy Groceries Online</title>
<link rel="preconnect" href="https://cdn1.woolworths.media">
<script>document.cookie = "bm_js=1; path=/";</script></head><body><wow-app></wow-app></body></html>`;

    const woolPage = (products, page, pageSize, key, countKey) => {
        const start = (page - 1) * pageSize;
        const organic = products.slice(start, start + pageSize);
        // Like the real API: sponsored rows on every page, including pages past the end.
        const rows = [...wool.sponsored, ...organic].map((p) => ({ Products: [p], Name: p.Name, DisplayName: p.DisplayName }));
        return { [key]: rows, [countKey]: products.length, Success: true };
    };

    function handleWool(req, res, url, bodyText) {
        const s = state.woolworths;
        s.requests.push(`${req.method} ${url.pathname}`);
        const ck = cookiesOf(req);
        if (url.pathname === '/') {
            s.homeLoads++;
            if (s.blockHome > 0) {
                s.blockHome--;
                return send(res, 403, AKAMAI_PAGE);
            }
            return send(res, 200, woolHome(), { 'set-cookie': ['ak_bmsc=mockak; path=/', 'bm_sz=mocksz; path=/'] });
        }
        if (!url.pathname.startsWith('/apis/ui/')) return send(res, 404, { message: 'unknown' });
        const hasCookies = Boolean(ck.ak_bmsc) && (!s.requireJsCookie || Boolean(ck.bm_js));
        if (s.alwaysBlock || !hasCookies || s.blockApi > 0) {
            if (s.blockApi > 0) s.blockApi--;
            return send(res, 403, AKAMAI_PAGE);
        }
        if (s.fail500 > 0) {
            s.fail500--;
            return send(res, 500, { Message: 'An error has occurred.' });
        }
        let body = {};
        try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { return send(res, 400, { Message: 'bad json' }); }
        if (req.method === 'POST' && url.pathname === '/apis/ui/Search/products') {
            const term = body.SearchTerm ?? '';
            const hits = wool.products.filter((p) => matchesTerm(p.DisplayName, term));
            if (!hits.length) return send(res, 200, { Products: null, SearchResultsCount: 0, Success: true });
            return send(res, 200, woolPage(hits, body.PageNumber ?? 1, body.PageSize ?? 36, 'Products', 'SearchResultsCount'));
        }
        if (req.method === 'GET' && url.pathname === '/apis/ui/PiesCategoriesWithSpecials') return send(res, 200, wool.base.categories);
        if (req.method === 'POST' && url.pathname === '/apis/ui/browse/category') {
            const id = body.categoryId;
            let list = [];
            if (id === 'specialsgroup') list = wool.products.filter((p) => p.IsOnSpecial || p.WasPrice > p.Price);
            else if (id === '1_DEB537E' || id === '1_A6D1FC1') list = wool.products.slice(0, 40);
            else return send(res, 200, { Bundles: [], TotalRecordCount: 0, Success: true });
            return send(res, 200, woolPage(list, body.pageNumber ?? 1, body.pageSize ?? 36, 'Bundles', 'TotalRecordCount'));
        }
        const pm = url.pathname.match(/^\/apis\/ui\/products\/(\d+)$/);
        if (req.method === 'GET' && pm) return send(res, 200, wool.products.filter((p) => String(p.Stockcode) === pm[1]));
        const dm = url.pathname.match(/^\/apis\/ui\/product\/detail\/(\d+)$/);
        if (req.method === 'GET' && dm) return send(res, 404, { Message: 'not found' });
        return send(res, 404, { Message: 'unknown api' });
    }

    const mk = (handler) => http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => handler(req, res, url, body));
    });
    const colesServer = mk(handleColes);
    const woolServer = mk(handleWool);
    await Promise.all([colesServer, woolServer].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
    return {
        colesUrl: `http://127.0.0.1:${colesServer.address().port}`,
        woolUrl: `http://127.0.0.1:${woolServer.address().port}`,
        state,
        coles,
        wool,
        reset() {
            Object.assign(state.coles, { buildId: 'test-build-1', blockData: 0, blockHome: 0, requireJsCookie: false, alwaysBlock: false, requests: [], homeLoads: 0, rotateBuildAfter: 0, dataCount: 0 });
            Object.assign(state.woolworths, { blockApi: 0, blockHome: 0, requireJsCookie: false, alwaysBlock: false, fail500: 0, requests: [], homeLoads: 0 });
        },
        close: () => Promise.all([colesServer, woolServer].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))),
    };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const srv = await startMockServer();
    console.log(`Mock Coles on ${srv.colesUrl}\nMock Woolworths on ${srv.woolUrl}`);
}
