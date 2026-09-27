import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Actor } from 'apify';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Seen tenders older than this are forgotten, so the state never grows without bound.
const SEEN_RETENTION_DAYS = 400;

export const slugify = (s) => String(s).trim().replace(/[^a-zA-Z0-9!\-_.'()]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'default';

/**
 * Memory of one monitor, stored as one gzipped JSON record "monitor-<name>" in a named key-value store:
 *   { settingsFingerprint, baselineFrom, cursor, seen: { ocid: firstSeenIso }, ... }
 */
export class MonitorState {
    constructor(storeName, monitorName) {
        this.storeName = storeName;
        this.monitorName = monitorName;
        this.key = `monitor-${slugify(monitorName)}`;
    }

    async open() {
        this.kvs = await Actor.openKeyValueStore(this.storeName, { forceCloud: Actor.isAtHome() });
        return this;
    }

    async load() {
        const buf = await this.kvs.getValue(this.key);
        if (!buf) return null;
        try {
            const json = Buffer.isBuffer(buf) || buf instanceof Uint8Array ? (await gunzip(Buffer.from(buf))).toString('utf8') : JSON.stringify(buf);
            return JSON.parse(json);
        } catch (err) {
            throw new Error(`The saved state of monitor "${this.monitorName}" could not be read (${err.message}). Run once with "Start over" enabled.`);
        }
    }

    async save(state) {
        const cutoff = Date.now() - SEEN_RETENTION_DAYS * 86_400_000;
        const seen = {};
        for (const [ocid, first] of Object.entries(state.seen ?? {})) {
            if (!(Date.parse(first) < cutoff)) seen[ocid] = first;
        }
        const body = { ...state, seen, version: 1, updatedAt: new Date().toISOString() };
        await this.kvs.setValue(this.key, await gzip(Buffer.from(JSON.stringify(body), 'utf8')), { contentType: 'application/gzip' });
        return body;
    }

    async reset() {
        await this.kvs.setValue(this.key, null);
    }
}
