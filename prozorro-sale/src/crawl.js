import { log } from 'apify';
import { PAGE_SIZE } from './api.js';

const idOf = (p) => p?._id ?? p?.id ?? p?.auctionId ?? null;

/**
 * Walks /api/search/byDateModified forward from `since` (ascending, inclusive cursor).
 * Calls `onPage(records)` for every page; `onPage` may return false to stop (e.g. spending limit, enough results).
 * Returns what was covered, so a partial scan is never presented as complete.
 */
export async function crawlChangeFeed(client, { since, maxPages, onPage }) {
    let cursor = since;
    let pages = 0;
    let recordsScanned = 0;
    let lastModified = null;
    let reachedPresent = false;
    let stoppedByCaller = false;
    const seenAtCursor = new Set();

    while (pages < maxPages) {
        const page = await client.feedByDateModified(cursor, PAGE_SIZE);
        if (!Array.isArray(page)) throw new Error(`Unexpected change-feed response (expected a JSON array, got ${typeof page}).`);
        pages++;
        // The cursor is inclusive: records sitting exactly on it were already delivered by the previous page.
        const fresh = page.filter((p) => !(p?.dateModified === cursor && seenAtCursor.has(idOf(p))));
        recordsScanned += fresh.length;
        const cont = fresh.length ? await onPage(fresh, { pages }) : true;

        const last = page[page.length - 1]?.dateModified ?? null;
        if (last) lastModified = last;
        if (cont === false) {
            stoppedByCaller = true;
            break;
        }
        if (page.length < PAGE_SIZE || !last) {
            reachedPresent = true;
            break;
        }
        if (last === cursor) {
            // A full page sharing one timestamp: step 1 ms forward so we never loop forever.
            log.debug(`100 records share dateModified ${cursor}; stepping the cursor forward by 1 ms.`);
            cursor = new Date(Date.parse(cursor) + 1).toISOString();
            seenAtCursor.clear();
        } else {
            cursor = last;
            seenAtCursor.clear();
        }
        for (const p of page) if (p?.dateModified === cursor) seenAtCursor.add(idOf(p));
        if (pages % 10 === 0) log.info(`Scanned ${pages} pages (${recordsScanned.toLocaleString('en-US')} records), now at ${cursor}…`);
    }
    return {
        strategy: 'changeFeed',
        scannedFrom: since,
        scannedTo: lastModified,
        nextCursor: cursor,
        pages,
        recordsScanned,
        reachedPresent,
        truncated: !reachedPresent,
        truncationReason: reachedPresent ? null : stoppedByCaller ? 'stopped' : 'maxPages',
    };
}

/**
 * Fetches the (up to) 100 most recently modified procedures for each selling method.
 * Fast, but only covers recent activity of those types.
 */
export async function crawlByType(client, { sellingMethods, onPage }) {
    let pages = 0;
    let recordsScanned = 0;
    const full = [];
    const failed = [];
    let stopped = false;
    for (const method of sellingMethods) {
        let page;
        try {
            page = await client.feedBySellingMethod(method, PAGE_SIZE);
        } catch (err) {
            if (err.status === 404 || err.status === 400 || err.status === 422) {
                log.warning(`Selling method "${method}" is not known to the API (${err.message.slice(0, 120)}). Skipped.`);
                failed.push(method);
                continue;
            }
            throw err;
        }
        if (!Array.isArray(page)) throw new Error(`Unexpected response for selling method "${method}" (expected a JSON array).`);
        pages++;
        recordsScanned += page.length;
        if (page.length >= PAGE_SIZE) full.push(method);
        if ((await onPage(page, { pages })) === false) {
            stopped = true;
            break;
        }
    }
    return {
        strategy: 'latestByType',
        sellingMethods,
        pages,
        recordsScanned,
        methodsAtLimit: full,
        unknownMethods: failed,
        reachedPresent: true,
        truncated: stopped || full.length > 0,
        truncationReason: stopped ? 'stopped' : full.length ? 'perTypeLimit' : null,
    };
}

/** Expands family names ("landRental") into exact selling methods ("landRental-english", …) using /api/legal_names. */
export async function expandSellingMethods(client, wanted) {
    let known = [];
    try {
        const names = await client.legalNames();
        if (Array.isArray(names)) known = names.filter((x) => typeof x === 'string');
    } catch (err) {
        if (err.status === undefined) throw err; // network failure: the next request would fail too
        log.warning(`Could not load the list of selling methods (${err.message}); using the values as given.`);
    }
    if (!known.length) return wanted;
    const byLower = new Map(known.map((k) => [k.toLowerCase(), k]));
    const out = new Set();
    for (const w of wanted) {
        const lw = w.toLowerCase();
        if (byLower.has(lw)) {
            out.add(byLower.get(lw));
            continue;
        }
        const family = known.filter((k) => k.toLowerCase().startsWith(`${lw}-`));
        if (family.length) family.forEach((k) => out.add(k));
        else {
            log.warning(`"${w}" is not a known selling method or procedure type. Known types: ${[...new Set(known.map((k) => k.split('-')[0]))].join(', ')}`);
            out.add(w);
        }
    }
    return [...out];
}
