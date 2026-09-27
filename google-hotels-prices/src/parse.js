// Parsers for Google Hotels responses.
//
// Both the server-rendered search page (AF_initDataCallback 'ds:0' blob) and the batchexecute RPC "AtySUc"
// carry the same nested-array data. Hotel entries are found structurally (not by a fixed path), then read by
// slot index. Slot map verified against real captures in github.com/him229/stays (tests/fixtures/*.json, 2026)
// and github.com/janik4321sdfa/google-hotels-python (core.py, 2026-09):
//   entry[1]            hotel name
//   entry[2][0]         [lat, lng]
//   entry[2][1][0][0][0] street address (detail responses)
//   entry[2][2][0]      phone (detail responses)
//   entry[2][17]        [check-in time, check-out time]
//   entry[2][29][2]     hotel website
//   entry[2][36]        country code
//   entry[3]            ["4-star hotel", 4]
//   entry[5][1][i][1][0] photo URLs; entry[12][0] thumbnail
//   entry[6][2][1]      [displayPrice "$68", displayPriceWithTaxes "$80", price 67.57, null, rounded 68]
//   entry[6][2][8]      [[Y,M,D],[Y,M,D],nights,…] dates the price is for
//   entry[6][2][15]     currency code
//   entry[6][2][44]     [base rate, taxes, fees, total with taxes and fees]  (52.7 + 12.4 + 14.87 = 79.97)
//   entry[6][2][2|12|21|22] provider offers (detail responses; [21] = full "All options" list)
//   entry[7][0]         [rating, reviews]
//   entry[9]            Google Maps feature id "0x…:0x…"
//   entry[10][8]        [[available, amenityCode], …]
//   entry[11][0]        short description
//   entry[20]           entity id (base64 protobuf, stable hotel key)
// Page-level blocks (dict keys inside the ds:0 tree):
//   '410579159' → [nextPageToken, '', totalResults, …]
//   '416343588' → [totalResults, ?, resolvedLocationName, locationRecognized]

const K_PAGE = '410579159';
const K_TOTAL = '416343588';

export const get = (tree, ...path) => {
    let cur = tree;
    for (const k of path) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[k];
    }
    return cur;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

// ── Page classification ──────────────────────────────────────────────────────────────────
/**
 * Classifies a response so logs say exactly what Google returned.
 * kind: 'ok' | 'consent' | 'captcha' | 'blocked' | 'http-error'
 */
export function classifyResponse({ status, url = '', text = '' }) {
    const head = text.slice(0, 200_000);
    const lower = head.toLowerCase();
    let host = '';
    let pathname = '';
    try {
        ({ hostname: host, pathname } = new URL(url));
    } catch { /* ignore */ }
    const consent = /^consent\./i.test(host)
        || (/^\/consent\b/.test(pathname) && /<form[^>]+action="[^"]*\/save"/i.test(head))
        || /action="https:\/\/consent\.google\.[a-z.]+\/save"/i.test(head)
        || (/<title>\s*Before you continue/i.test(head) && /<form[^>]+action="[^"]*\/save"/i.test(head))
        || (lower.includes('consent.google.') && /before you continue|bevor sie fortfahren|avant d'accéder|antes de continuar|prima di continuare/i.test(head));
    const captcha = /\/sorry\/(index)?/.test(url)
        || lower.includes('our systems have detected unusual traffic')
        || lower.includes('id="captcha-form"')
        || (lower.includes('g-recaptcha') && lower.includes('/sorry/'));
    let kind = 'ok';
    if (captcha) kind = 'captcha';
    else if (consent) kind = 'consent';
    else if (status === 429 || status === 403) kind = 'blocked';
    else if (status >= 400) kind = 'http-error';
    return { kind, consent, captcha, status };
}

// ── AF_initDataCallback blobs (server-rendered page) ─────────────────────────────────────
/** Returns { blobs: {'ds:0': data, …}, keys: [...], failed: [...] } from an HTML page. */
export function extractInitData(html) {
    const blobs = {};
    const failed = [];
    const re = /AF_initDataCallback\(\{key:\s*'(ds:\d+)'[\s\S]*?data:([\s\S]*?), sideChannel:\s*\{\}\}\);<\/script>/g;
    let m;
    while ((m = re.exec(html))) {
        try {
            blobs[m[1]] = JSON.parse(m[2]);
        } catch {
            failed.push(m[1]);
        }
    }
    return { blobs, keys: Object.keys(blobs), failed };
}

// ── batchexecute ─────────────────────────────────────────────────────────────────────────
export class RpcDecodeError extends Error {}

/** Decodes the `wrb.fr` frame of a batchexecute response and returns the parsed inner payload. */
export function decodeBatchExecute(raw, rpcId) {
    const body = raw.replace(/^\)\]\}'\s*/, '');
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('[')) continue;
        let arr;
        try {
            arr = JSON.parse(t);
        } catch {
            continue;
        }
        for (const e of Array.isArray(arr) ? arr : []) {
            if (Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === rpcId) {
                if (typeof e[2] !== 'string' || !e[2]) throw new RpcDecodeError(`RPC ${rpcId} returned an empty payload (error code ${JSON.stringify(e[5] ?? null)}); the request shape may be outdated`);
                return JSON.parse(e[2]);
            }
        }
    }
    // Fallback: single-line regex (same approach as the stays client).
    const rx = new RegExp(`"wrb\\.fr","${rpcId}","((?:\\\\.|[^"\\\\])*)"`);
    const mm = raw.match(rx);
    if (mm) return JSON.parse(JSON.parse(`"${mm[1]}"`));
    throw new RpcDecodeError(`No ${rpcId} frame in the RPC response (${raw.length} bytes, starts with ${JSON.stringify(raw.slice(0, 80))})`);
}

// ── Structural search ────────────────────────────────────────────────────────────────────
const looksLikeHotel = (n) => {
    if (!Array.isArray(n) || n.length < 21) return false;
    if (typeof n[1] !== 'string' || !n[1]) return false;
    if (!((typeof n[9] === 'string' && n[9]) || (typeof n[20] === 'string' && n[20]))) return false;
    const c = n[2]?.[0];
    return Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === 'number');
};

/** All hotel-entry arrays in a tree, in document order. */
export function findHotelEntries(tree) {
    const out = [];
    const walk = (n, depth) => {
        if (depth > 60 || n === null || typeof n !== 'object') return;
        if (looksLikeHotel(n)) {
            out.push(n);
            return;
        }
        if (Array.isArray(n)) for (const c of n) walk(c, depth + 1);
        else for (const v of Object.values(n)) walk(v, depth + 1);
    };
    walk(tree, 0);
    return out;
}

/** Next-page token, total results and how Google resolved the location. */
export function findPageInfo(tree) {
    const info = { nextPageToken: null, totalResults: null, resolvedLocation: null, locationRecognized: null };
    const walk = (n, depth) => {
        if (depth > 60 || n === null || typeof n !== 'object') return;
        if (!Array.isArray(n)) {
            if (Array.isArray(n[K_PAGE])) {
                const p = n[K_PAGE];
                if (typeof p[0] === 'string' && p[0] && !info.nextPageToken) info.nextPageToken = p[0];
                if (Number.isInteger(p[2]) && info.totalResults === null) info.totalResults = p[2];
            }
            if (Array.isArray(n[K_TOTAL])) {
                const t = n[K_TOTAL];
                if (Number.isInteger(t[0]) && info.totalResults === null) info.totalResults = t[0];
                if (typeof t[2] === 'string') info.resolvedLocation = t[2];
                if (t[3] !== undefined && t[3] !== null) info.locationRecognized = Boolean(t[3]);
            }
            for (const v of Object.values(n)) walk(v, depth + 1);
        } else for (const c of n) walk(c, depth + 1);
    };
    walk(tree, 0);
    return info;
}

// ── Prices and offers ────────────────────────────────────────────────────────────────────
/** "$1,234" / "1.234 €" / "€ 99,50" → number. */
export function parsePriceText(s) {
    if (typeof s !== 'string') return null;
    let t = s.replace(/[^\d.,]/g, '');
    if (!t || !/\d/.test(t)) return null;
    const lastDot = t.lastIndexOf('.');
    const lastComma = t.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
        const dec = lastDot > lastComma ? '.' : ',';
        t = t.replace(dec === '.' ? /,/g : /\./g, '').replace(',', '.');
    } else if (lastComma >= 0) {
        // "1,234" / "12,345,678" = thousands; "99,50" = decimal comma.
        t = t.split(',').slice(1).every((p) => p.length === 3) ? t.replace(/,/g, '') : t.replace(',', '.');
    } else if (lastDot >= 0) {
        const parts = t.split('.');
        if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) t = parts.join('');
    }
    const x = Number(t);
    return Number.isFinite(x) ? x : null;
}

const absGoogleUrl = (path) => (typeof path === 'string' && path.startsWith('/') ? `https://www.google.com${path}` : (typeof path === 'string' && path.startsWith('http') ? path : null));
const directUrlFrom = (path) => {
    if (typeof path !== 'string') return null;
    try {
        const u = new URL(path, 'https://www.google.com');
        const d = u.searchParams.get('pcurl') || u.searchParams.get('adurl');
        return d && /^https?:\/\//.test(d) ? d : null;
    } catch {
        return null;
    }
};

/** One provider row: header [name, providerId, link, [logo], null, isOfficialSite, …], prices at [12][4]. */
function parseOfferRow(row, nights) {
    const header = row?.[0];
    const provider = str(header?.[0]);
    if (!provider) return null;
    const p = get(row, 12, 4) ?? get(row, 12, 5);
    if (!Array.isArray(p)) return null;
    const price = num(p[2]) ?? parsePriceText(p[0]);
    const priceWithTaxes = num(p[3]) ?? parsePriceText(p[1]);
    if (price === null && priceWithTaxes === null) return null;
    const link = typeof header[2] === 'string' ? header[2] : null;
    const rooms = [];
    for (const room of Array.isArray(row[7]) ? row[7] : []) {
        const name = str(room?.[0]);
        if (!name) continue;
        let best = null;
        for (const rate of Array.isArray(room[2]) ? room[2] : []) {
            const rp = rate?.[4];
            const v = num(rp?.[2]) ?? parsePriceText(rp?.[0]);
            if (v !== null && (best === null || v < best.price)) {
                best = { price: v, priceWithTaxes: num(rp?.[3]) ?? parsePriceText(rp?.[1]), freeCancellation: rate?.[2]?.[0] === true ? true : (rate?.[2]?.[0] === false ? false : null) };
            }
        }
        rooms.push({ name, ...(best ?? {}) });
    }
    return {
        provider,
        providerId: Number.isInteger(header[1]) ? header[1] : null,
        price: round2(price),
        priceWithTaxes: round2(priceWithTaxes),
        priceTotal: priceWithTaxes !== null && nights ? round2(priceWithTaxes * nights) : null,
        isOfficialSite: header[5] === true,
        isSponsored: typeof link === 'string' && link.startsWith('/aclk'),
        url: absGoogleUrl(link),
        directUrl: directUrlFrom(link),
        logo: Array.isArray(header[3]) && typeof header[3][0] === 'string' ? (header[3][0].startsWith('//') ? `https:${header[3][0]}` : header[3][0]) : null,
        rooms: rooms.length ? rooms : undefined,
    };
}

/** Merges the provider lists of a detail hotel entry, keeps each provider's cheapest price, sorts by price. */
export function parseOffers(entry, nights) {
    const block = get(entry, 6, 2);
    if (!Array.isArray(block)) return [];
    const byProvider = new Map();
    for (const idx of [2, 12, 22, 21]) {
        const list = block[idx];
        if (!Array.isArray(list)) continue;
        for (const row of list) {
            const o = parseOfferRow(row, nights);
            if (!o) continue;
            const key = o.provider.toLowerCase();
            const prev = byProvider.get(key);
            if (!prev) byProvider.set(key, o);
            else {
                // Keep the lower price, fill in missing fields from the other row.
                const [lo, hi] = (o.price ?? Infinity) < (prev.price ?? Infinity) ? [o, prev] : [prev, o];
                const merged = { ...hi, ...Object.fromEntries(Object.entries(lo).filter(([, v]) => v !== null && v !== undefined)) };
                merged.isOfficialSite = prev.isOfficialSite || o.isOfficialSite;
                merged.directUrl = lo.directUrl ?? hi.directUrl;
                byProvider.set(key, merged);
            }
        }
    }
    return [...byProvider.values()].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}

function findDealLabel(entry) {
    const deal = get(entry, 6, 2, 7);
    let label = null;
    const walk = (n, d) => {
        if (label || d > 8) return;
        if (typeof n === 'string' && /less than usual|% off|deal|great price|lower than usual/i.test(n) && n.length < 80) label = n;
        else if (Array.isArray(n)) for (const c of n) walk(c, d + 1);
    };
    walk(deal, 0);
    return label;
}

function amenityLabels(entry) {
    const labels = [];
    for (const group of Array.isArray(get(entry, 10, 0)) ? get(entry, 10, 0) : []) {
        for (const rec of Array.isArray(group?.[1]) ? group[1] : []) {
            const l = str(rec?.[0]);
            if (l && rec?.[1] !== false) labels.push(l.replace(/<[^>]+>/g, ''));
        }
    }
    return [...new Set(labels)];
}

function amenityCodes(entry) {
    const out = new Set();
    for (const pair of Array.isArray(get(entry, 10, 8)) ? get(entry, 10, 8) : []) {
        if (Array.isArray(pair) && pair[0] === true && Number.isInteger(pair[1])) out.add(pair[1]);
    }
    for (const grp of Array.isArray(get(entry, 10, 6)) ? get(entry, 10, 6) : []) {
        for (const pair of Array.isArray(grp?.[1]) ? grp[1] : []) {
            if (Array.isArray(pair) && pair[0] === true && Number.isInteger(pair[1])) out.add(pair[1]);
        }
    }
    return [...out].sort((a, b) => a - b);
}

const dateFrom = (a) => (Array.isArray(a) && a.length === 3 && a.every(Number.isInteger)
    ? `${a[0]}-${String(a[1]).padStart(2, '0')}-${String(a[2]).padStart(2, '0')}` : null);

const cleanUrlSize = (u) => (typeof u === 'string' ? u.replace(/=s\d+-w\d+-h\d+[^/]*$/, '=s1000') : u);

/**
 * Normalizes one hotel entry. `nights` is used for totals. `withOffers` parses the provider lists (detail responses).
 */
export function parseHotel(entry, { nights = 1, withOffers = false } = {}) {
    const name = str(entry?.[1]);
    if (!name) return null;
    const info = Array.isArray(entry[2]) ? entry[2] : [];
    const offerBlock = get(entry, 6, 2);
    const display = get(offerBlock, 1);
    const breakdown = get(offerBlock, 44);
    const pricePerNight = num(get(display, 2)) ?? num(get(display, 4)) ?? parsePriceText(get(display, 0));
    const pricePerNightWithTaxes = num(get(breakdown, 3)) ?? parsePriceText(get(display, 1));
    const rateDates = get(offerBlock, 8);
    const currency = str(get(offerBlock, 15)) ?? str(get(entry, 6, 1, 3));
    const classArr = entry[3];
    const photos = [];
    for (const ph of Array.isArray(get(entry, 5, 1)) ? get(entry, 5, 1) : []) {
        const u = get(ph, 1, 0);
        if (typeof u === 'string' && u.startsWith('http')) photos.push(cleanUrlSize(u));
        if (photos.length >= 10) break;
    }
    const thumb = get(entry, 12, 0);
    const fid = str(entry[9]);
    let cid = null;
    if (fid && fid.includes(':')) {
        try {
            cid = BigInt(fid.split(':')[1]).toString();
        } catch { /* ignore */ }
    }
    const checkTimes = get(info, 17);
    const reviewsSample = get(entry, 7, 0);
    const hotel = {
        hotelName: name,
        entityId: str(entry[20]),
        rating: num(get(reviewsSample, 0)),
        reviews: Number.isInteger(get(reviewsSample, 1)) ? get(reviewsSample, 1) : null,
        hotelClass: Number.isInteger(get(classArr, 1)) ? get(classArr, 1) : null,
        hotelClassText: str(get(classArr, 0)),
        address: str(get(info, 1, 0, 0, 0)),
        phone: str(get(info, 2, 0)),
        lat: num(get(info, 0, 0)),
        lng: num(get(info, 0, 1)),
        countryCode: str(get(info, 36)),
        website: str(get(info, 29, 2)),
        checkInTime: str(get(checkTimes, 0))?.replace(/\s/g, ' ') ?? null,
        checkOutTime: str(get(checkTimes, 1))?.replace(/\s/g, ' ') ?? null,
        description: str(get(entry, 11, 0)),
        amenities: amenityLabels(entry),
        amenityCodes: amenityCodes(entry),
        pricePerNight: round2(pricePerNight),
        pricePerNightText: str(get(display, 0)),
        pricePerNightWithTaxes: round2(pricePerNightWithTaxes),
        priceBeforeTaxes: round2(num(get(breakdown, 0))),
        taxes: round2(num(get(breakdown, 1))),
        fees: round2(num(get(breakdown, 2))),
        priceTotal: pricePerNightWithTaxes !== null ? round2(pricePerNightWithTaxes * nights) : null,
        currency,
        priceCheckIn: dateFrom(get(rateDates, 0)),
        priceCheckOut: dateFrom(get(rateDates, 1)),
        dealLabel: findDealLabel(entry),
        thumbnail: typeof thumb === 'string' ? thumb : (photos[0] ?? null),
        photos,
        googleMapsUrl: cid ? `https://maps.google.com/?cid=${cid}` : null,
        placeId: fid,
    };
    if (withOffers) hotel.offers = parseOffers(entry, nights);
    return hotel;
}

/**
 * Parses a whole search payload (ds:0 data or RPC inner). De-duplicates by entity id / place id.
 */
export function parseSearchPayload(tree, { nights = 1 } = {}) {
    const entries = findHotelEntries(tree);
    const seen = new Set();
    const hotels = [];
    for (const e of entries) {
        const h = parseHotel(e, { nights });
        if (!h) continue;
        const key = h.entityId ?? h.placeId ?? h.hotelName;
        if (seen.has(key)) continue;
        seen.add(key);
        hotels.push(h);
    }
    return { hotels, entriesFound: entries.length, ...findPageInfo(tree) };
}

/**
 * Parses a search page's HTML: tries 'ds:0' first, then every other blob (diagnostic `parserPath` says which).
 */
export function parseSearchHtml(html, { nights = 1 } = {}) {
    const { blobs, keys, failed } = extractInitData(html);
    const order = ['ds:0', ...keys.filter((k) => k !== 'ds:0')];
    for (const k of order) {
        if (!blobs[k]) continue;
        const r = parseSearchPayload(blobs[k], { nights });
        if (r.hotels.length || (r.locationRecognized === false && !r.totalResults) || (k === 'ds:0' && r.totalResults === 0)) return { ...r, parserPath: `html:${k}`, blobKeys: keys, blobFailed: failed };
    }
    // Last resort: whole-page scan for any JSON array literal is too expensive; report what was seen.
    return { hotels: [], entriesFound: 0, nextPageToken: null, totalResults: null, resolvedLocation: null, locationRecognized: null, parserPath: keys.length ? 'html:no-hotels-in-blobs' : 'html:no-blobs', blobKeys: keys, blobFailed: failed };
}

/** Detail payload (RPC with entity id, or entity page blobs) → the requested hotel with offers. */
export function parseDetailPayload(tree, { nights = 1, entityId = null } = {}) {
    const entries = findHotelEntries(tree);
    if (!entries.length) return null;
    const pick = (entityId && entries.find((e) => e[20] === entityId))
        ?? entries.find((e) => Array.isArray(get(e, 6, 2, 21)) || Array.isArray(get(e, 6, 2, 2)))
        ?? entries[0];
    return parseHotel(pick, { nights, withOffers: true });
}

/** Detail from an entity page's HTML (all blobs). */
export function parseDetailHtml(html, { nights = 1, entityId = null } = {}) {
    const { blobs, keys } = extractInitData(html);
    let fallback = null;
    for (const k of keys) {
        const h = parseDetailPayload(blobs[k], { nights, entityId });
        if (h && h.offers.length) return { hotel: h, parserPath: `entity-html:${k}`, blobKeys: keys };
        if (h && !fallback) fallback = { hotel: h, parserPath: `entity-html:${k}(no-offers)`, blobKeys: keys };
    }
    return fallback ?? { hotel: null, parserPath: keys.length ? 'entity-html:no-hotel' : 'entity-html:no-blobs', blobKeys: keys };
}
