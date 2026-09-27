// Local mock of the MTender public API (+ notification sinks) serving the fixtures.
// Usage in tests: const srv = await startMockServer({ pageSize: 3 }); … srv.url; await srv.close();
// Standalone: node test/mock-server.mjs 8787
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fixturesDir = new URL('./fixtures/', import.meta.url);

export async function startMockServer({ pageSize = 3 } = {}) {
    const index = JSON.parse(readFileSync(new URL('feed-index.json', fixturesDir), 'utf8'));
    const pkgs = new Map();
    for (const e of index) {
        if (!e.missing) pkgs.set(e.ocid, JSON.parse(readFileSync(new URL(`tenders/${e.ocid}.json`, fixturesDir), 'utf8')));
    }
    const state = { failOcids: new Set(), showLater: false, flakyStep: new Map(), requests: [], received: [], endWithEmptyBody: false, down: false };

    const visibleFeed = (kind) => index
        .filter((e) => state.showLater || !e.later)
        .filter((e) => {
            if (kind === 'all') return true;
            const status = pkgs.get(e.ocid)?.records?.[0]?.compiledRelease?.tender?.status;
            return kind === 'plan' ? status === 'planning' : status !== 'planning';
        })
        .sort((a, b) => a.date.localeCompare(b.date));

    const send = (res, code, body, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let bodyText = '';
        req.on('data', (c) => { bodyText += c; });
        req.on('end', () => {
            state.requests.push(`${req.method} ${url.pathname}${url.search}`);
            if (state.down) return send(res, 503, { error: 'down' });

            // Notification sinks
            if (req.method === 'POST' && (url.pathname.startsWith('/telegram/') || url.pathname === '/slack' || url.pathname === '/webhook' || url.pathname === '/webhook-fail')) {
                let body = null;
                try { body = JSON.parse(bodyText); } catch { /* ignore */ }
                state.received.push({ path: url.pathname, body });
                if (url.pathname === '/webhook-fail') return send(res, 500, { error: 'nope' });
                return send(res, 200, { ok: true });
            }

            // Feeds
            const feedMatch = url.pathname.match(/^\/tenders\/?(cn|plan)?$/);
            if (req.method === 'GET' && feedMatch) {
                const kind = feedMatch[1] ?? 'all';
                const offset = url.searchParams.get('offset') ?? '1970-01-01T00:00:00Z';
                const offMs = Date.parse(offset);
                const rest = visibleFeed(kind).filter((e) => Date.parse(e.date) > offMs);
                if (!rest.length) return state.endWithEmptyBody ? send(res, 200, '') : send(res, 200, {});
                const page = rest.slice(0, pageSize).map((e) => ({ ocid: e.ocid, date: e.date }));
                return send(res, 200, { data: page, offset: page[page.length - 1].date });
            }

            // Record packages
            const recMatch = url.pathname.match(/^\/tenders\/(ocds-[A-Za-z0-9-]+)$/);
            if (req.method === 'GET' && recMatch) {
                const ocid = recMatch[1];
                const entry = index.find((e) => e.ocid === ocid);
                if (!entry || entry.missing || (entry.later && !state.showLater)) return send(res, 404, { message: 'not found' });
                if (state.failOcids.has(ocid)) return send(res, 503, { error: 'Service Unavailable' });
                if (entry.flaky) {
                    const step = state.flakyStep.get(ocid) ?? 0;
                    state.flakyStep.set(ocid, step + 1);
                    if (step === 0) return send(res, 500, { error: 'Internal Server Error' });
                    if (step === 1) return send(res, 429, { error: 'Too Many Requests' }, { 'retry-after': '1' });
                    if (step === 2) return send(res, 200, { message: 'connect EHOSTUNREACH 185.108.182.236:443', name: 'Error', stack: 'Error: connect EHOSTUNREACH', code: 'EHOSTUNREACH' });
                }
                return send(res, 200, pkgs.get(ocid));
            }
            return send(res, 404, { message: 'unknown path' });
        });
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        state,
        index,
        showLater() { state.showLater = true; },
        resetFlaky() { state.flakyStep.clear(); },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const srv = await startMockServer({ pageSize: Number(process.argv[3]) || 3 });
    console.log(`Mock MTender API on ${srv.url}`);
}
