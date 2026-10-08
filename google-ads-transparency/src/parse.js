// Parsers for the public JSON RPC answers of adstransparency.google.com.
//
// The Transparency Center web app calls POST /anji/_/rpc/<Service>/<Method> with a form field `f.req`
// holding a JSON object whose keys are protobuf field numbers ("1", "2", ...). Answers use the same shape.
// Field meanings below were read from live answers in October 2026 (see test/fixtures/).
import { countryFromGeoId } from './regions.js';

export const SITE = 'https://adstransparency.google.com';

/** Format codes used by the Transparency Center. Verified: 1 = text ad (archived as a rendered PNG), 2 = image/display, 3 = video. */
export const FORMATS = { 1: 'TEXT', 2: 'IMAGE', 3: 'VIDEO' };
export const FORMAT_CODES = { text: 1, image: 2, video: 3 };

export class ResponseError extends Error {}

/** Parses an RPC answer body. Google sometimes prefixes JSON with )]}' — it is stripped. */
export function parseRpcJson(text) {
    const body = String(text ?? '').replace(/^\)\]\}'\s*/, '').trim();
    if (!body.startsWith('{')) throw new ResponseError(`Not a JSON answer (starts with ${JSON.stringify(body.slice(0, 60))})`);
    try {
        return JSON.parse(body);
    } catch (err) {
        throw new ResponseError(`Invalid JSON answer: ${err.message}`);
    }
}

/** {"1": "1700178585", "2": 279089000} → ISO timestamp (UTC). */
export function tsToIso(t) {
    const s = Number(t?.['1']);
    if (!Number.isFinite(s) || s <= 0) return null;
    const ms = s * 1000 + Math.floor(Number(t?.['2'] ?? 0) / 1e6);
    return new Date(ms).toISOString();
}

/** Ad count range {"1": "9000", "2": "10000"} → { min, max } (Google shows rounded ranges). */
const range = (r) => {
    const min = r?.['1'] !== undefined ? Number(r['1']) : null;
    const max = r?.['2'] !== undefined ? Number(r['2']) : null;
    return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
};

/** SearchSuggestions answer → { advertisers: [{ id, name, country, adsMin, adsMax }], domains: [string] }. */
export function parseSuggestions(json) {
    const advertisers = [];
    const domains = [];
    for (const e of json?.['1'] ?? []) {
        if (e?.['1']?.['2']) {
            const a = e['1'];
            const { min, max } = range(a['4']?.['2']);
            advertisers.push({ id: a['2'], name: a['1'] ?? null, country: a['3'] ?? null, adsMin: min, adsMax: max });
        } else if (e?.['2']?.['1']) {
            domains.push(e['2']['1']);
        }
    }
    return { advertisers, domains };
}

const IMG_SRC = /<img[^>]+src="([^"]+)"/i;

/** One creative variant (the "3" object of a search item, or one entry of "5" in a detail answer) → links. */
export function parseVariant(v) {
    if (!v || typeof v !== 'object') return { imageUrl: null, previewUrl: null, html: null };
    const html = v['3']?.['2'] ?? null;
    const imageUrl = typeof html === 'string' ? (html.match(IMG_SRC)?.[1] ?? null) : null;
    const previewUrl = v['1']?.['4'] ?? null;
    return { imageUrl, previewUrl, html: imageUrl ? null : (typeof html === 'string' ? html : null) };
}

/** Finds a YouTube video id in any string of a variant (video ads link to a YouTube watch page or thumbnail). */
export function findYoutubeId(obj) {
    const s = JSON.stringify(obj ?? '');
    const m = s.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/|i\d?\.ytimg\.com\/vi\/|img\.youtube\.com\/vi\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

export const creativeUrl = (advertiserId, creativeId, region) => `${SITE}/advertiser/${advertiserId}/creative/${creativeId}?region=${region ?? 'anywhere'}`;
export const advertiserUrl = (advertiserId, region) => `${SITE}/advertiser/${advertiserId}?region=${region ?? 'anywhere'}`;

/** SearchCreatives answer → { ads, nextPageToken, totalMin, totalMax }. */
export function parseCreatives(json) {
    const ads = [];
    for (const c of json?.['1'] ?? []) {
        if (!c?.['2']) continue;
        const v = parseVariant(c['3']);
        ads.push({
            advertiserId: c['1'] ?? null,
            advertiserName: c['12'] ?? null,
            adId: c['2'],
            formatCode: c['4'] ?? null,
            format: FORMATS[c['4']] ?? (c['4'] !== undefined ? `UNKNOWN_${c['4']}` : null),
            firstShown: tsToIso(c['6']),
            lastShown: tsToIso(c['7']),
            imageUrl: v.imageUrl,
            previewUrl: v.previewUrl,
            youtubeId: findYoutubeId(c['3']),
        });
    }
    const totalMin = json?.['4'] !== undefined ? Number(json['4']) : null;
    const totalMax = json?.['5'] !== undefined ? Number(json['5']) : null;
    return { ads, nextPageToken: json?.['2'] || null, totalMin, totalMax };
}

/** GetCreativeById answer → { lastShown, formatCode, regions, variants, advertiserName }. */
export function parseCreativeDetail(json) {
    const d = json?.['1'];
    if (!d || !d['2']) throw new ResponseError('Creative detail answer has no creative');
    const variants = (d['5'] ?? []).map(parseVariant).filter((v) => v.imageUrl || v.previewUrl);
    const regions = [];
    for (const r of d['17'] ?? []) {
        if (r?.['1'] === undefined) continue;
        regions.push(countryFromGeoId(r['1']));
    }
    return {
        adId: d['2'],
        advertiserId: d['1'] ?? null,
        advertiserName: d['22']?.['1'] ?? null,
        lastShown: tsToIso(d['4']),
        formatCode: d['8'] ?? null,
        regions,
        variants: variants.map(({ imageUrl, previewUrl }) => ({ imageUrl, previewUrl })),
        youtubeId: findYoutubeId(d['5']),
    };
}

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Picks the advertiser for a name: exact name first, then names starting with it; the one with most ads wins. */
export function pickAdvertiser(name, advertisers) {
    const want = norm(name);
    const byAds = (a, b) => (b.adsMax ?? 0) - (a.adsMax ?? 0);
    const exact = advertisers.filter((a) => norm(a.name) === want).sort(byAds);
    if (exact.length) return { advertiser: exact[0], match: 'exact name', others: advertisers.filter((a) => a !== exact[0]) };
    const starts = advertisers.filter((a) => norm(a.name).startsWith(`${want} `) || norm(a.name).startsWith(want)).sort(byAds);
    if (starts.length) return { advertiser: starts[0], match: 'name starts with the search', others: advertisers.filter((a) => a !== starts[0]) };
    return { advertiser: null, match: null, others: advertisers };
}
