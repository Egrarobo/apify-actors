// Local mock of the Google Hotels endpoints the Actor uses, serving the real captured data in test/fixtures.
// Simulates: paginated search page (AF_initDataCallback ds:0), batchexecute RPC (search + detail), hotel entity
// page, EU consent page (with a clickable "Accept all" button), and the /sorry/ captcha page.
// Standalone: node test/mock-server.mjs 8787
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const K_HOTEL = '397419284';
const K_PAGE = '410579159';
const K_TOTAL = '416343588';

const clone = (x) => JSON.parse(JSON.stringify(x));
const hotelEntries = (tree) => {
    const out = [];
    const walk = (n) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) {
            if (k === K_HOTEL) out.push(v[0]);
            else walk(v);
        }
    };
    walk(tree);
    return out;
};
const setKey = (tree, key, fn) => {
    const walk = (n) => {
        if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) {
            if (k === key) n[k] = fn(v);
            else walk(v);
        }
    };
    walk(tree);
    return tree;
};

/** Page 1 = the real capture (18 hotels, next token "CBI="). Page 2 = 12 more hotels (renamed copies), last page. */
function buildPages() {
    const page1 = fx('search-nyc.json');
    const page2 = clone(page1);
    const extra = hotelEntries(page2);
    extra.forEach((h, i) => {
        h[1] = `${h[1]} (Page 2 #${i + 1})`;
        h[20] = `${h[20]}P2x${i}`;
        h[9] = `0x0:0x${(0xabc000 + i).toString(16)}`;
    });
    setKey(page2, K_PAGE, (v) => ['', '', v[2], 2, 36]);
    // Keep only the first 12 hotels on page 2. Result entries are [id, {K_HOTEL: [hotel]}] (same as ds:0).
    const list = page2[0][0][0][1];
    let kept = 0;
    page2[0][0][0][1] = list.filter((e) => !e?.[1]?.[K_HOTEL] || ++kept <= 12);
    const unrecognized = clone(page1);
    unrecognized[0][0][0][1] = unrecognized[0][0][0][1].filter((e) => !e?.[1]?.[K_HOTEL] && !e?.[1]?.[K_PAGE]);
    setKey(unrecognized, K_TOTAL, () => [0, false, 'Nowhereville', false, 2]);
    return { page1, page2, unrecognized };
}

const detailTree = fx('detail-manhattan.json');
export const MANHATTAN_ID = hotelEntries(detailTree)[0]?.[20] ?? (() => {
    let id = null;
    const walk = (n) => {
        if (id) return;
        if (Array.isArray(n)) {
            if (n.length > 20 && n[1] === 'The Manhattan at Times Square Hotel' && typeof n[20] === 'string') id = n[20];
            else n.forEach(walk);
        } else if (n && typeof n === 'object') Object.values(n).forEach(walk);
    };
    walk(detailTree);
    return id;
})();

/** Detail response for any hotel: the real Manhattan capture, renamed to the requested hotel when known. */
function detailFor(entityId, known) {
    const t = clone(detailTree);
    const target = known.get(entityId);
    const walk = (n) => {
        if (Array.isArray(n)) {
            if (n.length > 20 && n[20] === MANHATTAN_ID && typeof n[1] === 'string') {
                n[20] = entityId;
                if (target) {
                    n[1] = target;
                    // Official-site offer row carries the hotel name.
                    const all = n[6]?.[2];
                    for (const idx of [2, 12, 21, 22]) for (const row of all?.[idx] ?? []) if (row?.[0]?.[5] === true) row[0][0] = target;
                }
                return;
            }
            n.forEach(walk);
        } else if (n && typeof n === 'object') Object.values(n).forEach(walk);
    };
    walk(t);
    return t;
}

const htmlPage = (blobs, title = 'Google Hotels') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><c-wiz></c-wiz>`
    + Object.entries(blobs).map(([k, data]) => `<script nonce="abc">AF_initDataCallback({key: '${k}', hash: '1', data:${JSON.stringify(data)}, sideChannel: {}});</script>`).join('')
    + '</body></html>';

const rpcResponse = (payload) => {
    const frame = JSON.stringify([['wrb.fr', 'AtySUc', payload === null ? null : JSON.stringify(payload), null, null, null, 'generic'], ['di', 42], ['af.httprm', 41, '-123', 7]]);
    return `)]}'\n\n${frame.length}\n${frame}\n25\n[["e",4,null,null,${frame.length}]]\n`;
};

const CONSENT_HTML = (cont) => `<!doctype html><html><head><title>Before you continue to Google</title></head><body>
<h1>Before you continue to Google</h1><p>We use cookies and data to deliver and maintain Google services.</p>
<form action="/save" method="GET"><input type="hidden" name="continue" value="${cont.replace(/"/g, '&quot;')}"><button type="submit" aria-label="Accept all">Accept all</button></form>
</body></html>`;
const CAPTCHA_HTML = '<!doctype html><html><head><title>Sorry...</title></head><body><div>Our systems have detected unusual traffic from your computer network.</div><form id="captcha-form"><div class="g-recaptcha"></div></form></body></html>';

export async function startMockServer() {
    const pages = buildPages();
    const known = new Map([...hotelEntries(pages.page1), ...hotelEntries(pages.page2)].map((h) => [h[20], h[1]]));
    const state = {
        requests: [],
        consent: 'none', // 'none' | 'always' (needs the browser to click "Accept all")
        captchaNext: 0, // the next N search/RPC requests get the captcha page
        searchPageBroken: false, // search page without data blobs (forces the RPC fallback)
        rpcBroken: false, // RPC answers with an empty payload
        detailRpcBroken: false, // only detail RPCs fail (forces the entity-page fallback)
        rpcBodies: [],
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            state.requests.push(`${req.method} ${url.pathname}${url.search.slice(0, 300)}`);
            const cookie = req.headers.cookie ?? '';
            const send = (code, text, headers = {}) => {
                res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
                res.end(text);
            };
            const needsConsent = state.consent === 'always' && !cookie.includes('SOCS=ACCEPTED');
            const guarded = url.pathname.startsWith('/travel') || url.pathname.startsWith('/_/');

            if (url.pathname === '/consent') return send(200, CONSENT_HTML(url.searchParams.get('continue') ?? '/'));
            if (url.pathname === '/save') {
                return send(302, '', { location: url.searchParams.get('continue') || '/travel/hotels', 'set-cookie': 'SOCS=ACCEPTED; Path=/' });
            }
            if (url.pathname.startsWith('/sorry/')) return send(429, CAPTCHA_HTML);
            if (guarded && needsConsent) {
                if (req.method === 'POST') return send(403, CONSENT_HTML('/'));
                return send(302, '', { location: `/consent?continue=${encodeURIComponent(req.url)}` });
            }
            if (guarded && url.pathname !== '/travel/hotels' && state.captchaNext > 0) {
                state.captchaNext--;
                return send(302, '', { location: `/sorry/index?continue=${encodeURIComponent(req.url)}` });
            }

            if (url.pathname === '/travel/hotels') return send(200, htmlPage({ 'ds:1': [null] }, 'Google Hotels'));

            if (req.method === 'GET' && url.pathname === '/travel/search') {
                if (state.searchPageBroken) return send(200, '<!doctype html><html><body><div>Hotels</div><script>var x=1;</script></body></html>');
                const q = (url.searchParams.get('q') ?? '').toLowerCase();
                if (q.includes('nowhereville')) return send(200, htmlPage({ 'ds:0': pages.unrecognized }));
                const data = url.searchParams.get('qs') ? pages.page2 : pages.page1;
                return send(200, htmlPage({ 'ds:1': [[null, 'x']], 'ds:0': data, 'ds:2': [1, 2, 3] }));
            }

            if (req.method === 'POST' && url.pathname === '/_/TravelFrontendUi/data/batchexecute') {
                const freq = new URLSearchParams(body).get('f.req');
                let inner = null;
                try {
                    inner = JSON.parse(JSON.parse(freq)[0][0][1]);
                } catch {
                    return send(400, 'bad request');
                }
                state.rpcBodies.push(inner);
                const entityId = inner?.[2]?.[5];
                if (state.rpcBroken || (entityId && state.detailRpcBroken)) return send(200, rpcResponse(null), { 'content-type': 'application/json; charset=utf-8' });
                if (entityId) return send(200, rpcResponse(detailFor(entityId, known)), { 'content-type': 'application/json; charset=utf-8' });
                const q = String(inner?.[0] ?? '').toLowerCase();
                if (q.includes('nowhereville')) return send(200, rpcResponse(pages.unrecognized), { 'content-type': 'application/json; charset=utf-8' });
                return send(200, rpcResponse(inner?.[2]?.[1] ? pages.page2 : pages.page1), { 'content-type': 'application/json; charset=utf-8' });
            }

            const ent = url.pathname.match(/^\/travel\/hotels\/entity\/([A-Za-z0-9_-]+)(\/prices)?$/);
            if (req.method === 'GET' && ent) return send(200, htmlPage({ 'ds:0': [null], 'ds:3': detailFor(ent[1], known) }));

            return send(404, 'not found');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        state,
        known,
        reset() {
            Object.assign(state, { requests: [], consent: 'none', captchaNext: 0, searchPageBroken: false, rpcBroken: false, detailRpcBroken: false, rpcBodies: [] });
        },
        close: () => new Promise((r) => server.close(r)),
    };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const s = await startMockServer();
    console.log(`Mock Google Hotels at ${s.url}`);
}
