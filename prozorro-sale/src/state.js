import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Actor } from 'apify';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** Oldest remembered IDs are dropped beyond this; auctions that old never show up as new again anyway. */
export const MAX_SEEN = 200_000;

export const slugify = (s) => String(s).trim().replace(/[^a-zA-Z0-9!\-_.'()]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'default';

/**
 * State of one monitor, stored as a single gzipped JSON record in a named key-value store:
 *   { version, monitorName, instance, baselineFrom, cursor, seen: [[id, firstSeenAt], ...], runs, updatedAt }
 * "cursor" is the dateModified up to which the change feed has been fully read.
 */
export class MonitorState {
    constructor(storeName, monitorName, instance) {
        this.storeName = storeName;
        this.key = `monitor-${slugify(monitorName)}-${instance}`;
    }

    async open() {
        // forceCloud keeps the state on the Apify platform even when the Actor runs locally with a token.
        this.kvs = await Actor.openKeyValueStore(this.storeName, { forceCloud: Actor.isAtHome() });
        return this;
    }

    async load() {
        const buf = await this.kvs.getValue(this.key);
        if (!buf) return null;
        try {
            const data = JSON.parse((await gunzip(Buffer.from(buf))).toString('utf8'));
            data.seenMap = new Map(data.seen ?? []);
            delete data.seen;
            return data;
        } catch (err) {
            throw new Error(`The saved state of this monitor ("${this.key}" in store "${this.storeName}") is unreadable (${err.message}). Run once with "Start over" enabled.`);
        }
    }

    async save(state) {
        const { seenMap, ...rest } = state;
        let seen = [...seenMap];
        if (seen.length > MAX_SEEN) seen = seen.slice(seen.length - MAX_SEEN);
        const body = await gzip(Buffer.from(JSON.stringify({ ...rest, seen, version: 1, updatedAt: new Date().toISOString() }), 'utf8'));
        await this.kvs.setValue(this.key, body, { contentType: 'application/gzip' });
        return seen.length;
    }

    async reset() {
        await this.kvs.setValue(this.key, null);
    }
}
