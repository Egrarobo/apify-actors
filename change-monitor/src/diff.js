import crypto from 'node:crypto';

// Values whose JSON is longer than this are stored in the state as a hash + short preview,
// so the state stays small no matter how large the scraped items are.
const MAX_STORED_VALUE_LENGTH = 1000;
const PREVIEW_LENGTH = 200;
const MAX_DIFF_DEPTH = 4;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMarker = (v) => isPlainObject(v) && typeof v['~h'] === 'string';

/** JSON.stringify with sorted object keys, so {a,b} and {b,a} produce the same string. */
export function stableStringify(value, markersAsHash = false) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        const s = JSON.stringify(value);
        return s === undefined ? 'null' : s;
    }
    if (typeof value.toJSON === 'function') return stableStringify(value.toJSON(), markersAsHash);
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, markersAsHash)).join(',')}]`;
    if (markersAsHash && isMarker(value)) return JSON.stringify(`~h:${value['~h']}`);
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], markersAsHash)}`).join(',')}}`;
}

/**
 * Hash of a normalized item. Shortened values count by their full-content hash only, so the preview
 * text never influences change detection.
 */
export const fingerprint = (normalized) => hash(stableStringify(normalized, true));

export const hash = (s) => crypto.createHash('sha1').update(s).digest('base64url').slice(0, 16);

/** Reads "a.b.c" from an object. A literal key containing dots (common in CSV headers) wins. */
export function getPath(obj, path) {
    if (obj == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function deletePath(obj, path) {
    if (!isPlainObject(obj)) return;
    if (Object.prototype.hasOwnProperty.call(obj, path)) {
        delete obj[path];
        return;
    }
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        o = o?.[parts[i]];
        if (!isPlainObject(o)) return;
    }
    delete o[parts[parts.length - 1]];
}

/** The part of the item that is compared between runs. */
export function project(item, { compareFields, ignoreFields }) {
    if (compareFields.length) {
        const out = {};
        for (const f of compareFields) {
            const v = getPath(item, f);
            if (v !== undefined) out[f] = v;
        }
        return out;
    }
    if (!ignoreFields.length) return item;
    const copy = structuredClone(item);
    for (const f of ignoreFields) deletePath(copy, f);
    return copy;
}

/**
 * Canonical, size-bounded copy: object keys sorted, and every non-object value whose JSON is long
 * replaced by { "~h": hash, "~p": preview }. Hashing the result is equivalent to hashing the full item.
 */
export function normalize(value) {
    if (isPlainObject(value)) {
        const out = {};
        for (const k of Object.keys(value).sort()) {
            if (value[k] !== undefined) out[k] = normalize(value[k]);
        }
        return out;
    }
    const s = stableStringify(value);
    if (s.length > MAX_STORED_VALUE_LENGTH) {
        return { '~h': hash(s), '~p': (typeof value === 'string' ? value : s).slice(0, PREVIEW_LENGTH) };
    }
    return value === undefined ? null : value;
}

/** Short human-readable version of a value for the output and notifications. */
export function preview(value, max = 300) {
    if (value === undefined) return null;
    if (isMarker(value)) return `${value['~p']}…`;
    if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
    if (value === null || typeof value !== 'object') return value;
    const s = stableStringify(value);
    return s.length > max ? `${s.slice(0, max)}…` : value;
}

/** Field-level differences between two normalized items. Nested objects produce paths like "price.amount". */
export function diff(before, after, { maxChanges = 20 } = {}) {
    const changes = [];
    let total = 0;
    const walk = (a, b, path, depth) => {
        if (isPlainObject(a) && isPlainObject(b) && !isMarker(a) && !isMarker(b) && depth < MAX_DIFF_DEPTH) {
            const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
            for (const k of keys) walk(a[k], b[k], path ? `${path}.${k}` : k, depth + 1);
            return;
        }
        if (stableStringify(a, true) === stableStringify(b, true)) return;
        total++;
        if (changes.length < maxChanges) changes.push({ field: path || '(item)', before: preview(a), after: preview(b) });
    };
    walk(before, after, '', 0);
    return { changes, totalChangedFields: total };
}

/** Unique key of an item. Returns null when none of the key fields has a value. */
export function keyOf(item, idFields, normalizedProjection) {
    if (!idFields.length) return `#${fingerprint(normalizedProjection)}`;
    const values = idFields.map((f) => getPath(item, f));
    if (values.every((v) => v === undefined || v === null || v === '')) return null;
    if (values.length === 1) return typeof values[0] === 'string' ? values[0].trim() : stableStringify(values[0]);
    return values.map((v) => (typeof v === 'string' ? v.trim() : stableStringify(v ?? null))).join(' | ');
}
