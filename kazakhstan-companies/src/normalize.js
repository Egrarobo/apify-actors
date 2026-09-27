// Normalizes raw records from the registry (data.egov.kz gbd_ul) and the statistical register
// (stat.gov.kz) into one flat item with English keys. Original values are kept under `original`.

const s = (v) => {
    if (v === null || v === undefined) return null;
    const t = String(v).replace(/\s+/g, ' ').trim();
    return t && !/^[\s.\-–—]+$/.test(t) ? t : null; // the register uses "-" as a placeholder
};

/** First non-empty value among keys (tolerates naming variants between API versions). */
function pick(obj, ...keys) {
    if (!obj) return null;
    for (const k of keys) {
        const v = s(obj[k]);
        if (v) return v;
    }
    return null;
}

/** "2004-07-23T00:00:00", "2004-07-23", "23.07.2004", epoch ms -> "2004-07-23". */
export function toIsoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && v > 1e11) return new Date(v).toISOString().slice(0, 10);
    const t = String(v).trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
}

/** Lowercase, unify Cyrillic/Kazakh letters and quotes, keep letters/digits only. */
export function normText(v) {
    return String(v ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

// Legal-form words that are noise in name search (Russian, Kazakh, English abbreviations and long forms).
const NAME_STOPWORDS = new Set([
    'тоо', 'жшс', 'ао', 'ак', 'ип', 'ооо', 'зао', 'оао', 'пао', 'llp', 'llc', 'jsc', 'ltd',
    'товарищество', 'с', 'ограниченной', 'ответственностью', 'акционерное', 'общество',
    'жауапкершілігі', 'шектеулі', 'серіктестігі', 'акционерлік', 'қоғамы',
]);

export function nameTokens(v) {
    return normText(v).split(' ').filter((t) => t && !NAME_STOPWORDS.has(t));
}

/** Score 0..1 of a registry record against a name query (all query words must appear). */
export function nameScore(record, query) {
    const q = nameTokens(query);
    if (!q.length) return 0;
    let best = 0;
    for (const n of [record?.nameru, record?.namekz]) {
        if (!n) continue;
        const tokens = nameTokens(n);
        const joined = tokens.join(' ');
        if (!q.every((w) => tokens.some((t) => t.startsWith(w)) || joined.includes(w))) continue;
        let score = q.filter((w) => tokens.includes(w)).length / Math.max(tokens.length, q.length);
        if (joined === q.join(' ')) score = 1;
        best = Math.max(best, 0.5 + score / 2);
    }
    return Number(best.toFixed(3));
}

// Legal forms, matched against Russian and Kazakh full names. Branches/representative offices first.
// JavaScript's \b does not work with Cyrillic, so abbreviations use a Unicode-aware word boundary.
const w = (abbr) => new RegExp(`(?<![\\p{L}\\p{N}])${abbr}(?![\\p{L}\\p{N}])`, 'u');
const LEGAL_FORMS = [
    ['BRANCH', [/^филиал|\sфилиал|филиалы(?![\p{L}])/u]],
    ['REPRESENTATIVE_OFFICE', [/представительство|өкілдігі/]],
    ['LLP', [/товарищество с ограниченной ответственностью|жауапкершілігі шектеулі серіктестігі/, w('тоо'), w('жшс'), w('llp')]],
    ['ALP', [/товарищество с дополнительной ответственностью|қосымша жауапкершілігі бар серіктестігі/, w('тдо')]],
    ['JSC', [/акционерное общество|акционерлік қоғам/, w('ао'), w('ақ'), w('jsc')]],
    ['STATE_ENTERPRISE', [/государственное предприятие|коммунальное предприятие|мемлекеттік кәсіпорн|коммуналдық мемлекеттік кәсіпорн/, w('ргп'), w('гкп')]],
    ['STATE_INSTITUTION', [/государственное учреждение|мемлекеттік мекеме/, w('гу'), w('мм')]],
    ['COOPERATIVE', [/кооператив/]],
    ['PUBLIC_ASSOCIATION', [/общественное объединение|қоғамдық бірлестігі/, w('оо'), w('қб')]],
    ['FOUNDATION', [w('фонд'), w('қоры'), /корпоративный фонд|общественный фонд/]],
    ['INSTITUTION', [/учреждение|мекемесі/]],
    ['ASSOCIATION', [/ассоциация|объединение юридических лиц|қауымдастығы/, w('союз')]],
];

export function legalFormCode(...names) {
    for (const n of names) {
        const t = String(n ?? '').toLowerCase();
        if (!t) continue;
        for (const [code, patterns] of LEGAL_FORMS) if (patterns.some((re) => re.test(t))) return code;
    }
    return null;
}

/** Registry status text (ru/kz) -> active | liquidated | suspended | in_process | unknown | other. */
export function statusCategory(...statuses) {
    const t = statuses.filter(Boolean).join(' | ').toLowerCase();
    if (!t) return 'unknown';
    if (/ликвид|снят с регистр|исключ|прекращ|таратыл|жойыл|тіркеуден шығар|liquidat|deregist/.test(t)) return 'liquidated';
    if (/приостан|тоқтатыл|бездейств|suspend|inactive/.test(t)) return 'suspended';
    if (/банкрот|реорганиз|в процессе|процесс|банкрот|қайта ұйымдастыр|bankrupt|reorgani/.test(t)) return 'in_process';
    if (/зарегистр|действ|тіркелген|әрекет|registered|active/.test(t)) return 'active';
    return 'other';
}

/** "62010 Разработка ПО" / "62.01.0 - ..." / "Разработка ПО" -> { code, name }. */
export function splitActivity(v) {
    const t = s(v);
    if (!t) return { code: null, name: null };
    const m = t.match(/^(\d{2}(?:\.?\d){1,4})\s*[-–—:.]?\s*(.*)$/);
    if (m) return { code: m[1], name: s(m[2]) };
    return { code: null, name: t };
}

function codeName(obj, codeKeys, nameKeys) {
    const code = pick(obj, ...codeKeys);
    const name = pick(obj, ...nameKeys);
    return code || name ? { code, name } : null;
}

function splitCodes(v) {
    if (Array.isArray(v)) return v.map(s).filter(Boolean);
    const t = s(v);
    return t ? t.split(/[,;\s]+/).filter(Boolean) : [];
}

/**
 * Builds the output item.
 * @param bin          normalized BIN (null for name-search hits without a BIN)
 * @param registry     raw registry record or null
 * @param statistics   raw statistical record or null
 * @param language     'ru' | 'kz' | 'en'
 */
export function buildItem({ bin, registry, statistics, language, binInfo, includeOriginal }) {
    const reg = registry ?? {};
    const st = statistics ?? {};
    const kz = language === 'kz';

    const nameRu = pick(reg, 'nameru', 'name_ru');
    const nameKz = pick(reg, 'namekz', 'name_kz');
    const statName = pick(st, 'name', 'nameRu', 'fullName');
    const name = (kz ? nameKz ?? nameRu : nameRu ?? nameKz) ?? statName;

    const addressRu = pick(reg, 'addressru', 'address_ru');
    const addressKz = pick(reg, 'addresskz', 'address_kz');
    const statusRu = pick(reg, 'statusru', 'status_ru');
    const statusKz = pick(reg, 'statuskz', 'status_kz');
    const activityRu = splitActivity(pick(reg, 'okedru', 'oked_ru'));
    const activityKz = splitActivity(pick(reg, 'okedkz', 'oked_kz'));

    const statActivity = codeName(st, ['okedCode'], ['okedName']);
    const regActivity = kz ? (activityKz.name ? activityKz : activityRu) : (activityRu.name ? activityRu : activityKz);
    const primaryActivity = statActivity?.code
        ? { code: statActivity.code, name: statActivity.name ?? regActivity.name }
        : (regActivity.code || regActivity.name ? regActivity : null);

    const item = {
        found: true,
        bin: bin ?? s(reg.bin) ?? s(st.bin),
        name,
        nameRu,
        nameKz,
        legalFormCode: legalFormCode(nameRu, nameKz, statName),
        registrationDate: toIsoDate(reg.datereg ?? reg.date_reg) ?? toIsoDate(st.registerDate ?? st.registrationDate),
        status: (kz ? statusKz ?? statusRu : statusRu ?? statusKz) ?? pick(st, 'statusName', 'status'),
        statusCategory: statusCategory(statusRu, statusKz, pick(st, 'statusName', 'status')),
        address: (kz ? addressKz ?? addressRu : addressRu ?? addressKz) ?? pick(st, 'katoAddress'),
        addressRu,
        addressKz,
        katoCode: pick(st, 'katoCode'),
        katoAddress: pick(st, 'katoAddress'),
        director: pick(reg, 'director') ?? pick(st, 'fio', 'director'),
        primaryActivity,
        secondaryActivityCodes: splitCodes(st.secondOkeds ?? st.secondaryOkeds),
        size: codeName(st, ['krpCode'], ['krpName']),
        sizeExcludingBranches: codeName(st, ['krpBfCode'], ['krpBfName']),
        economicSector: codeName(st, ['kseCode'], ['kseName']),
        ownershipForm: codeName(st, ['kfsCode'], ['kfsName']),
        binInfo: binInfo ?? null,
    };
    if (includeOriginal) {
        item.original = {};
        if (registry) item.original.registry = registry;
        if (statistics) item.original.statistics = statistics;
    }
    return item;
}
