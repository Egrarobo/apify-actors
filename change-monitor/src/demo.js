import { project, normalize, fingerprint, diff, keyOf } from './diff.js';

// Two small built-in snapshots of the same (fictional) shop catalog, "yesterday" and "today".
// Used when the Actor is started without any data source, so a first click in Console, the
// Apify Store "Try" button and the daily Store health check all get a real, non-empty result.
export const DEMO_PREVIOUS = [
    { url: 'https://shop.example.com/p/1', name: 'Blue mug', price: 12.5, inStock: true, scrapedAt: '2026-10-07T08:00:00Z' },
    { url: 'https://shop.example.com/p/2', name: 'Red mug', price: 9.9, inStock: true, scrapedAt: '2026-10-07T08:00:00Z' },
    { url: 'https://shop.example.com/p/3', name: 'Green mug', price: 11, inStock: true, scrapedAt: '2026-10-07T08:00:00Z' },
    { url: 'https://shop.example.com/p/4', name: 'Yellow mug', price: 10, inStock: true, scrapedAt: '2026-10-07T08:00:00Z' },
];
export const DEMO_CURRENT = [
    { url: 'https://shop.example.com/p/1', name: 'Blue mug', price: 10.99, inStock: true, scrapedAt: '2026-10-08T08:00:00Z' },
    { url: 'https://shop.example.com/p/2', name: 'Red mug', price: 9.9, inStock: false, scrapedAt: '2026-10-08T08:00:00Z' },
    { url: 'https://shop.example.com/p/3', name: 'Green mug', price: 11, inStock: true, scrapedAt: '2026-10-08T08:00:00Z' },
    { url: 'https://shop.example.com/p/5', name: 'Black mug', price: 14, inStock: true, scrapedAt: '2026-10-08T08:00:00Z' },
];

/** Compares the two demo snapshots in memory. No state is read or written. */
export function runDemoComparison({ idFields, compareFields, ignoreFields, maxChangesPerItem }) {
    const keyFields = idFields.length ? idFields : ['url'];
    const ignore = compareFields.length ? [] : [...new Set([...ignoreFields, 'scrapedAt'])];
    const index = (items) => {
        const map = new Map();
        for (const item of items) {
            const norm = normalize(project(item, { compareFields, ignoreFields: ignore }));
            map.set(keyOf(item, keyFields, norm), { item, norm, hash: fingerprint(norm) });
        }
        return map;
    };
    const prev = index(DEMO_PREVIOUS);
    const next = index(DEMO_CURRENT);
    const changes = [];
    let unchanged = 0;
    for (const [key, cur] of next) {
        const old = prev.get(key);
        if (!old) {
            changes.push({ changeType: 'new', key, changedFields: [], item: cur.item });
        } else if (old.hash !== cur.hash) {
            const { changes: fieldChanges, totalChangedFields } = diff(old.norm, cur.norm, { maxChanges: maxChangesPerItem });
            changes.push({
                changeType: 'changed',
                key,
                changedFields: fieldChanges.map((c) => c.field),
                changes: fieldChanges,
                totalChangedFields,
                item: cur.item,
            });
        } else {
            unchanged++;
        }
    }
    for (const [key, old] of prev) {
        if (!next.has(key)) changes.push({ changeType: 'removed', key, changedFields: [], item: old.item });
    }
    return { changes, unchanged, previousItems: prev.size, currentItems: next.size };
}
