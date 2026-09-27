// Local test site for the Actor. Run: node test/server.mjs [port]
import http from 'node:http';
import zlib from 'node:zlib';

const port = Number(process.argv[2] ?? 8765);

// Tiny coloured PNG generated on the fly (no files needed).
function png(w, h, [r, g, b]) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = 0xffffffff;
        for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4);
        c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:sans-serif;margin:0;padding:24px;background:#fff;color:#111} @media (prefers-color-scheme: dark){body{background:#111;color:#eee}} .card{border:1px solid #ccc;padding:16px;margin:16px 0;border-radius:8px}</style>${head}</head><body>${body}</body></html>`;

const COLORS = [[230, 60, 60], [60, 160, 60], [60, 90, 220], [230, 170, 30], [150, 60, 200], [30, 180, 190]];

const routes = {
    '/': () => [200, page('Home', '<h1>Test home</h1><p class="card">Hello from the test server. <span class="theme">Light/dark aware.</span></p><div id="hero" class="card" style="background:#ffe9a8">Hero element for clip tests</div>')],
    '/long': () => [200, page('Long lazy page', `<h1>Long page with lazy images</h1>${
        Array.from({ length: 12 }, (_, i) => `<div class="card"><h2>Section ${i + 1}</h2><img loading="lazy" width="600" height="300" src="/img/${i}.png" alt="img ${i}"><p>${'Lorem ipsum dolor sit amet. '.repeat(20)}</p></div>`).join('')
    }<footer>END OF PAGE</footer>`)],
    '/cookie': () => [200, page('Cookie banner page', `<h1>Page with a cookie banner</h1><p class="card">Main content must stay visible.</p>${'<p>Filler text. </p>'.repeat(30)}
<div class="cookie-consent" style="position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:24px;font-size:20px;z-index:9999">We use cookies to improve your experience. <button>Accept all</button> <button>Reject</button></div>
<header style="position:sticky;top:0;background:#def;padding:8px">Sticky header <a class="cookie-policy-link" href="#">Cookie policy</a></header>`,
    '<style>body{overflow:hidden}</style>')],
    '/redirect': () => [302, '', { Location: '/cookie' }],
    '/missing': () => [404, page('Not found', '<h1>404 - Page not found</h1>')],
    '/error': () => [503, page('Unavailable', '<h1>503 - Service unavailable</h1>')],
    '/slow': async () => {
        await new Promise((r) => setTimeout(r, 3000));
        return [200, page('Slow page', '<h1>Slow page (3 s)</h1>')];
    },
    '/late-element': () => [200, page('Late element', '<h1>Waiting…</h1><script>setTimeout(()=>{const d=document.createElement("div");d.id="ready";d.className="card";d.textContent="Ready element appeared";document.body.appendChild(d)},1500)</script>')],
    '/hang-load': () => [200, page('Never loads', '<h1>Main content loaded; one image never finishes</h1><img src="/never.png" width="100" height="100">')],
    '/ads': () => [200, page('Ads page', '<h1>Page with an ad</h1><script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script><ins class="adsbygoogle" style="display:block;width:300px;height:250px;background:red">AD</ins><div class="chat-widget" style="position:fixed;right:10px;bottom:10px;background:purple;color:#fff;padding:20px">Chat with us</div>')],
    '/file.pdf': () => [200, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'), { 'Content-Type': 'application/pdf' }],
    '/photo.png': () => [200, png(400, 200, [30, 120, 220]), { 'Content-Type': 'image/png' }],
};

http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/never.png') return; // never answers
    const img = path.match(/^\/img\/(\d+)\.png$/);
    if (img) {
        setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(png(600, 300, COLORS[Number(img[1]) % COLORS.length]));
        }, 150);
        return;
    }
    const handler = routes[path];
    if (!handler) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end(page('Not found', '<h1>404</h1>'));
    }
    const [status, body, headers = {}] = await handler();
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
}).listen(port, '127.0.0.1', () => console.log(`Test server on http://127.0.0.1:${port}`));
