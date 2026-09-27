// Local mock of Tesco's GraphQL API (xapi.tesco.com) and website, serving product nodes from basketeer's test bodies
// (see fixtures/build-fixtures.mjs). Switchable behaviour:
//   blockApi = n      → next n API requests get an Akamai "Access Denied" page (HTTP 403)
//   alwaysBlock       → every API request is refused
//   rate429 = n       → next n API requests answer HTTP 429
//   apiKey            → the key the API accepts (others get 403 "Invalid Client"); siteKey is what the website shows
//   basicSchemaOnly   → the extended fields are rejected ("Cannot query field …"), with HTTP schemaErrorStatus (200/400)
//   ignorePage        → the API ignores `page` (always page 1)
//   requireJsCookie   → the API needs a cookie only the website's JavaScript sets (browser tests)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tesco.json', import.meta.url), 'utf8'));
export const PUBLIC_KEY = 'TvOSZJHlEk0pjniDGQFAc9Q59WGAR4dA';
export const NEW_KEY = 'NewRotatedKey0123456789abcdefXYZ';
export const AKAMAI_PAGE = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don&#39;t have permission to access '
    + '"http&#58;&#47;&#47;xapi&#46;tesco&#46;com&#47;" on this server.<P>\nReference&#32;&#35;18&#46;abc\n'
    + '<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;abc</P>\n</BODY>\n</HTML>\n';
const b64 = (s) => `b;${Buffer.from(s).toString('base64')}`;
export const FACETS = { freshFood: b64('Fresh Food'), milkButterEggs: b64('Milk, Butter & Eggs'), milk: 'b;TWlsaw==', bakery: b64('Bakery') };
const EXTRA = ['gtin', 'superDepartmentName', 'departmentName', 'aisleName', 'shelfName'];

const cookiesOf = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), c.slice(i + 1)];
}));

function buildCatalogue(size) {
    const out = [];
    const src = fx.searchNodes;
    for (let i = 0; out.length < size; i++) {
        const n = structuredClone(src[i % src.length]);
        if (i >= src.length) {
            n.tpnc = String(300000000 + i);
            n.tpnb = String(50000000 + i);
            // Every third clone has no offer, so "only offers" has something to filter out.
            if (i % 3 === 0) n.sellers.results[0].promotions = [];
        }
        Object.assign(n, { gtin: `50${String(i).padStart(11, '0')}`, superDepartmentName: 'Fresh Food', departmentName: 'Milk, Butter & Eggs', aisleName: 'Milk', shelfName: 'Fresh Milk' });
        out.push(n);
    }
    return out;
}

const fresh = () => ({
    blockApi: 0, alwaysBlock: false, rate429: 0, apiKey: PUBLIC_KEY, siteKey: PUBLIC_KEY, basicSchemaOnly: false, schemaErrorStatus: 400,
    ignorePage: false, requireJsCookie: false, requests: [], ops: [],
});

export async function startMockServer({ size = 130 } = {}) {
    const catalogue = buildCatalogue(size);
    const products = [...fx.products, ...catalogue.map((n) => {
        const p = structuredClone(n);
        const s = p.sellers.results[0];
        delete p.sellers;
        return { ...p, price: s.price, promotions: s.promotions, details: { packSize: null } };
    })];
    const state = fresh();

    const send = (res, code, body, headers = {}) => {
        const isStr = typeof body === 'string';
        res.writeHead(code, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
        res.end(isStr ? body : JSON.stringify(body));
    };
    const strip = (n, full) => {
        if (full) return n;
        const c = { ...n };
        for (const k of EXTRA) delete c[k];
        return c;
    };

    function listing(list, v, full) {
        const count = Number(v.count ?? 24);
        const page = state.ignorePage ? 1 : Number(v.page ?? 1);
        const rows = list.slice((page - 1) * count, page * count).map((n) => ({ node: strip(n, full) }));
        return { ...(full ? { info: { total: list.length, page, count: rows.length, pageSize: count, offset: (page - 1) * count } } : {}), results: rows };
    }

    function runOp(op) {
        const full = /superDepartmentName|info \{/.test(op.query ?? '');
        const v = op.variables ?? {};
        state.ops.push({ name: op.operationName, variables: v, mfeName: op.extensions?.mfeName, full });
        if (op.operationName === 'Search') {
            const q = String(v.query ?? '').toLowerCase();
            const hits = q === 'nothing' ? [] : (q === 'milk' || q === '*') ? catalogue : catalogue.filter((n) => n.title.toLowerCase().includes(q));
            return { data: { search: listing(hits, v, full) } };
        }
        if (op.operationName === 'GetCategoryProducts') {
            const f = v.facet;
            const list = f === FACETS.freshFood ? catalogue.slice(0, 60) : f === FACETS.milkButterEggs ? catalogue.slice(0, 20) : f === FACETS.bakery ? fx.categoryNodes : [];
            return { data: { category: listing(list, v, full) } };
        }
        if (op.operationName === 'Taxonomy') {
            return { data: { taxonomy: [
                { name: 'Fresh Food', label: 'Fresh Food', children: [{ id: FACETS.milkButterEggs, name: 'Milk, Butter & Eggs', label: 'Milk, Butter & Eggs', children: [{ id: FACETS.milk, name: 'Milk', label: 'Milk' }] }] },
                { name: 'Bakery', label: 'Bakery', children: [] },
            ] } };
        }
        if (op.operationName === 'GetProducts') {
            const data = {};
            const errors = [];
            Object.entries(v).forEach(([k, id]) => {
                const alias = `p${k.replace('tpnc', '')}`;
                const p = products.find((x) => String(x.tpnc) === String(id));
                data[alias] = p ? strip(p, full) : null;
                if (!p) errors.push({ message: 'product-not-found', path: [alias] });
            });
            return errors.length ? { data, errors } : { data };
        }
        return { errors: [{ message: `Unknown operation ${op.operationName}` }] };
    }

    function handleApi(req, res, url, bodyText) {
        const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true' };
        if (req.method === 'OPTIONS') {
            return send(res, 204, '', { ...cors, 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'POST' });
        }
        state.requests.push(`${req.method} ${url.pathname} key=${req.headers['x-apikey']} region=${req.headers.region}`);
        const ck = cookiesOf(req);
        if (state.alwaysBlock || state.blockApi > 0 || (state.requireJsCookie && !ck.tesco_js)) {
            if (state.blockApi > 0) state.blockApi--;
            return send(res, 403, AKAMAI_PAGE, cors);
        }
        if (state.rate429 > 0) {
            state.rate429--;
            return send(res, 429, 'Too Many Requests', { ...cors, 'content-type': 'text/plain' });
        }
        if (req.headers['x-apikey'] !== state.apiKey) return send(res, 403, 'Forbidden: Invalid Client', { ...cors, 'content-type': 'text/plain' });
        if (req.method !== 'POST' || url.pathname !== '/') return send(res, 404, { message: 'not found' }, cors);
        if (req.headers.region !== 'UK' || req.headers.language !== 'en-GB') return send(res, 200, [{ errors: [{ message: 'region/language headers missing' }] }], cors);
        let ops;
        try { ops = JSON.parse(bodyText); } catch { return send(res, 400, [{ errors: [{ message: 'bad json' }] }], cors); }
        if (!Array.isArray(ops)) return send(res, 400, { errors: [{ message: 'expected a batch array' }] }, cors);
        if (state.basicSchemaOnly && ops.some((o) => /superDepartmentName|info \{/.test(o.query ?? ''))) {
            const err = [{ errors: [{ message: 'Cannot query field "superDepartmentName" on type "ProductInterface".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }];
            return send(res, state.schemaErrorStatus, err, cors);
        }
        return send(res, 200, ops.map(runOp), cors);
    }

    function handleSite(req, res, url) {
        if (url.pathname === '/groceries/en-GB/' || url.pathname === '/shop/en-GB/') {
            return send(res, 200, `<!DOCTYPE html><html><head><title>Tesco Groceries</title><script>window.__CONFIG__={"mangoUrl":"https://xapi.tesco.com/","mangoApiKey":"${state.siteKey}"};</script></head><body>groceries</body></html>`);
        }
        return send(res, 200, `<!DOCTYPE html><html><head><title>Tesco - Online Groceries</title>
<script>document.cookie = "tesco_js=1; path=/";</script></head><body>Tesco</body></html>`, { 'set-cookie': ['_abck=mock; path=/'] });
    }

    const mk = (handler) => http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => handler(req, res, url, body));
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
    console.log(`Mock Tesco API on ${srv.apiUrl}\nMock website on ${srv.siteUrl}`);
}
