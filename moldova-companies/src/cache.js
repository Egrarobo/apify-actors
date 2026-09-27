// Parsed-data cache in a named key-value store: gzip'd NDJSON split into parts,
// so repeated runs don't re-download and re-parse the ~40 MB official file.
import zlib from 'node:zlib';
import { Actor, log } from 'apify';

export const CACHE_STORE_NAME = 'moldova-company-registry-cache';
export const SCHEMA_VERSION = 3;
const META_KEY = 'META';
const PART_RAW_BYTES = 12 * 1024 * 1024; // ~12 MB of JSON per part -> ~1 MB gzipped
const partKey = (i) => `DATA-${String(i).padStart(3, '0')}`;

export async function openCache() {
    return Actor.openKeyValueStore(CACHE_STORE_NAME);
}

export async function readMeta(store) {
    const meta = await store.getValue(META_KEY);
    return meta && meta.schemaVersion === SCHEMA_VERSION ? meta : null;
}

export async function touchMeta(store, meta, patch = {}) {
    const next = { ...meta, ...patch, checkedAt: new Date().toISOString() };
    await store.setValue(META_KEY, next);
    return next;
}

/** Consumes an async iterable of records, writes them to the cache and returns the new META. */
export async function writeCache(store, records, sourceInfo) {
    const old = await store.getValue(META_KEY);
    let buf = [];
    let bufBytes = 0;
    let parts = 0;
    let count = 0;
    const flush = async () => {
        if (!buf.length) return;
        const gz = zlib.gzipSync(Buffer.from(buf.join('')), { level: 6 });
        await store.setValue(partKey(parts), gz, { contentType: 'application/gzip' });
        parts++;
        buf = [];
        bufBytes = 0;
    };
    for await (const rec of records) {
        const line = `${JSON.stringify(rec)}\n`;
        buf.push(line);
        bufBytes += line.length;
        count++;
        if (bufBytes >= PART_RAW_BYTES) await flush();
    }
    await flush();
    if (!count) throw new Error('The official file contained no company rows. Not caching it.');
    for (let i = parts; i < (old?.parts ?? 0); i++) await store.setValue(partKey(i), null);
    const meta = {
        schemaVersion: SCHEMA_VERSION,
        sourceUrl: sourceInfo.url,
        lastModified: sourceInfo.lastModified ?? null,
        etag: sourceInfo.etag ?? null,
        dataDate: sourceInfo.dataDate ?? null,
        recordCount: count,
        parts,
        builtAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
    };
    await store.setValue(META_KEY, meta);
    log.info(`Cached ${count} companies in ${parts} part(s) (store "${CACHE_STORE_NAME}").`);
    return meta;
}

/** Async iterator over all cached records, one part in memory at a time. */
export async function* readCache(store, meta) {
    for (let i = 0; i < meta.parts; i++) {
        const gz = await store.getValue(partKey(i));
        if (!gz) throw new Error(`Cache part ${partKey(i)} is missing. Run again with "forceRefresh": true.`);
        const text = zlib.gunzipSync(Buffer.isBuffer(gz) ? gz : Buffer.from(gz)).toString('utf8');
        let start = 0;
        while (start < text.length) {
            let end = text.indexOf('\n', start);
            if (end === -1) end = text.length;
            if (end > start) yield JSON.parse(text.slice(start, end));
            start = end + 1;
        }
    }
}
