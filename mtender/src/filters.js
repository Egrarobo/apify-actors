/**
 * Text folding used for keyword and buyer matching: case-insensitive, Romanian diacritics removed
 * (ă â î ș ş ț ţ → a a i s s t t), Russian ё → е, punctuation collapsed to spaces.
 */
export function fold(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

/** Date used for "published in range" checks (see normalize.js for how datePublished is chosen). */
export const publicationDate = (t) => t.datePublished ?? t.dateCreated ?? null;

/**
 * @returns {(tender) => { ok: boolean, matchedKeywords: string[] }}
 */
export function buildMatcher(f) {
    const keywords = f.keywords.map((k) => ({ raw: k, folded: fold(k) })).filter((k) => k.folded);
    const exclude = f.excludeKeywords.map(fold).filter(Boolean);
    const statuses = new Set(f.statuses.map((s) => s.toLowerCase()));
    const methods = f.methods.map((m) => m.toLowerCase());
    const categories = new Set(f.categories.map((c) => c.toLowerCase()));
    const cpvPrefixes = f.cpvPrefixes.map(digits).filter(Boolean);
    const buyerNames = f.buyerNames.map(fold).filter(Boolean);
    const buyerIdnos = f.buyerIdnos.map(digits).filter(Boolean);
    const currency = f.currency ? f.currency.toUpperCase() : null;
    const publishedFromMs = f.publishedFrom ? Date.parse(f.publishedFrom) : null;
    const publishedToMs = f.publishedTo ? Date.parse(f.publishedTo) : null;

    return (t) => {
        const no = { ok: false, matchedKeywords: [] };
        if (statuses.size && !statuses.has(String(t.status ?? '').toLowerCase())) return no;
        if (methods.length) {
            const m = [t.method, t.methodDetails].filter(Boolean).map((x) => x.toLowerCase());
            if (!methods.some((x) => m.includes(x))) return no;
        }
        if (categories.size && !categories.has(String(t.category ?? '').toLowerCase())) return no;
        if (cpvPrefixes.length) {
            const codes = t.cpvCodes.map(digits);
            if (!cpvPrefixes.some((p) => codes.some((c) => c.startsWith(p)))) return no;
        }
        if (buyerNames.length) {
            const b = fold(t.buyer);
            if (!buyerNames.some((n) => b.includes(n))) return no;
        }
        if (buyerIdnos.length) {
            const ids = [digits(t.buyerIdno), digits(t.buyerId)].filter(Boolean);
            if (!buyerIdnos.some((x) => ids.includes(x))) return no;
        }
        if (currency) {
            if (t.value === null) {
                if (!f.includeWithoutValue) return no;
            } else if ((t.currency ?? '').toUpperCase() !== currency) return no;
        }
        if (f.minValue !== null || f.maxValue !== null) {
            if (t.value === null) {
                if (!f.includeWithoutValue) return no;
            } else {
                if (f.minValue !== null && t.value < f.minValue) return no;
                if (f.maxValue !== null && t.value > f.maxValue) return no;
            }
        }
        if (publishedFromMs !== null || publishedToMs !== null) {
            const p = Date.parse(publicationDate(t) ?? '');
            if (!Number.isFinite(p)) return no;
            if (publishedFromMs !== null && p < publishedFromMs) return no;
            if (publishedToMs !== null && p > publishedToMs) return no;
        }
        let matchedKeywords = [];
        if (keywords.length || exclude.length) {
            const hay = ` ${fold([
                t.title, t.description, t.cpvDescription,
                ...t.lots.flatMap((l) => [l.title, l.description]),
                ...t.items.flatMap((i) => [i.description, i.cpvDescription]),
            ].filter(Boolean).join(' \n '))} `;
            if (exclude.some((x) => hay.includes(x))) return no;
            matchedKeywords = keywords.filter((k) => hay.includes(k.folded)).map((k) => k.raw);
            if (keywords.length) {
                if (f.keywordsMatch === 'all' ? matchedKeywords.length < keywords.length : !matchedKeywords.length) return no;
            }
        }
        return { ok: true, matchedKeywords };
    };
}
