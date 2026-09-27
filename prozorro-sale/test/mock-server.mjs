/**
 * Local mock of the Prozorro.Sale Procedure API + notification sinks, for testing without network access.
 *   node test/mock-server.mjs [port]
 * Endpoints: /api/search/byDateModified/:since, /api/search/bySellingMethod/:m, /api/search/byAuctionId/:id,
 *            /api/procedures/:id, /api/legal_names, /api/auction_prefixes
 * Test hooks: POST /__admin/add {count}   adds freshly published procedures
 *             POST /__admin/faults {"429": n, "503": n}   next n API calls fail with that status
 *             GET  /__admin/log   requests and received notifications
 * Sinks: POST /webhook, POST /slack, POST /bot<token>/sendMessage (Telegram)
 */
import http from 'node:http';
import { makeFixtures, LEGAL_NAMES, PREFIXES } from './fixtures.mjs';

const port = Number(process.argv[2] ?? 8787);
const procedures = makeFixtures();
const faults = { 429: 0, 503: 0 };
const log = { requests: [], notifications: [] };
let added = 0;

const byModified = () => [...procedures].sort((a, b) => Date.parse(a.dateModified) - Date.parse(b.dateModified));
const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
});

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = decodeURIComponent(url.pathname);
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 100));

    if (req.method === 'POST') {
        const body = await readBody(req);
        if (path === '/__admin/add') {
            const { count = 3 } = JSON.parse(body || '{}');
            const now = Date.now();
            const tpl = procedures.find((p) => p.sellingMethod === 'landRental-english');
            for (let k = 0; k < count; k++) {
                const i = 900 + added++;
                const t = new Date(now - (count - k) * 1000).toISOString();
                procedures.push({ ...structuredClone(tpl), _id: (0x70000000000000000000a000n + BigInt(i)).toString(16), auctionId: `LRE001-UA-20260926-${90000 + i}`, status: 'active_rectification', title: { uk_UA: `Нова земельна ділянка ${i}` }, datePublished: t, dateModified: t });
            }
            return send(res, 200, { added: count, total: procedures.length });
        }
        if (path === '/__admin/faults') {
            Object.assign(faults, JSON.parse(body || '{}'));
            return send(res, 200, faults);
        }
        log.notifications.push({ path: path.replace(/bot[^/]+/, 'bot***'), body: JSON.parse(body || 'null') });
        if (path === '/webhook-fail') return send(res, 500, { error: 'boom' });
        return send(res, 200, { ok: true });
    }
    if (path === '/__admin/log') return send(res, 200, log);

    log.requests.push(path + url.search);
    if (faults[429] > 0) { faults[429]--; return send(res, 429, { error: 'Too Many Requests' }, { 'retry-after': '1' }); }
    if (faults[503] > 0) { faults[503]--; return send(res, 503, { error: 'Service Unavailable' }); }

    let m;
    if ((m = path.match(/^\/api\/search\/byDateModified\/(.+)$/))) {
        const since = Date.parse(m[1]);
        if (Number.isNaN(since)) return send(res, 422, { message: 'invalid date' });
        return send(res, 200, byModified().filter((p) => Date.parse(p.dateModified) >= since).slice(0, limit));
    }
    if ((m = path.match(/^\/api\/search\/bySellingMethod\/(.+)$/))) {
        if (!LEGAL_NAMES.includes(m[1])) return send(res, 404, { message: 'Not found' });
        return send(res, 200, byModified().reverse().filter((p) => p.sellingMethod === m[1]).slice(0, limit));
    }
    if ((m = path.match(/^\/api\/search\/byAuctionId\/(.+)$/))) {
        const p = procedures.find((x) => x.auctionId === m[1]);
        return p ? send(res, 200, { ...p, _score: 1 }) : send(res, 404, { message: 'Not found' });
    }
    if ((m = path.match(/^\/api\/procedures\/([0-9a-f]{24})$/))) {
        const p = procedures.find((x) => x._id === m[1]);
        return p ? send(res, 200, p) : send(res, 404, { message: 'Not found' });
    }
    if (path === '/api/legal_names') return send(res, 200, LEGAL_NAMES);
    if (path === '/api/auction_prefixes') return send(res, 200, PREFIXES);
    return send(res, 404, { message: 'Not found' });
}).listen(port, () => console.log(`mock Prozorro.Sale API on http://127.0.0.1:${port} (${procedures.length} procedures)`));
