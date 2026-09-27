// Per-lookup cache in a named key-value store, so repeated runs don't hit the government servers again.
// Keys: "<source>-<lang>-<bin>" for BIN lookups, "name-<sha1>" for name searches.
// Found results live `cacheDays`; "not found" answers live at most 1 day (new companies appear quickly).
import crypto from 'node:crypto';
import { Actor } from 'apify';

export const CACHE_STORE_NAME = 'kazakhstan-company-lookup-cache';
const SCHEMA = 1;
const NOT_FOUND_MAX_MS = 24 * 3600 * 1000;

export async function openCache({ enabled, cacheDays, storeName = CACHE_STORE_NAME }) {
    const store = enabled ? await Actor.openKeyValueStore(storeName) : null;
    const maxAgeMs = cacheDays * 24 * 3600 * 1000;
    const stats = { hits: 0, misses: 0, writes: 0 };

    const safeKey = (k) => k.replace(/[^a-zA-Z0-9!\-_.'()]/g, '_').slice(0, 250);

    return {
        stats,
        /** Returns { value, fetchedAt } or null. */
        async get(key) {
            if (!store) return null;
            const entry = await store.getValue(safeKey(key)).catch(() => null);
            if (!entry || entry.schema !== SCHEMA) { stats.misses++; return null; }
            const age = Date.now() - new Date(entry.fetchedAt).getTime();
            const limit = entry.empty ? Math.min(maxAgeMs, NOT_FOUND_MAX_MS) : maxAgeMs;
            if (!(age >= 0 && age < limit)) { stats.misses++; return null; }
            stats.hits++;
            return entry;
        },
        async set(key, value, { empty = false, url = null } = {}) {
            if (!store) return;
            await store.setValue(safeKey(key), { schema: SCHEMA, fetchedAt: new Date().toISOString(), empty, url, value });
            stats.writes++;
        },
    };
}

export const binKey = (source, lang, bin) => `${source}-${lang}-${bin}`;
export const nameKey = (source, name, max, mode) => `name-${crypto.createHash('sha1').update(`${source}|${mode}|${max}|${name.toLowerCase()}`).digest('hex')}`;
