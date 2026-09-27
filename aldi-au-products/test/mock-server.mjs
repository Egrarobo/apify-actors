// Local mock of the ALDI API (api.aldi.com.au) and website, serving product objects built from a real captured
// response of the same platform (see fixtures/build-fixtures.mjs). Switchable behaviour:
//   blockApi = n       → next n API requests get an Akamai "Access Denied" page (HTTP 403)
//   blockBrowserUa     → requests with a browser User-Agent (Mozilla/…) are refused (like aldiscount saw on DE)
//   alwaysBlock        → every API request is refused
//   requireServicePoint→ product-search without servicePoint answers {"errors":[{"code":"3801"}]} (HTTP 400)
//   requireJsCookie    → API needs a cookie that only the website's JavaScript sets (browser tests)
//   fail500 = n        → next n API requests answer HTTP 500
// Usage: const srv = await startMockServer(); srv.apiUrl; srv.siteUrl; srv.state.blockApi = 1; await srv.close();
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/aldi.json', import.meta.url), 'utf8'));

export const AKAMAI_PAGE = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don&#39;t have permission to access '
    + '"http&#58;&#47;&#47;api&#46;aldi&#46;com&#46;au&#47;v3&#47;product&#45;search" on this server.<P>\nReference&#32;&#35;18&#46;abc\n'
    + '<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;abc</P>\n</BODY>\n</HTML>\n';

export const ALLOWED = [12, 16, 24, 30, 32, 48, 60];
export const KEYS = { eggs: '1111111162', dairy: '960000000', superSavers: '1588161426952145', lowerPrices: '1588161425841179' };

const cookiesOf = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), c.slice(i + 1)];
}));

function buildCatalogue(size) {
    const regular = fx.products.filter((p) => !p.onSaleDateDisplay && !p.discontinued);
    const out = [];
    for (let i = 0; out.length < size; i++) {
        const p = structuredClone(regular[i % regular.length]);
        if (i >= regular.length) p.sku = String(900000 + i).padStart(18, '0');
        out.push(p);
    }
    return out;
}

const fresh = () => ({ blockApi: 0, blockBrowserUa: false, alwaysBlock: false, requireServicePoint: false, requireJsCookie: false, fail500: 0, requests: [], specialDates: ['2026-09-26'] });

export async function startMockServer({ size = 150 } = {}) {
    const catalogue = buildCatalogue(size);
    const specialBuys = fx.products.filter((p) => p.onSaleDateDisplay);
    const all = [...catalogue, ...specialBuys, ...fx.products.filter((p) => p.discontinued)];
    const state = fresh();

    const send = (res, code, body, headers = {}) => {
        const isStr = typeof body === 'string';
        res.writeHead(code, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
        res.end(isStr ? body : JSON.stringify(body));
    };

    const page = (list, q) => {
        const limit = Number(q.get('limit') ?? 30);
        const offset = Number(q.get('offset') ?? 0);
        return { meta: { ...fx.meta, pagination: { offset, limit, totalCount: list.length } }, data: list.slice(offset, offset + limit) };
    };

    function handleApi(req, res, url) {
        const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true' };
        if (req.method === 'OPTIONS') {
            return send(res, 204, '', { ...cors, 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET' });
        }
        state.requests.push(`${req.method} ${url.pathname}${url.search} ua=${/Mozilla/.test(req.headers['user-agent'] ?? '') ? 'browser' : 'plain'}`);
        const ck = cookiesOf(req);
        const browserUa = /Mozilla/.test(req.headers['user-agent'] ?? '');
        if (state.alwaysBlock || state.blockApi > 0 || (state.blockBrowserUa && browserUa) || (state.requireJsCookie && !ck.aldi_js)) {
            if (state.blockApi > 0) state.blockApi--;
            return send(res, 403, AKAMAI_PAGE, cors);
        }
        if (state.fail500 > 0) {
            state.fail500--;
            return send(res, 500, { errors: [{ status: 500, code: '500', message: 'Internal error' }] }, cors);
        }
        const q = url.searchParams;
        if (url.pathname === '/v2/service-points') {
            return send(res, 200, { meta: { pagination: { offset: 0, limit: 60, totalCount: 560 } }, data: [{ id: 'G452', name: 'Chatswood', address: { city: 'Chatswood', regionName: 'NSW', countryName: 'Australia' } }] }, cors);
        }
        if (url.pathname === '/v2/product-category-tree') {
            if (!q.get('servicePoint')) return send(res, 400, { errors: [{ status: 400, code: '3801', message: 'servicePoint is required' }] }, cors);
            return send(res, 200, { data: [
                { key: KEYS.dairy, name: 'Dairy, Eggs & Fridge', urlSlugText: 'dairy-eggs-fridge', children: [{ key: KEYS.eggs, name: 'Eggs', urlSlugText: 'dairy-eggs-fridge/eggs', children: [] }] },
                { key: KEYS.superSavers, name: 'Super Savers', urlSlugText: 'super-savers', children: [] },
                { key: KEYS.lowerPrices, name: 'Lower Prices', urlSlugText: 'lower-prices', children: [] },
            ] }, cors);
        }
        if (url.pathname === '/v3/product-search') {
            if (!ALLOWED.includes(Number(q.get('limit')))) return send(res, 400, { errors: [{ status: 400, code: '3731', message: 'Invalid limit' }] }, cors);
            if (state.requireServicePoint && !q.get('servicePoint')) return send(res, 400, { errors: [{ status: 400, code: '3801', message: 'servicePoint is required' }] }, cors);
            if (q.get('serviceType') !== 'walk-in') return send(res, 400, { errors: [{ code: '400', message: 'serviceType missing' }] }, cors);
            let list = [];
            if (q.has('q')) {
                const t = q.get('q').toLowerCase();
                list = t === 'nothing' ? [] : (t === 'milk' || t === '*') ? catalogue : catalogue.filter((p) => `${p.brandName} ${p.name}`.toLowerCase().includes(t));
            } else if (q.has('categoryKey')) {
                const k = q.get('categoryKey');
                if (k === KEYS.dairy || k === KEYS.eggs) list = catalogue.slice(0, 40);
                else if (k === KEYS.superSavers) list = fx.products.filter((p) => p.price.wasPriceDisplay);
                else if (k === KEYS.lowerPrices) list = fx.products.filter((p) => p.categories.some((c) => c.id === '940000000'));
            } else if (q.has('promotionKey')) {
                list = state.specialDates.includes(q.get('promotionKey')) ? specialBuys : [];
            } else list = catalogue;
            if (q.get('sort') === 'price_asc') list = [...list].sort((a, b) => a.price.amount - b.price.amount);
            return send(res, 200, page(list, q), cors);
        }
        if (url.pathname === '/v2/products') {
            const skus = String(q.get('skus') ?? '').split(',');
            return send(res, 200, { data: all.filter((p) => skus.includes(p.sku)) }, cors);
        }
        const one = url.pathname.match(/^\/v2\/products\/(\d+)$/);
        if (one) {
            const p = all.find((x) => x.sku === one[1]);
            return p ? send(res, 200, { data: p }, cors) : send(res, 404, { errors: [{ status: 404, code: '007', message: 'Product not found' }] }, cors);
        }
        return send(res, 404, { errors: [{ code: '404', message: 'unknown path' }] }, cors);
    }

    function handleSite(req, res) {
        return send(res, 200, `<!DOCTYPE html><html><head><title>ALDI Supermarkets - Good Different</title>
<script>document.cookie = "aldi_js=1; path=/";</script></head><body><div id="app">ALDI</div></body></html>`, { 'set-cookie': ['ak_bmsc=mock; path=/'] });
    }

    const mk = (handler) => http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        req.on('data', () => {});
        req.on('end', () => handler(req, res, url));
    });
    const api = mk(handleApi);
    const site = mk(handleSite);
    await Promise.all([api, site].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
    return {
        apiUrl: `http://127.0.0.1:${api.address().port}`,
        siteUrl: `http://127.0.0.1:${site.address().port}`,
        state,
        catalogue,
        reset() { Object.assign(state, fresh()); },
        close: () => Promise.all([api, site].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))),
    };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const srv = await startMockServer();
    console.log(`Mock ALDI API on ${srv.apiUrl}\nMock website on ${srv.siteUrl}`);
}
