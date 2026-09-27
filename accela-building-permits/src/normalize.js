import { clean } from './parse.js';

// Trade categories used for the "category" output field and for permitTypes filtering. Matched against record type,
// description and project name (word starts, case-insensitive).
export const CATEGORIES = {
    roofing: ['roof', 'reroof', 're-roof', 'shingle', 'roofing'],
    solar: ['solar', 'photovoltaic', 'pv system', 'pv ', 'battery storage', 'energy storage'],
    pool: ['pool', 'spa', 'swimming', 'hot tub'],
    hvac: ['hvac', 'mechanical', 'a/c', 'air condition', 'heat pump', 'furnace', 'change-out', 'changeout', 'ductwork', 'mini split', 'mini-split'],
    electrical: ['electric', 'electrical', 'service upgrade', 'panel', 'generator', 'ev charger'],
    plumbing: ['plumbing', 'water heater', 'sewer', 'gas line', 'repipe', 're-pipe'],
    'new-construction': ['new construction', 'new single', 'new residential', 'new commercial', 'new building', 'new dwelling', 'new sfr', 'new home', 'single family dwelling', 'new multi'],
    addition: ['addition'],
    remodel: ['remodel', 'alteration', 'renovation', 'repair', 'interior finish', 'tenant improvement', 'build-out', 'buildout', 'kitchen', 'bath'],
    demolition: ['demolition', 'demo '],
    windows: ['window', 'door', 'shutter', 'hurricane protection', 'impact glass'],
    fence: ['fence', 'wall'],
    sign: ['sign'],
    'accessory-structure': ['shed', 'carport', 'garage', 'deck', 'patio', 'pergola', 'screen enclosure', 'accessory'],
    'mobile-home': ['mobile home', 'manufactured home'],
};

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9/+-]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** True when the keyword occurs at a word start ("roof" matches "Roofing", not "Reroof"; "sign" does not match "design"). */
const hasWord = (hay, kw) => {
    const k = norm(kw).trim();
    return !!k && (hay.includes(` ${k}`) || hay.includes(`-${k}`) || hay.includes(`/${k}`));
};

const catOf = (text) => {
    const hay = norm(text);
    for (const [cat, kws] of Object.entries(CATEGORIES)) {
        if (kws.some((k) => hasWord(hay, k))) return cat;
    }
    return null;
};

/** Trade category: from the record type first, then from description / project name. */
export function categorize(recordType, ...texts) {
    return catOf(recordType) ?? catOf(texts.filter(Boolean).join(' ')) ?? 'other';
}

// Categories a description keyword may override (a "Residential Remodel" whose description says "new roof").
const GENERIC = new Set(['other', 'remodel', 'addition', 'accessory-structure']);

/** "roof" → "roofing", "pool" → "pool", "electric" → "electrical"; null when the word is not a category. */
export function keywordCategory(k) {
    const w = String(k).trim().toLowerCase();
    if (w.length < 3) return null;
    return Object.keys(CATEGORIES).find((c) => c === w || c.startsWith(w)) ?? null;
}

/**
 * Builds a matcher from permitTypes (category names like "roofing"/"roof", or any other keyword) and
 * excludeKeywords (and statuses: status contains one of them). A category keyword matches permits of that category (from the record type), plus permits of a
 * generic category (remodel/other/...) whose description mentions the trade. Other keywords are searched in
 * record type, description and project name. Returns (record) => { ok, matched: [...] }.
 */
export function buildMatcher({ permitTypes = [], excludeKeywords = [], statuses = [] }) {
    const include = permitTypes.map((k) => String(k).trim()).filter(Boolean);
    const exclude = excludeKeywords.map((k) => String(k).trim()).filter(Boolean);
    const sts = statuses.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    return (rec) => {
        if (sts.length && !sts.some((x) => String(rec.status ?? '').toLowerCase().includes(x))) return { ok: false, matched: [] };
        const hay = norm([rec.recordType, rec.description, rec.projectName].filter(Boolean).join(' '));
        if (exclude.some((k) => hasWord(hay, k))) return { ok: false, matched: [] };
        if (!include.length) return { ok: true, matched: [] };
        const matched = [];
        for (const k of include) {
            const cat = keywordCategory(k);
            if (cat) {
                const inText = CATEGORIES[cat].some((w) => hasWord(hay, w));
                if (rec.category === cat || (GENERIC.has(rec.category) && inText)) matched.push(k);
            } else if (hasWord(hay, k)) matched.push(k);
        }
        return { ok: matched.length > 0, matched };
    };
}

/** "09/25/2026" | "9/5/2026" | "2026-09-25" → "2026-09-25"; anything else → null. */
export function isoDate(v) {
    const s = clean(v);
    if (!s) return null;
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
}

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '));

const SUFFIX = /^(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|way|pl|place|cir|circle|hwy|highway|pkwy|parkway|ter|terrace|trl|trail|loop|sq|pt|point|run|pass|path|row|xing|aly|cv|cove|pike|walk)\.?$/i;
const TAIL = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west|unit|apt|ste|suite|bldg|lot|#.*|\d+[a-z]?)$/i;

/**
 * Splits "3920 PFLANZ AVE, LOUISVILLE KY 40212", "123 MAIN ST TAMPA, FL 33602" or "123 Main St, Tampa, FL, 33602"
 * into { street, city, state, zip }. Without a "ST ZIP" tail, street = the whole string.
 */
export function splitAddress(address) {
    const a = clean(String(address ?? '').replace(/\s*\*\s*$/, ''));
    if (!a) return { street: null, city: null, state: null, zip: null };
    const m = a.match(/^(.*?)[,\s]+([A-Za-z]{2})[,\s]+(\d{5})(?:-\d{4})?\s*$/);
    if (!m || !US_STATES.has(m[2].toUpperCase())) {
        const z = a.match(/\b(\d{5})(?:-\d{4})?\s*$/);
        return { street: a, city: null, state: null, zip: z ? z[1] : null };
    }
    const rest = clean(m[1]).replace(/,+$/, '');
    let street = rest;
    let city = null;
    if (rest.includes(',')) {
        const parts = rest.split(',').map(clean).filter(Boolean);
        city = parts.pop();
        street = parts.join(', ');
    } else {
        // No comma between street and city: the city starts after the last street suffix (+ direction/unit).
        const words = rest.split(' ');
        let cut = -1;
        for (let i = words.length - 2; i >= 1; i--) {
            if (SUFFIX.test(words[i])) {
                cut = i + 1;
                while (cut < words.length - 1 && TAIL.test(words[cut])) cut++;
                break;
            }
        }
        if (cut > 0 && cut < words.length) {
            street = words.slice(0, cut).join(' ');
            city = words.slice(cut).join(' ');
        }
    }
    const title = (s) => (s ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null);
    return { street: street || null, city: title(city), state: m[2].toUpperCase(), zip: m[3] };
}

const money = (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const m = String(v).replace(/\s/g, '').match(/-?[\d,]+(?:\.\d+)?/);
    const n = m ? Number(m[0].replace(/,/g, '')) : NaN;
    return Number.isFinite(n) ? n : null;
};

/** Grid/CSV row (+ optional parsed detail page) → output record. */
export function normalizeRecord({ row, detail = null, agency, module, includePersonalNames, portalUrl, source }) {
    const k = row.byKey ?? {};
    const address = detail?.address || k.address || null;
    const parts = splitAddress(address);
    const recordType = detail?.recordType || k.recordType || null;
    const description = detail?.description || k.description || null;
    const projectName = detail?.projectName || k.projectName || null;
    const c = detail?.contractor ?? null;
    const rec = {
        agency: agency.code,
        agencyName: agency.name ? `${agency.name}${agency.state ? `, ${agency.state}` : ''}` : null,
        module,
        recordNumber: clean(k.recordNumber || detail?.recordNumber) || null,
        recordType,
        category: categorize(recordType, description, projectName),
        status: detail?.status || k.status || null,
        openedDate: isoDate(k.openedDate),
        issuedDate: isoDate(k.issuedDate),
        expirationDate: isoDate(k.expirationDate),
        address: parts.street ?? address,
        city: parts.city,
        state: parts.state ?? agency.state ?? null,
        zip: parts.zip,
        fullAddress: address,
        parcelNumber: detail?.parcelNumber || k.parcelNumber || null,
        description,
        projectName,
        valuation: detail?.valuation ?? money(k.valuation),
        contractorName: c?.company || c?.name || k.contractorName || null,
        contractorPerson: c?.company && c?.name && c.name !== c.company ? c.name : null,
        contractorLicense: c?.license ?? null,
        contractorLicenseType: c?.licenseType ?? null,
        contractorPhone: c?.phone ?? null,
        contractorAddress: c?.address ?? null,
        applicantName: includePersonalNames ? (detail?.applicant?.name ?? null) : null,
        applicantCompany: detail?.applicant?.company ?? null,
        ownerName: includePersonalNames ? (detail?.owner?.name ?? null) : null,
        ownerMailingAddress: includePersonalNames ? (detail?.owner?.address ?? null) : null,
        moreDetails: detail?.moreDetails && Object.keys(detail.moreDetails).length ? detail.moreDetails : undefined,
        detailsFetched: !!detail,
        detailUrl: row.detailHref ?? detail?.detailUrl ?? null,
        portalUrl,
        source,
    };
    // Applicant company is a business, not a person; keep it. Personal applicant/owner names only with the toggle.
    if (!includePersonalNames && rec.moreDetails) rec.moreDetails = redactPersonal(rec.moreDetails);
    return rec;
}

/** Drops "More Details" entries whose label points at a person (owner/applicant/contact names, phones, emails). */
function redactPersonal(md) {
    const out = {};
    for (const [label, v] of Object.entries(md)) {
        if (/owner|applicant|contact|tenant|homeowner|e-?mail|phone|resident|occupant/i.test(label)) continue;
        out[label] = v;
    }
    return Object.keys(out).length ? out : undefined;
}
