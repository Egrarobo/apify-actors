// Local mock of the official endpoints, used with the Actor's `apiBaseUrl` input.
//   GET /datasets/getdata?index=gbd_ul&version=v1&page&count&text&column&order  (data.egov.kz dataset viewer)
//   GET /api/v4/gbd_ul/v1?apiKey&source                                          (data.egov.kz API v4)
//   GET /api/juridical/counter/api/?bin&lang                                     (stat.gov.kz BIN search)
import http from 'node:http';
import fs from 'node:fs';

const REG = JSON.parse(fs.readFileSync(new URL('./fixtures/registry-gbd_ul.json', import.meta.url), 'utf8')).records;
const STAT = JSON.parse(fs.readFileSync(new URL('./fixtures/statistics-counter-api.json', import.meta.url), 'utf8')).byBinAndLang;

/**
 * @param {object} o
 * @param {boolean} [o.blockAll]  drop every connection (simulates geo-blocking of both hosts)
 * @param {boolean} [o.blockStat] drop connections to the statistics endpoint only
 * @param {boolean} [o.htmlStat]  answer the statistics endpoint with an HTML block page
 * @param {string}  [o.apiKey]    API key accepted by /api/v4
 */
export function startMockServer(o = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');
        requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
        const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

        if (o.blockAll) { req.socket.destroy(); return; }

        if (u.pathname === '/datasets/getdata') {
            if (u.searchParams.get('index') !== 'gbd_ul') return json(400, { error: 'bad index' });
            const text = (u.searchParams.get('text') ?? '').toLowerCase();
            const page = Number(u.searchParams.get('page') ?? 1);
            const count = Number(u.searchParams.get('count') ?? 20);
            // Like a full-text search box: matches BIN, names and addresses.
            const words = text.split(/\s+/).filter(Boolean);
            const all = REG.filter((r) => words.every((w) => `${r.bin} ${r.nameru} ${r.namekz} ${r.addressru}`.toLowerCase().includes(w)));
            return json(200, { elements: all.slice((page - 1) * count, page * count), totalPages: Math.max(1, Math.ceil(all.length / count)), total: all.length });
        }

        if (u.pathname === '/api/v4/gbd_ul/v1') {
            if (!o.apiKey || u.searchParams.get('apiKey') !== o.apiKey) return json(403, { error: 'Invalid apiKey' });
            const source = JSON.parse(u.searchParams.get('source') ?? '{}');
            const must = source.query?.bool?.must ?? [];
            const bin = must.find((m) => m.match?.bin)?.match.bin;
            const should = source.query?.bool?.should ?? [];
            const nameQ = should[0]?.match?.nameru?.query?.toLowerCase();
            let out = [];
            if (bin) out = REG.filter((r) => r.bin === bin);
            else if (nameQ) out = REG.filter((r) => nameQ.split(/\s+/).every((w) => `${r.nameru} ${r.namekz}`.toLowerCase().includes(w)));
            return json(200, out.slice(0, source.size ?? 10));
        }

        if (u.pathname === '/api/juridical/counter/api/' || u.pathname === '/api/juridical/counter/api') {
            if (o.blockStat) { req.socket.destroy(); return; }
            if (o.htmlStat) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><h1>Access denied</h1></body></html>'); return; }
            const bin = u.searchParams.get('bin');
            const lang = u.searchParams.get('lang') ?? 'ru';
            const rec = STAT[bin]?.[lang] ?? STAT[bin]?.ru;
            if (!rec) return json(200, { success: false, obj: null, description: 'Не найдено' });
            return json(200, { success: true, obj: rec, description: null });
        }

        json(404, { error: 'not found' });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) });
        });
    });
}
