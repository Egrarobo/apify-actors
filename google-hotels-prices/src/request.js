// Builds Google Hotels request URLs and RPC payloads.
//
// Sources (verified from code, Sept 2026):
//  - `ts` / `qs` search-state protobufs: github.com/janik4321sdfa/google-hotels-python (google_hotels/core.py, build_ts/build_qs)
//  - batchexecute RPC "AtySUc" payload (search + hotel detail with entity key at meta[5]):
//    github.com/him229/stays (stays/models/google_hotels/hotels.py, stays/search/client.py)

export const DEFAULT_BASE_URL = 'https://www.google.com';
export const RPC_ID = 'AtySUc';
export const RPC_PATH = '/_/TravelFrontendUi/data/batchexecute';

// Consent cookies that skip the EU "Before you continue" page (same values as google-hotels-python).
export const CONSENT_COOKIES = { CONSENT: 'YES+cb', SOCS: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg' };
export const consentCookieHeader = () => Object.entries(CONSENT_COOKIES).map(([k, v]) => `${k}=${v}`).join('; ');

// ── Minimal protobuf writer ────────────────────────────────────────────────────────────
const varint = (n) => {
    const out = [];
    let x = n;
    for (;;) {
        const b = x & 0x7f;
        x = Math.floor(x / 128);
        if (x) out.push(b | 0x80);
        else {
            out.push(b);
            return Buffer.from(out);
        }
    }
};
const fBytes = (field, data) => Buffer.concat([varint((field << 3) | 2), varint(data.length), data]);
const fInt = (field, n) => Buffer.concat([varint(field << 3), varint(n)]);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const ymd = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return { y, m, d };
};
export const nightsBetween = (checkIn, checkOut) => Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);

/** Search state for /travel/search?ts=… (location text, dates, adults, currency). */
export function buildTs({ location, checkIn, checkOut, adults, currency }) {
    const loc = fBytes(7, Buffer.from(location, 'utf8'));
    const date = (iso) => {
        const { y, m, d } = ymd(iso);
        return Buffer.concat([fInt(1, y), fInt(2, m), fInt(3, d)]);
    };
    const dates = Buffer.concat([
        fBytes(2, Buffer.concat([fBytes(1, date(checkIn)), fBytes(2, date(checkOut)), fInt(3, nightsBetween(checkIn, checkOut))])),
        fBytes(6, fInt(1, adults)),
    ]);
    const msg = Buffer.concat([
        fInt(1, 1),
        fBytes(3, Buffer.concat([fBytes(1, fBytes(2, loc)), fBytes(2, dates)])),
        fBytes(5, fBytes(1, fBytes(7, Buffer.from(currency, 'utf8')))),
    ]);
    return b64url(msg);
}

/** Page cursor for /travel/search?qs=… built from the "next page" token found in the previous page. */
export const buildQs = (token) => b64url(Buffer.concat([fBytes(2, Buffer.from(token, 'utf8')), fInt(7, 13)]));

/** Strips "hotels in" / "hotels near" so the `ts` location is a place name. */
export const locationFromQuery = (q) => q.replace(/^\s*(hotels?|places to stay|accommodations?|stays)\s+(in|near|at|around)\s+/i, '').trim() || q;

/** GET URL of a Google Hotels search results page. */
export function buildSearchUrl(baseUrl, { query, checkIn, checkOut, adults, currency, language, country, pageToken }) {
    const u = new URL('/travel/search', baseUrl);
    u.searchParams.set('q', query);
    u.searchParams.set('hl', language);
    u.searchParams.set('gl', country);
    u.searchParams.set('curr', currency);
    u.searchParams.set('ts', buildTs({ location: locationFromQuery(query), checkIn, checkOut, adults, currency }));
    if (pageToken) {
        u.searchParams.set('qs', buildQs(pageToken));
        u.searchParams.set('ap', 'MAE');
    }
    return u.toString();
}

/** Public (user-facing) link to a hotel's prices on Google Hotels. */
export function buildHotelUrl({ entityId, query, checkIn, checkOut, adults, currency, language, country }) {
    const u = new URL(`/travel/hotels/entity/${entityId}/prices`, DEFAULT_BASE_URL);
    if (query) u.searchParams.set('q', query);
    u.searchParams.set('hl', language);
    u.searchParams.set('gl', country);
    u.searchParams.set('curr', currency);
    if (checkIn && checkOut) u.searchParams.set('ts', buildTs({ location: query ? locationFromQuery(query) : 'hotels', checkIn, checkOut, adults, currency }));
    return u.toString();
}

// ── batchexecute RPC "AtySUc" ───────────────────────────────────────────────────────────
// Child ages map to Google age buckets; 2-12 is confirmed from captures, the others are inferred (stays).
const ageBucket = (age) => (age <= 1 ? [0, 1] : age <= 12 ? [2, 12] : [13, 17]);

/**
 * Inner payload of the AtySUc RPC: [query, searchParams, requestMeta].
 * With `entityId` set, Google answers with one enriched hotel (address, description, all provider offers).
 * `pageToken` at meta[1] is an ASSUMPTION (mirrors field 2 of the `qs` protobuf); the run stops paging
 * when a page returns no new hotels.
 */
export function buildRpcInner({ query, checkIn, checkOut, adults, childrenAges = [], currency, entityId = null, pageToken = null }) {
    const ci = ymd(checkIn);
    const co = ymd(checkOut);
    const datesSlot = [null, [[ci.y, ci.m, ci.d], [co.y, co.m, co.d], nightsBetween(checkIn, checkOut)], null, null, null, [null, childrenAges.length]];
    const extras = adults !== 2 || childrenAges.length
        ? [[...Array.from({ length: adults }, () => [3]), ...childrenAges.map(ageBucket)], 1]
        : null;
    const filterDetails = [null, null, null, null, null, null, currency, null];
    const filtersRecord = [filterDetails, null, [], [null, null, 1]];
    const searchParams = [1, extras, [null, datesSlot], null, filtersRecord];
    const meta = [1, null, null, null, null, null, 13, null, 0];
    if (pageToken) meta[1] = pageToken;
    if (entityId) meta[5] = entityId;
    return [query, searchParams, meta];
}

/** URL-encoded form body for POST /_/TravelFrontendUi/data/batchexecute. */
export function buildRpcBody(inner) {
    const outer = [[[RPC_ID, JSON.stringify(inner), null, '1']]];
    return `f.req=${encodeURIComponent(JSON.stringify(outer))}`;
}

export function buildRpcUrl(baseUrl, { language, country }) {
    const u = new URL(RPC_PATH, baseUrl);
    u.searchParams.set('rpcids', RPC_ID);
    u.searchParams.set('hl', language);
    u.searchParams.set('gl', country);
    return u.toString();
}

/** Extracts the entity id (base64 protobuf, e.g. "ChoIxPKIzoX4zIfLARoNL2cvMTFwd2g1N2c1NRAB") from a Google Hotels link or raw id. */
export function parseEntityId(s) {
    const str = String(s ?? '').trim();
    const m = str.match(/\/entity\/([A-Za-z0-9_-]{12,}={0,2})/);
    if (m) return m[1];
    if (/^Ch[A-Za-z0-9_-]{10,}={0,2}$/.test(str)) return str;
    return null;
}
