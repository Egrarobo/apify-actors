// Matching logic: IDNO lookups, name search (contains / exact / fuzzy) and filters.
import { norm, nameTokens, legalFormMatches } from './normalize.js';

export const FILTER_KEYS = ['legalForms', 'statuses', 'registeredFrom', 'registeredTo', 'activityCodes', 'location', 'locations'];
export const STATUS_VALUES = ['active', 'liquidated', 'in_process', 'unknown', 'other'];

const asArray = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

export function buildFilters(filters = {}) {
    if (typeof filters !== 'object' || Array.isArray(filters)) throw new Error('"filters" must be an object, e.g. {"legalForms": ["SRL"], "statuses": ["active"]}.');
    const unknown = Object.keys(filters).filter((k) => !FILTER_KEYS.includes(k));
    if (unknown.length) throw new Error(`Unknown filter(s): ${unknown.join(', ')}. Allowed: ${FILTER_KEYS.filter((k) => k !== 'locations').join(', ')}.`);
    const date = (v, k) => {
        if (!v) return null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`filters.${k} must be a date in YYYY-MM-DD format, got "${v}".`);
        return String(v);
    };
    const statuses = asArray(filters.statuses).map((s) => String(s).toLowerCase());
    const bad = statuses.filter((s) => !STATUS_VALUES.includes(s));
    if (bad.length) throw new Error(`filters.statuses: unknown value(s) ${bad.join(', ')}. Allowed: ${STATUS_VALUES.join(', ')}.`);
    const codes = asArray(filters.activityCodes).map((c) => String(c).trim().replace(/^[A-Za-z]\s*/, ''));
    const badCodes = codes.filter((c) => !/^\d{2}(\.\d{1,2}){0,2}$/.test(c));
    if (badCodes.length) throw new Error(`filters.activityCodes must look like "62", "62.01" or "47.19.1", got: ${badCodes.join(', ')}.`);
    const f = {
        legalForms: asArray(filters.legalForms).map(String).filter(Boolean),
        statuses,
        from: date(filters.registeredFrom, 'registeredFrom'),
        to: date(filters.registeredTo, 'registeredTo'),
        codes,
        locations: [...asArray(filters.location), ...asArray(filters.locations)].map(norm).filter(Boolean),
    };
    f.active = !!(f.legalForms.length || f.statuses.length || f.from || f.to || f.codes.length || f.locations.length);
    return f;
}

export function passesFilters(rec, f) {
    if (!f.active) return true;
    if (f.legalForms.length && !f.legalForms.some((lf) => legalFormMatches(rec.legalForm, lf))) return false;
    if (f.statuses.length && !f.statuses.includes(rec.statusCategory)) return false;
    if (f.from && (!rec.registrationDate || rec.registrationDate < f.from)) return false;
    if (f.to && (!rec.registrationDate || rec.registrationDate > f.to)) return false;
    if (f.codes.length && !f.codes.some((c) => rec.activityCodes.some((rc) => rc === c || rc.startsWith(`${c}.`)))) return false;
    if (f.locations.length) {
        const addr = norm(rec.address);
        if (!f.locations.some((l) => addr.includes(l))) return false;
    }
    return true;
}

// ---------- Name matching ----------

// Optimal-string-alignment distance: Levenshtein + adjacent transpositions ("sotf" -> "soft" = 1).
function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
            cur[j] = v;
        }
        prev2 = prev;
        prev = cur;
    }
    return prev[b.length];
}
const similarity = (a, b) => 1 - editDistance(a, b) / Math.max(a.length, b.length);

export function buildNameQuery(q, mode, threshold) {
    const tokens = nameTokens(q);
    if (!tokens.length) throw new Error(`Name query "${q}" is empty after removing legal-form words like SRL/SA. Use a more specific name.`);
    return { original: q, tokens, joined: tokens.join(' '), compact: tokens.join(''), mode, threshold };
}

/** Returns a score in (0, 1] if the company name matches the query, otherwise 0. */
export function scoreName(nameNorm, q) {
    const tokens = nameNorm.tokens;
    const joined = nameNorm.joined;
    const compact = nameNorm.compact;
    if (joined === q.joined || compact === q.compact) return 1;
    if (q.mode === 'exact') return 0;
    const allContained = q.tokens.every((t) => joined.includes(t)) || compact.includes(q.compact);
    if (allContained) {
        const startsWith = joined.startsWith(q.joined) || compact.startsWith(q.compact);
        const wholeWords = q.tokens.every((t) => tokens.includes(t));
        // Prefer names that are short and start with / consist of the query words.
        const lengthFactor = Math.min(1, q.compact.length / Math.max(1, compact.length));
        return +(0.6 + (startsWith ? 0.15 : 0) + (wholeWords ? 0.1 : 0) + 0.14 * lengthFactor).toFixed(3);
    }
    if (q.mode !== 'fuzzy') return 0;
    // Fuzzy: each query word is compared with the most similar word in the name.
    let sum = 0;
    for (const t of q.tokens) {
        let best = 0;
        for (const nt of tokens) {
            if (Math.abs(nt.length - t.length) > Math.max(2, t.length * 0.5)) continue;
            const s = nt.startsWith(t) ? 0.95 : similarity(t, nt);
            if (s > best) best = s;
            if (best === 1) break;
        }
        sum += best;
    }
    const s = sum / q.tokens.length;
    const whole = similarity(q.compact, compact);
    const score = Math.max(s, whole);
    return score >= q.threshold ? +(score * 0.6).toFixed(3) : 0;
}

export function prepareName(name) {
    const tokens = nameTokens(name);
    return { tokens, joined: tokens.join(' '), compact: tokens.join('') };
}
