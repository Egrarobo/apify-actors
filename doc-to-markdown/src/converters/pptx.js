// PPTX -> Markdown: one section per slide (in presentation order) with title, text boxes, bullet levels,
// tables, and speaker notes.
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { mdTable } from '../markdown.js';

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', trimValues: false, parseTagValue: false, processEntities: true });
const plain = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, isArray: (n) => n === 'Relationship' || n === 'p:sldId' });

const tagOf = (n) => Object.keys(n).find((k) => k !== ':@');
const kids = (n) => n[tagOf(n)] ?? [];
const attrs = (n) => n[':@'] ?? {};
const child = (n, t) => kids(n).find((c) => tagOf(c) === t);
function* descendants(n, t) {
    for (const c of Array.isArray(n) ? n : kids(n)) {
        if (typeof c !== 'object' || c === null) continue;
        if (tagOf(c) === t) yield c;
        if (tagOf(c) !== '#text') yield* descendants(c, t);
    }
}

function paragraphText(p) {
    let s = '';
    for (const c of kids(p)) {
        const t = tagOf(c);
        if (t === 'a:r' || t === 'a:fld') {
            const tt = child(c, 'a:t');
            if (tt) s += kids(tt).map((x) => x['#text'] ?? '').join('');
        } else if (t === 'a:br') s += ' ';
    }
    return s.replace(/\s+/g, ' ').trim();
}

function shapeMarkdown(sp) {
    const ph = [...descendants(child(sp, 'p:nvSpPr') ?? {}, 'p:ph')][0];
    const phType = ph ? attrs(ph).type ?? 'body' : null;
    if (['sldNum', 'dt', 'ftr', 'hdr'].includes(phType)) return { skip: true };
    const txBody = child(sp, 'p:txBody');
    if (!txBody) return { skip: true };
    const paras = kids(txBody).filter((c) => tagOf(c) === 'a:p');
    const isTitle = phType === 'title' || phType === 'ctrTitle';
    const bodyPh = phType === 'body' || phType === 'obj';
    const lines = [];
    for (const p of paras) {
        const text = paragraphText(p);
        if (!text) continue;
        const pPr = child(p, 'a:pPr');
        const lvl = Number(pPr ? attrs(pPr).lvl ?? 0 : 0);
        const explicitNone = pPr && child(pPr, 'a:buNone');
        const explicitBullet = pPr && (child(pPr, 'a:buChar') || child(pPr, 'a:buAutoNum'));
        const bullet = !isTitle && !explicitNone && (explicitBullet || bodyPh);
        lines.push(bullet ? `${'  '.repeat(Math.min(lvl, 4))}- ${text}` : text);
    }
    if (!lines.length) return { skip: true };
    if (isTitle) return { title: lines.join(' ') };
    // Bulleted lines stay together; plain paragraphs get blank lines between them.
    return { md: lines.reduce((acc, l) => (acc ? acc + (/^\s*- /.test(l) ? '\n' : '\n\n') + l : l), '') };
}

function tableMarkdown(tbl) {
    const rows = [...descendants(tbl, 'a:tr')].map((tr) => kids(tr).filter((c) => tagOf(c) === 'a:tc')
        .map((tc) => [...descendants(tc, 'a:p')].map(paragraphText).filter(Boolean).join(' ')));
    return mdTable(rows);
}

function walkTree(nodes, out) {
    for (const n of nodes) {
        const t = tagOf(n);
        if (t === 'p:sp') out.push(shapeMarkdown(n));
        else if (t === 'p:grpSp') walkTree(kids(n), out);
        else if (t === 'p:graphicFrame') {
            const tbl = [...descendants(n, 'a:tbl')][0];
            if (tbl) out.push({ md: tableMarkdown(tbl) });
        }
    }
}

async function readRels(zip, partPath) {
    const relPath = path.posix.join(path.posix.dirname(partPath), '_rels', `${path.posix.basename(partPath)}.rels`);
    const xml = await zip.file(relPath)?.async('string');
    if (!xml) return [];
    return (plain.parse(xml).Relationships?.Relationship ?? []).map((r) => ({
        id: r.Id, type: r.Type, target: path.posix.normalize(path.posix.join(path.posix.dirname(partPath), r.Target)),
    }));
}

export async function convertPptx(buffer, { maxPages = 0, includeNotes = true } = {}) {
    const zip = await JSZip.loadAsync(buffer);
    const presXml = await zip.file('ppt/presentation.xml')?.async('string');
    if (!presXml) throw new Error('Not a valid PowerPoint (.pptx) file.');
    const pres = plain.parse(presXml);
    const rels = await readRels(zip, 'ppt/presentation.xml');
    const relById = new Map(rels.map((r) => [r.id, r]));
    let slidePaths = (pres['p:presentation']?.['p:sldIdLst']?.['p:sldId'] ?? [])
        .map((s) => relById.get(s['r:id'])?.target).filter(Boolean);
    if (!slidePaths.length) {
        slidePaths = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
            .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
    }
    const totalPages = slidePaths.length;
    const warnings = [];
    const n = maxPages ? Math.min(maxPages, totalPages) : totalPages;
    if (n < totalPages) warnings.push(`Only the first ${n} of ${totalPages} slides were processed.`);

    const pages = [];
    let firstTitle = '';
    for (let i = 0; i < n; i++) {
        const slidePath = slidePaths[i];
        const xml = await zip.file(slidePath)?.async('string');
        if (!xml) continue;
        const tree = parser.parse(xml);
        const spTree = [...descendants(tree, 'p:spTree')][0];
        const parts = [];
        if (spTree) walkTree(kids(spTree), parts);
        const title = parts.find((p) => p.title)?.title ?? '';
        if (!firstTitle && title) firstTitle = title;
        const body = parts.filter((p) => p.md).map((p) => p.md);

        let notes = '';
        if (includeNotes) {
            const notesRel = (await readRels(zip, slidePath)).find((r) => r.type.endsWith('/notesSlide'));
            const notesXml = notesRel && await zip.file(notesRel.target)?.async('string');
            if (notesXml) {
                const nTree = parser.parse(notesXml);
                const texts = [];
                for (const sp of descendants(nTree, 'p:sp')) {
                    const ph = [...descendants(child(sp, 'p:nvSpPr') ?? {}, 'p:ph')][0];
                    if (!ph || attrs(ph).type !== 'body') continue;
                    for (const p of descendants(sp, 'a:p')) { const t = paragraphText(p); if (t) texts.push(t); }
                }
                notes = texts.join(' ');
            }
        }
        const md = [`## Slide ${i + 1}${title ? `: ${title}` : ''}`, ...body, notes ? `**Speaker notes:** ${notes}` : '']
            .filter(Boolean).join('\n\n');
        pages.push({ page: i + 1, md });
    }

    let title = '';
    const core = await zip.file('docProps/core.xml')?.async('string');
    if (core) title = String(plain.parse(core)?.['cp:coreProperties']?.['dc:title'] ?? '').trim();
    return { title: title || firstTitle, totalPages, pages, warnings };
}
