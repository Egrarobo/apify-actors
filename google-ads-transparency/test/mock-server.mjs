// Local stand-in for adstransparency.google.com/anji/_/rpc, serving real answers saved in fixtures/.
import http from 'node:http';
import { fixture } from './helpers.mjs';

export async function startMockServer() {
    const state = { requests: [], blockNext: 0, blockAlways: false };
    const suggestions = fixture('suggestions-nike.json');
    const page1 = fixture('creatives-nike-p1.json');
    const detail = fixture('detail-nike-image.json');
    // Page 2: the same 5 ads with new IDs and no next-page token.
    const page2 = { 1: page1['1'].map((c, i) => ({ ...c, 2: `CR9000000000000000000${i}` })), 4: page1['4'], 5: page1['5'] };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const freq = JSON.parse(new URLSearchParams(body).get('f.req') ?? 'null');
            state.requests.push({ path: req.url.split('?')[0], freq });
            if (state.blockAlways || state.blockNext > 0) {
                state.blockNext = Math.max(0, state.blockNext - 1);
                res.writeHead(302, { location: 'https://www.google.com/sorry/index?continue=x' });
                return res.end('<HTML>302 Moved</HTML>');
            }
            const send = (o) => {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(o));
            };
            if (req.url.includes('SearchSuggestions')) return send(suggestions);
            if (req.url.includes('GetCreativeById')) {
                const d = structuredClone(detail);
                d['1']['1'] = freq['1'];
                d['1']['2'] = freq['2'];
                return send(d);
            }
            if (req.url.includes('SearchCreatives')) {
                if (freq['3']?.['8']?.[0] === 2498) return send({}); // no ads in Moldova
                return send(freq['4'] ? page2 : page1);
            }
            res.writeHead(404);
            return res.end();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url,
        state,
        reset() { state.requests = []; state.blockNext = 0; state.blockAlways = false; },
        close: () => new Promise((r) => server.close(r)),
    };
}
