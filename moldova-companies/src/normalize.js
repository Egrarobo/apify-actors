// Text normalization, header mapping and record normalization for the ASP
// "State Register of Legal Entities" open-data file.

const CYR = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia', є: 'e', і: 'i', ї: 'i', ґ: 'g',
};

/**
 * Lowercase, transliterate Cyrillic, strip all diacritics (ș/ş, ț/ţ, ă, â, î…),
 * turn punctuation into spaces. "S.R.L." -> "srl" (dots are removed, not spaced).
 */
export function norm(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .toLowerCase()
        .replace(/[а-яёєіїґ]/g, (c) => CYR[c] ?? c)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[.'’`´"«»„“”]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// Legal-form abbreviations that are noise when searching by name.
const NAME_STOPWORDS = new Set([
    'srl', 'sa', 'ii', 'im', 'ics', 'is', 'gt', 'snc', 'sc', 'ooo', 'oao', 'zao', 'ao', 'pao', 'ltd', 'llc',
    'societatea', 'societate', 'cu', 'raspundere', 'limitata', 'pe', 'actiuni', 'intreprinderea', 'individuala',
    'firma', 'compania', 'mixta', 'straina', 'de', 'si',
]);

export function nameTokens(value) {
    return norm(value).split(' ').filter((t) => t && !NAME_STOPWORDS.has(t));
}

// Canonical legal forms: abbreviation -> normalized long-form fragments.
export const LEGAL_FORMS = [
    { code: 'SRL', patterns: ['societate cu raspundere limitata', 'societatea cu raspundere limitata', 'srl'] },
    { code: 'SA', patterns: ['societate pe actiuni', 'societatea pe actiuni'] },
    { code: 'II', patterns: ['intreprindere individuala', 'intreprinderea individuala'] },
    { code: 'GT', patterns: ['gospodarie taraneasca', 'gospodaria taraneasca', 'gospodarie de fermier', 'gospodaria de fermier'] },
    { code: 'SNC', patterns: ['societate in nume colectiv', 'societatea in nume colectiv'] },
    { code: 'SC', patterns: ['societate in comandita', 'societatea in comandita'] },
    { code: 'COOP', patterns: ['cooperativa'] },
    { code: 'IS', patterns: ['intreprindere de stat', 'intreprinderea de stat'] },
    { code: 'IM', patterns: ['intreprindere municipala', 'intreprinderea municipala'] },
    { code: 'FIL', patterns: ['filiala', 'reprezentanta'] },
];

export function legalFormCode(legalForm) {
    const n = norm(legalForm);
    if (!n) return null;
    for (const f of LEGAL_FORMS) {
        if (n === f.code.toLowerCase() || f.patterns.some((p) => n.includes(p))) return f.code;
    }
    return null;
}

/** Does a record's legal form match a user filter ("SRL", "srl", "Societate cu răspundere limitată")? */
export function legalFormMatches(legalForm, filterValue) {
    const want = norm(filterValue);
    if (!want) return true;
    const have = norm(legalForm);
    const code = legalFormCode(legalForm);
    if (code && code.toLowerCase() === want.replace(/ /g, '')) return true;
    return have.includes(want);
}

// ---------- Header mapping ----------

// Order matters: more specific patterns first.
const HEADER_RULES = [
    ['idno', /\bidno\b|cod fiscal|cod unic|\bidn\b|fiskaln|fiscal code/],
    ['liquidationDate', /data (lichid|radier|excluder)|lichidar(ii|e) data|data ls|data likvid|liquidation date/],
    ['registrationDate', /data (inregistr|reg)|data de inregistr|registration date|data registr/],
    ['name', /denumir|naimenovan|nazvan|company name|^name$/],
    ['legalForm', /\bforma\b|organizats|legal form/],
    ['address', /adres|sediu|address/],
    ['status', /statut|\bstare\b|status|sostoian/],
    ['beneficialOwners', /beneficiar|benefitsiar/],
    ['directors', /conducator|administrator|director|rukovod/],
    ['founders', /fondator|asociat|uchredit|founder/],
    ['activitiesUnlicensed', /nelicent|nelitsenz|unlicensed/],
    ['activitiesLicensed', /licent|litsenz|licensed/],
    ['activities', /activitat|caem|deiatelnost|activit/],
];

export function mapHeaderCell(text) {
    const n = norm(text);
    if (!n) return null;
    for (const [field, re] of HEADER_RULES) if (re.test(n)) return field;
    return null;
}

/** Returns { fieldByIndex: Map<colIndex, field>, headerByIndex } if row looks like the header, else null. */
export function detectHeader(cells) {
    const fieldByIndex = new Map();
    const headerByIndex = new Map();
    const used = new Set();
    cells.forEach((c, i) => {
        const text = cellText(c);
        if (!text) return;
        headerByIndex.set(i, text.trim());
        const f = mapHeaderCell(text);
        if (f && !used.has(f)) {
            fieldByIndex.set(i, f);
            used.add(f);
        }
    });
    if (!used.has('idno') || !used.has('name')) return null;
    return { fieldByIndex, headerByIndex };
}

// ---------- Cell values ----------

export function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
        if (v.text !== undefined) return cellText(v.text);
        if (v.result !== undefined) return cellText(v.result);
        if (v.hyperlink && v.text) return String(v.text);
        return '';
    }
    return String(v).replace(/ /g, ' ').trim();
}

/** Accepts Date, Excel serial number, "dd.mm.yyyy", "yyyy-mm-dd", "dd/mm/yyyy". Returns "YYYY-MM-DD" or null. */
export function toIsoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
        const n = Number(v);
        if (n > 1000 && n < 80000) {
            const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
            return d.toISOString().slice(0, 10);
        }
        return null;
    }
    const s = cellText(v);
    let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return null;
}

export function splitList(v) {
    const s = cellText(v);
    if (!s) return [];
    return s.split(/\s*(?:;|\r?\n|\|)\s*/).map((x) => x.replace(/^[,\s]+|[,\s]+$/g, '')).filter(Boolean);
}

// CAEM (NACE-based) codes such as "62.01", "47.19.1", optionally prefixed by a section letter ("J 62.01").
const CAEM_RE = /(?:^|[^\d.])(\d{2}\.\d{1,2}(?:\.\d{1,2})?)(?!\d)(?!\.\d)/g;
export function extractActivityCodes(...texts) {
    const out = new Set();
    for (const t of texts) {
        const s = Array.isArray(t) ? t.join('; ') : cellText(t);
        for (const m of s.matchAll(CAEM_RE)) out.add(m[1]);
    }
    return [...out];
}

// ---------- Status ----------

export function statusCategory(rawStatus, liquidationDate) {
    const n = norm(rawStatus);
    if (/proces de lichidare|in lichidare|lichidare|insolvab|faliment|reorganiz|suspend|v protsesse|likvidats/.test(n)
        && !/\blichidat[ae]?\b|\bradiat/.test(n)) return 'in_process';
    if (/\blichidat|radiat|exclus|likvidirovan|dizolvat|liquidated|deregistered/.test(n)) return 'liquidated';
    if (/\bactiv|inregistrat|in functiune|functioneaza|deistvu|active|registered/.test(n)) return 'active';
    if (!n && liquidationDate) return 'liquidated';
    if (!n) return 'unknown';
    return 'other';
}

// ---------- Record ----------

export function cleanIdno(v) {
    const digits = cellText(v).replace(/\D/g, '');
    return digits.length === 13 ? digits : null;
}

/** Convert one parsed row ({ field -> cellValue }) into a compact normalized record for the cache. */
export function normalizeRow(fields, raw) {
    const idno = cleanIdno(fields.idno);
    const name = cellText(fields.name);
    if (!idno || !name) return null;
    const activities = splitList(fields.activities ?? fields.activitiesUnlicensed);
    const licensedActivities = splitList(fields.activitiesLicensed);
    const legalForm = cellText(fields.legalForm) || null;
    const status = cellText(fields.status) || null;
    const liquidationDate = toIsoDate(fields.liquidationDate);
    return {
        idno,
        name,
        legalForm,
        legalFormCode: legalFormCode(legalForm),
        status,
        statusCategory: statusCategory(status, liquidationDate),
        registrationDate: toIsoDate(fields.registrationDate),
        liquidationDate,
        address: cellText(fields.address) || null,
        directors: splitList(fields.directors),
        founders: splitList(fields.founders),
        beneficialOwners: splitList(fields.beneficialOwners),
        activityCodes: extractActivityCodes(activities, licensedActivities),
        activities,
        licensedActivities,
        raw,
    };
}
