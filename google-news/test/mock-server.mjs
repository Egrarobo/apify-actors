// Local stand-in for news.google.com: RSS feeds (real fixtures), article pages and the batchexecute decoder.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const FEEDS = { openai: fx('search-openai.xml'), moldova: fx('search-moldova-ro.xml'), business: fx('topic-business.xml') };
const EMPTY = FEEDS.openai.slice(0, FEEDS.openai.indexOf('<item>')) + '</channel></rss>';

export async function startMockServer() {
    const state = { requests: [], fail429: 0, decodeFail: false, batches: [] };
    let base;
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        state.requests.push(`${req.method} ${u.pathname}${u.search}`);
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (code, text, headers = {}) => { res.writeHead(code, { 'content-type': 'text/xml; charset=utf-8', ...headers }); res.end(text); };
            if (u.pathname.startsWith('/rss') && !u.pathname.startsWith('/rss/articles') && state.fail429 > 0) { state.fail429--; return send(429, 'Too many'); }
            if (u.pathname === '/rss/search') {
                const q = (u.searchParams.get('q') || '').toLowerCase();
                if (q.startsWith('nothing')) return send(200, EMPTY);
                if (q.startsWith('broken')) return send(200, '<html>not a feed</html>');
                // one search per day: rewrite dates so each day returns distinct items
                const day = q.match(/after:(\d{4}-\d{2}-\d{2})/)?.[1];
                let xml = q.startsWith('moldova') ? FEEDS.moldova : FEEDS.openai;
                if (day) xml = xml.replace(/<guid([^>]*)>([^<]+)</g, (m, a, g) => `<guid${a}>${g}D${day}<`).replace(/<pubDate>[^<]+</g, `<pubDate>${new Date(`${day}T12:00:00Z`).toUTCString()}<`);
                return send(200, xml);
            }
            if (u.pathname === '/rss') return send(200, FEEDS.business);
            const sec = u.pathname.match(/^\/rss\/headlines\/section\/(topic|geo)\/(.+)$/);
            if (sec) return send(302, '', { location: `/rss/topics/CAAq${sec[2]}${u.search}` });
            if (u.pathname.startsWith('/rss/topics/')) return send(200, FEEDS.business);
            const art = u.pathname.match(/^\/rss\/articles\/([^/]+)$/);
            if (art) {
                if (state.decodeFail) return send(200, '<html><body>nothing</body></html>', { 'content-type': 'text/html' });
                return send(200, `<html><body>${'x'.repeat(2000)}<c-wiz><div jscontroller="aLI87" data-n-a-id="${art[1]}" data-n-a-ts="1760000000" data-n-a-sg="SIG${art[1].length}"></div></c-wiz></body></html>`, { 'content-type': 'text/html' });
            }
            if (u.pathname === '/_/DotsSplashUi/data/batchexecute') {
                const freq = JSON.parse(decodeURIComponent(body.replace(/^f\.req=/, '')));
                state.batches.push(freq[0].length);
                // answers in reverse order, keyed by the request index
                const answers = freq[0].map(([, inner, , idx]) => {
                    const id = JSON.parse(inner)[2];
                    return ['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', `${base}/pub/${id.slice(-12)}`, 1]), null, null, null, idx];
                }).reverse();
                return send(200, `)]}'\n\n${JSON.stringify([...answers, ['di', 15]])}`, { 'content-type': 'application/json' });
            }
            const pub = u.pathname.match(/^\/pub\/(.+)$/);
            if (pub) {
                return send(200, `<html lang="en"><head><title>t</title><meta property="og:description" content="Summary of ${pub[1]} &amp; more"><meta property="og:image" content="${base}/img/${pub[1]}.jpg"><meta name="author" content="Jane Doe"><link rel="canonical" href="${base}/canonical/${pub[1]}"></head><body>full text</body></html>`, { 'content-type': 'text/html' });
            }
            send(404, 'not found');
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    return {
        url: base,
        state,
        reset() { state.requests = []; state.fail429 = 0; state.decodeFail = false; state.batches = []; },
        close: () => new Promise((r) => server.close(r)),
    };
}
