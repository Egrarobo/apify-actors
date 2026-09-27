// Structure-aware chunking for RAG: by heading (sections, oversized ones sub-split) or fixed size with overlap.
// Chunk boundaries fall between blocks (paragraphs, list groups, tables); oversized blocks are split by
// sentences/words, and oversized tables by rows with the header row repeated in every piece.

const SENTENCE_RE = /(?<=[.!?…。])\s+(?=[\p{Lu}\p{N}"'“(])/u;

/**
 * @param {Array<{md:string, heading:number, headingText?:string, isTable?:boolean, page:number|null, marker?:boolean}>} blocks
 * @param {{mode:'none'|'heading'|'fixed', size:number, overlap:number, measure:(s:string)=>number, maxHeadingLevel?:number}} o
 * @returns {Array<{md:string, pageStart:number|null, pageEnd:number|null, headings:string[]}>}
 */
export function chunkBlocks(blocks, o) {
    const { mode, measure } = o;
    const size = Math.max(50, o.size || 800);
    const overlap = Math.max(0, Math.min(o.overlap || 0, Math.floor(size / 2)));
    const maxLevel = o.maxHeadingLevel ?? 3;

    // Annotate every block with the heading path in effect at that block.
    const stack = [];
    const annotated = blocks.map((b) => {
        if (b.heading) {
            while (stack.length && stack[stack.length - 1].level >= b.heading) stack.pop();
            stack.push({ level: b.heading, text: b.headingText });
        }
        return { ...b, path: stack.map((s) => s.text) };
    });

    if (mode === 'none') return [makeChunk(annotated)];

    if (mode === 'heading') {
        const sections = [];
        let cur = [];
        for (const b of annotated) {
            const startsSection = b.heading && b.heading <= maxLevel;
            // Start a new section at a heading, unless the current section holds only headings/markers.
            if (startsSection && cur.some((x) => !x.heading && !x.marker)) { sections.push(cur); cur = []; }
            cur.push(b);
        }
        if (cur.length) sections.push(cur);
        return sections.flatMap((sec) => packFixed(sec, size, overlap, measure));
    }
    return packFixed(annotated, size, overlap, measure);
}

function makeChunk(parts) {
    const pages = parts.flatMap((p) => [p.page, p.pageEnd]).filter((p) => p !== null && p !== undefined);
    const firstContent = parts.find((p) => !p.marker && !p.heading && !p.isOverlap) ?? parts.find((p) => !p.marker) ?? parts[0];
    return {
        md: parts.map((p) => p.md).join('\n\n'),
        pageStart: pages.length ? Math.min(...pages) : null,
        pageEnd: pages.length ? Math.max(...pages) : null,
        headings: firstContent?.path ?? [],
    };
}

function packFixed(blocks, size, overlap, measure) {
    const chunks = [];
    let cur = [];
    let curSize = 0;
    const sep = Math.max(1, measure('\n\n')); // blocks are joined with a blank line
    const isContent = (p) => !p.marker && !p.isOverlap && !p.heading;
    const hasContent = () => cur.some(isContent);

    const emit = () => {
        const carry = [];
        while (cur.length && cur[cur.length - 1].marker) carry.unshift(cur.pop()); // don't end on a page marker
        if (cur.some(isContent)) {
            const chunk = makeChunk(cur);
            chunks.push(chunk);
            const tail = overlap ? tailText(cur.filter((p) => !p.marker && !p.heading).map((p) => p.md).join('\n\n'), overlap, measure) : '';
            const last = cur[cur.length - 1];
            cur = tail ? [{ md: tail, page: last.page, path: last.path, isOverlap: true }] : [];
        } else cur = [];
        cur.push(...carry);
        curSize = cur.reduce((s, p) => s + measure(p.md) + sep, 0);
    };

    const push = (p, s) => { cur.push(p); curSize += s; };
    for (const b of blocks) {
        const s = measure(b.md) + sep;
        if (b.marker || curSize + s <= size) { push(b, s); continue; }
        const minFill = Math.floor(size * 0.2);
        // Oversized block: split it anyway, filling what is left of the current chunk first.
        // Block that does not fit: start a new chunk; if it still does not fit next to the
        // overlap/heading prefix, split it so no chunk exceeds the size limit.
        if (hasContent() && (s <= size || size - curSize - sep < minFill)) {
            emit();
            if (curSize + s <= size) { push(b, s); continue; }
        }
        const restLimit = size - sep - (overlap ? overlap + sep : 0); // later pieces start after an overlap
        const pieces = splitBlock(b, restLimit, measure, Math.max(minFill, size - curSize - sep));
        for (const p of pieces) {
            const ps = measure(p.md) + sep;
            if (curSize + ps > size && hasContent()) emit();
            push(p, ps);
        }
    }
    if (hasContent()) emit();
    return chunks;
}

/** Last `overlap` units of text, starting at a word boundary. */
function tailText(text, overlap, measure) {
    const words = text.split(/(\s+)/);
    let out = '';
    for (let i = words.length - 1; i >= 0; i--) {
        const next = words[i] + out;
        if (measure(next) > overlap) break;
        out = next;
    }
    out = out.trim();
    // Prefer starting at a sentence boundary if one is in the first half of the tail.
    const m = out.slice(0, Math.floor(out.length / 2)).match(/[.!?…]\s+(?=[\p{Lu}\p{N}])/u);
    if (m) out = out.slice(m.index + m[0].length);
    // Never let a tail start in the middle of a table row.
    return out.replace(/^[^\n]*\|[^\n]*\n/, '').trim();
}

function splitBlock(b, size, measure, firstLimit = size) {
    const mk = (md) => ({ ...b, md, heading: 0 });
    if (b.isTable) {
        const lines = b.md.split('\n');
        const header = lines.slice(0, 2).join('\n');
        const out = [];
        let cur = [];
        for (const row of lines.slice(2)) {
            const cand = [header, ...cur, row].join('\n');
            if (cur.length && measure(cand) > (out.length ? size : firstLimit)) { out.push(mk([header, ...cur].join('\n'))); cur = []; }
            cur.push(row);
        }
        if (cur.length) out.push(mk([header, ...cur].join('\n')));
        return out;
    }
    // Split by sentences, then by words for very long sentences.
    const units = b.md.split(SENTENCE_RE).flatMap((s) => (measure(s) > size ? wordPieces(s, size, measure) : [s]));
    const out = [];
    let cur = '';
    for (const u of units) {
        const cand = cur ? `${cur} ${u}` : u;
        if (cur && measure(cand) > (out.length ? size : firstLimit)) { out.push(mk(cur)); cur = u; } else cur = cand;
    }
    if (cur) out.push(mk(cur));
    return out;
}

function wordPieces(s, size, measure) {
    const words = s.split(/\s+/);
    const out = [];
    let cur = '';
    for (const w of words) {
        const cand = cur ? `${cur} ${w}` : w;
        if (cur && measure(cand) > size) { out.push(cur); cur = w; } else cur = cand;
    }
    if (cur) out.push(cur);
    // A single "word" longer than the limit (e.g. base64): hard-cut it.
    return out.flatMap((p) => {
        if (measure(p) <= size) return [p];
        const parts = [];
        const step = Math.max(20, Math.floor(p.length * (size / measure(p))));
        for (let i = 0; i < p.length; i += step) parts.push(p.slice(i, i + step));
        return parts;
    });
}
