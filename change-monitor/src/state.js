import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Actor, log } from 'apify';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Uncompressed JSON per stored part. Gzipped parts end up far below the key-value store record limit.
const PART_TARGET_BYTES = 8 * 1024 * 1024;

export const slugify = (s) => String(s).trim().replace(/[^a-zA-Z0-9!\-_.'()]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'default';

/**
 * State of one monitor = the snapshot of the previous run, stored as
 *   <prefix>-meta               JSON: settings, counts, generation, number of parts
 *   <prefix>-g<gen>-p<n>        gzipped JSON arrays of [key, hash, compactItem?]
 * New parts are written under a new generation before the meta record is switched,
 * so a crash mid-save never corrupts the previous snapshot.
 */
export class StateStore {
    constructor(storeName, monitorName) {
        this.storeName = storeName;
        this.prefix = `state-${slugify(monitorName)}`;
    }

    async open() {
        // forceCloud keeps the state on the Apify platform even when the Actor runs locally with a token.
        this.kvs = await Actor.openKeyValueStore(this.storeName, { forceCloud: Actor.isAtHome() });
        return this;
    }

    get metaKey() { return `${this.prefix}-meta`; }

    partKey(gen, i) { return `${this.prefix}-g${gen}-p${String(i).padStart(4, '0')}`; }

    async loadMeta() {
        return this.kvs.getValue(this.metaKey);
    }

    /** Returns Map<key, [hash, compactItem|undefined]>. */
    async loadEntries(meta) {
        const map = new Map();
        for (let i = 0; i < meta.parts; i++) {
            const buf = await this.kvs.getValue(this.partKey(meta.generation, i));
            if (!buf) throw new Error(`The saved state of this monitor is incomplete (missing part ${i + 1} of ${meta.parts}). Run once with "Start over" enabled to create a new baseline.`);
            const entries = JSON.parse((await gunzip(Buffer.from(buf))).toString('utf8'));
            for (const [key, h, snap] of entries) map.set(key, [h, snap]);
        }
        return map;
    }

    async save(entries, metaFields, previousMeta) {
        const generation = (previousMeta?.generation ?? 0) + 1;
        let parts = 0;
        let chunk = [];
        let size = 0;
        const flush = async () => {
            if (!chunk.length && parts > 0) return;
            const body = await gzip(Buffer.from(`[${chunk.join(',')}]`, 'utf8'));
            await this.kvs.setValue(this.partKey(generation, parts), body, { contentType: 'application/gzip' });
            parts++;
            chunk = [];
            size = 0;
        };
        for (const [key, [h, snap]] of entries) {
            const s = JSON.stringify(snap === undefined ? [key, h] : [key, h, snap]);
            chunk.push(s);
            size += s.length + 1;
            if (size >= PART_TARGET_BYTES) await flush();
        }
        await flush();

        const meta = { ...metaFields, version: 1, generation, parts, itemCount: entries.size, updatedAt: new Date().toISOString() };
        await this.kvs.setValue(this.metaKey, meta);

        if (previousMeta) {
            for (let i = 0; i < previousMeta.parts; i++) {
                try {
                    await this.kvs.setValue(this.partKey(previousMeta.generation, i), null);
                } catch (err) {
                    log.debug(`Could not delete old state part: ${err.message}`);
                }
            }
        }
        return meta;
    }

    async reset(previousMeta) {
        await this.kvs.setValue(this.metaKey, null);
        if (!previousMeta) return;
        for (let i = 0; i < previousMeta.parts; i++) await this.kvs.setValue(this.partKey(previousMeta.generation, i), null);
    }
}
