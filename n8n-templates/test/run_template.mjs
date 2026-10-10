// Offline check of an n8n template without an n8n account:
// 1) structure: unique names, every connection points to an existing node, credentials named;
// 2) runs the chain in order: Set nodes, Code nodes (real JS, n8n-like $input/$json/$()), expressions,
//    HTTP Request nodes calling the real Apify API (token from $APIFY_TOKEN or the studio .env, never printed);
//    Google Sheets / Drive nodes are replaced by the mock data given on the command line.
// Usage: node run_template.mjs <template.json> <mocks.json>
import fs from 'node:fs';
import path from 'node:path';

const [tplPath, mocksPath] = process.argv.slice(2);
const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
const mocks = JSON.parse(fs.readFileSync(mocksPath, 'utf8'));
const envPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../../.env');
const token = process.env.APIFY_TOKEN || fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('APIFY_TOKEN=')).split('=')[1].trim().replace(/^["']|["']$/g, '');

const byName = Object.fromEntries(tpl.nodes.map((n) => [n.name, n]));
if (Object.keys(byName).length !== tpl.nodes.length) throw new Error('duplicate node names');
for (const [from, c] of Object.entries(tpl.connections)) {
    if (!byName[from]) throw new Error(`connection from missing node ${from}`);
    for (const out of c.main) for (const t of out) if (!byName[t.node]) throw new Error(`connection to missing node ${t.node}`);
}
const start = tpl.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
const order = [start.name];
while (tpl.connections[order.at(-1)]) order.push(tpl.connections[order.at(-1)].main[0][0].node);
const workNodes = tpl.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').map((n) => n.name);
const unconnected = workNodes.filter((n) => !order.includes(n));
if (unconnected.length) throw new Error(`nodes not on the main path: ${unconnected}`);
console.log('structure ok:', order.join(' → '));

const outputs = {};
const $ = (name) => ({ first: () => outputs[name][0], all: () => outputs[name] });
const $now = { toFormat: (f) => f.replace('yyyy', '2026').replace('MM', '10').replace('dd', '10') };
const evalExpr = (v, json) => {
    if (typeof v !== 'string' || !v.startsWith('=')) return v;
    return v.slice(1).replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
        const r = new Function('$json', '$', '$now', `return (${e});`)(json, $, $now);
        return typeof r === 'string' ? r : JSON.stringify(r);
    });
};

let items = [{ json: {} }];
for (const name of order) {
    const n = byName[name];
    const p = n.parameters;
    if (n.type === 'n8n-nodes-base.scheduleTrigger') items = [{ json: { timestamp: new Date().toISOString() } }];
    else if (n.type === 'n8n-nodes-base.set') {
        items = items.map(() => ({ json: Object.fromEntries(p.assignments.assignments.map((a) => [a.name, a.value])) }));
    } else if (n.type === 'n8n-nodes-base.code') {
        const input = items;
        const fn = new Function('$input', '$', '$json', `return (async () => {${p.jsCode}\n})();`);
        items = await fn({ all: () => input, first: () => input[0] }, $, input[0]?.json);
    } else if (n.type === 'n8n-nodes-base.httpRequest') {
        const out = [];
        for (const it of items) {
            const url = evalExpr(p.url, it.json);
            const init = { method: p.method || 'GET', headers: { Authorization: `Bearer ${token}` } };
            if (p.sendBody) { init.body = evalExpr(p.jsonBody, it.json); init.headers['Content-Type'] = 'application/json'; JSON.parse(init.body); }
            console.log(`  ${name}: ${init.method} ${url.replace(/(token|signature)=[^&]+/g, '$1=***')}${init.body ? `\n    body ${init.body}` : ''}`);
            const t0 = Date.now();
            const res = await fetch(url, init);
            if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
            if (p.options?.response?.response?.responseFormat === 'file') {
                const buf = Buffer.from(await res.arrayBuffer());
                out.push({ json: { fileSize: buf.length, mimeType: res.headers.get('content-type'), isZip: buf.subarray(0, 2).toString() === 'PK' } });
            } else {
                const body = await res.json();
                for (const b of Array.isArray(body) ? body : [body]) out.push({ json: b });
            }
            console.log(`    ${res.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        }
        items = out;
    } else if (mocks[name]) {
        if (n.type === 'n8n-nodes-base.googleDrive') for (const it of items) if (!it.json.isZip) throw new Error('Drive got a non-ZIP file');
        items = mocks[name].map((j) => ({ json: j }));
        console.log(`  ${name}: mocked (${n.type})`);
        if (mocks[`${name}:show-input`] !== false && n.type === 'n8n-nodes-base.googleSheets' && p.operation === 'append') {
            console.log('    rows that would be appended:');
            for (const it of outputs[order[order.indexOf(name) - 1]]) console.log('    ' + JSON.stringify(it.json));
        }
    } else throw new Error(`no handler or mock for ${name} (${n.type})`);
    outputs[name] = items;
    console.log(`${name}: ${items.length} item(s)`);
}
console.log('TEMPLATE RUN OK');
