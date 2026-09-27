// Minimal low-memory XLSX row reader.
// Reads the shared-strings table first (random access in the ZIP, so the order of entries in the
// file does not matter), then streams each worksheet with a SAX parser. Peak memory is roughly the
// size of the shared strings, instead of the whole workbook.
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';

const openZip = (file) => new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
});

async function listEntries(zip) {
    return new Promise((resolve, reject) => {
        const map = new Map();
        zip.on('entry', (e) => { map.set(e.fileName, e); zip.readEntry(); });
        zip.on('end', () => resolve(map));
        zip.on('error', reject);
        zip.readEntry();
    });
}

const openStream = (zip, entry) => new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)));
});

/** Feeds an entry through a SAX parser; `onChunk` is awaited after each chunk (lets callers yield rows). */
async function* saxEntry(zip, entry, setup) {
    const parser = new SaxesParser();
    const out = [];
    setup(parser, out);
    const stream = await openStream(zip, entry);
    const dec = new StringDecoder('utf8');
    for await (const chunk of stream) {
        parser.write(dec.write(chunk));
        if (out.length) yield out.splice(0, out.length);
    }
    parser.write(dec.end());
    parser.close();
    if (out.length) yield out.splice(0, out.length);
}

async function readText(zip, entry) {
    const stream = await openStream(zip, entry);
    const bufs = [];
    for await (const c of stream) bufs.push(c);
    return Buffer.concat(bufs).toString('utf8');
}

async function readSharedStrings(zip, entry) {
    const sst = [];
    if (!entry) return sst;
    // eslint-disable-next-line no-unused-vars
    for await (const _ of saxEntry(zip, entry, (p) => {
        let cur = null;
        let inT = false;
        let inPhonetic = 0;
        p.on('opentag', (t) => {
            if (t.name === 'si') cur = '';
            else if (t.name === 'rPh') inPhonetic++;
            else if (t.name === 't' && !inPhonetic) inT = true;
        });
        p.on('closetag', (t) => {
            if (t.name === 'si') { sst.push(cur); cur = null; } else if (t.name === 'rPh') inPhonetic--;
            else if (t.name === 't') inT = false;
        });
        p.on('text', (x) => { if (inT && cur !== null) cur += x; });
    })) { /* strings are collected into sst */ }
    return sst;
}

const colIndex = (ref) => {
    let n = 0;
    for (const ch of ref) {
        const c = ch.charCodeAt(0);
        if (c < 65 || c > 90) break;
        n = n * 26 + (c - 64);
    }
    return n - 1;
};

async function sheetPaths(zip, entries) {
    const wb = entries.get('xl/workbook.xml');
    const rels = entries.get('xl/_rels/workbook.xml.rels');
    const fallback = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
        .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
    if (!wb || !rels) return fallback;
    const relXml = await readText(zip, rels);
    const target = new Map([...relXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
        const id = m[0].match(/\bId="([^"]+)"/)?.[1];
        const t = m[0].match(/\bTarget="([^"]+)"/)?.[1];
        return [id, t];
    }));
    const wbXml = await readText(zip, wb);
    const paths = [...wbXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
        const t = target.get(m[0].match(/\br:id="([^"]+)"/)?.[1]);
        if (!t) return null;
        return t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
    }).filter((p) => p && entries.has(p));
    return paths.length ? paths : fallback;
}

/** Yields { sheetNo, rowNo, cells } for every row of every worksheet. Cells are strings/numbers/booleans. */
export async function* readXlsxRows(file) {
    const zip = await openZip(file);
    try {
        const entries = await listEntries(zip);
        const sst = await readSharedStrings(zip, entries.get('xl/sharedStrings.xml'));
        const sheets = await sheetPaths(zip, entries);
        let sheetNo = 0;
        for (const sp of sheets) {
            sheetNo++;
            let rowNo = 0;
            for await (const rows of saxEntry(zip, entries.get(sp), (p, out) => {
                let cells = null;
                let col = -1;
                let type = null;
                let val = '';
                let inV = false;
                let inIsT = false;
                let rowR = 0;
                p.on('opentag', (t) => {
                    switch (t.name) {
                        case 'row':
                            cells = [];
                            col = -1;
                            rowR = Number(t.attributes.r) || 0;
                            break;
                        case 'c':
                            col = t.attributes.r ? colIndex(String(t.attributes.r)) : col + 1;
                            type = t.attributes.t ?? 'n';
                            val = '';
                            break;
                        case 'v': inV = true; break;
                        case 't': if (type === 'inlineStr') inIsT = true; break;
                        default:
                    }
                });
                p.on('text', (x) => { if (inV || inIsT) val += x; });
                p.on('closetag', (t) => {
                    switch (t.name) {
                        case 'v': inV = false; break;
                        case 't': inIsT = false; break;
                        case 'c': {
                            if (!cells || val === '') break;
                            let v;
                            if (type === 's') v = sst[Number(val)] ?? '';
                            else if (type === 'b') v = val === '1';
                            else if (type === 'n') v = Number(val);
                            else v = val; // str, inlineStr, e, d
                            cells[col] = v;
                            break;
                        }
                        case 'row':
                            rowNo = rowR || rowNo + 1;
                            out.push({ sheetNo, rowNo, cells });
                            cells = null;
                            break;
                        default:
                    }
                });
            })) {
                for (const r of rows) yield r;
            }
        }
    } finally {
        zip.close();
    }
}
