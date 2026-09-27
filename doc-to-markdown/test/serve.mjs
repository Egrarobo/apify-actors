// Tiny static server for local tests: node test/serve.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = new URL('./fixtures/', import.meta.url).pathname;
const port = Number(process.argv[2] || 8765);
http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
}).listen(port, () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
