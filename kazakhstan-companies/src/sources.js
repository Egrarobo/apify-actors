// Official sources.
//
// 1. REGISTRY: State register of legal entities (Ministry of Justice), dataset "gbd_ul" on the
//    government open-data portal data.egov.kz (https://data.egov.kz/datasets/view?index=gbd_ul).
//    a) Without an API key: the portal's own dataset-viewer endpoint /datasets/getdata (the same
//       call the portal page makes and that OpenSanctions' kz_companies crawler uses weekly).
//       Returns { elements: [...], totalPages }. `text` is the viewer's search box.
//    b) With a free API key (data.egov.kz "programmer's cabinet"): the documented API
//       /api/v4/gbd_ul/v1?apiKey=...&source={elasticsearch-like query}.
// 2. STATISTICS: Bureau of National Statistics BIN search API (stat.gov.kz business register):
//    /api/juridical/counter/api/?bin=...&lang=ru|kz|en on old.stat.gov.kz. Returns { success, obj }.

export const REGISTRY = 'registry';
export const STATISTICS = 'statistics';

export const SOURCE_INFO = {
    [REGISTRY]: {
        name: 'State register of legal entities (Ministry of Justice of the Republic of Kazakhstan) via data.egov.kz',
        pageUrl: 'https://data.egov.kz/datasets/view?index=gbd_ul',
    },
    [STATISTICS]: {
        name: 'Statistical business register (Bureau of National Statistics, stat.gov.kz)',
        pageUrl: 'https://stat.gov.kz/en/juridical/by/bin/',
    },
};

const DEFAULT_EGOV = 'https://data.egov.kz';
const DEFAULT_STAT = 'https://old.stat.gov.kz';
const EGOV_PAGE_SIZE = 50;

export function createSources({ http, apiBaseUrl = null, egovApiKey = null }) {
    const egovBase = (apiBaseUrl ?? DEFAULT_EGOV).replace(/\/+$/, '');
    const statBase = (apiBaseUrl ?? DEFAULT_STAT).replace(/\/+$/, '');
    const egovHeaders = { referer: 'https://data.egov.kz/datasets/view?index=gbd_ul', 'x-requested-with': 'XMLHttpRequest' };

    function viewerUrl(text, page, count) {
        const qs = new URLSearchParams({ index: 'gbd_ul', version: 'v1', page: String(page), count: String(count), text, column: 'id', order: 'ascending' });
        return `${egovBase}/datasets/getdata?${qs}`;
    }

    function apiUrl(source) {
        const qs = new URLSearchParams({ apiKey: egovApiKey, source: JSON.stringify(source) });
        return `${egovBase}/api/v4/gbd_ul/v1?${qs}`;
    }

    // Records from either response shape (viewer: {elements}, API v4: array or {hits}).
    function extractRecords(json) {
        if (Array.isArray(json)) return json;
        if (Array.isArray(json?.elements)) return json.elements;
        if (Array.isArray(json?.hits?.hits)) return json.hits.hits.map((h) => h._source ?? h);
        if (Array.isArray(json?.data)) return json.data;
        return [];
    }

    /** Registry record(s) with exactly this BIN (a register can list the same BIN more than once, e.g. history). */
    async function registryByBin(bin) {
        let url;
        if (egovApiKey) url = apiUrl({ size: 10, query: { bool: { must: [{ match: { bin } }] } } });
        else url = viewerUrl(bin, 1, 20);
        const { json } = await http.getJson(url, { sourceName: 'data.egov.kz state register', headers: egovHeaders });
        return { url: redact(url), records: extractRecords(json).filter((r) => String(r?.bin ?? '').trim() === bin) };
    }

    /** Registry full-text name search. Returns up to `max` raw records (not yet filtered/ranked). */
    async function registryByName(name, max) {
        const out = [];
        const urls = [];
        if (egovApiKey) {
            const url = apiUrl({
                size: Math.min(max * 3, 500),
                query: { bool: { should: [
                    { match: { nameru: { query: name, operator: 'and' } } },
                    { match: { namekz: { query: name, operator: 'and' } } },
                ] } },
            });
            const { json } = await http.getJson(url, { sourceName: 'data.egov.kz state register', headers: egovHeaders });
            urls.push(redact(url));
            out.push(...extractRecords(json));
        } else {
            // Fetch a few pages: the viewer's search also matches addresses etc., results are filtered afterwards.
            const want = Math.min(max * 3, 300);
            for (let page = 1; out.length < want && page <= Math.ceil(want / EGOV_PAGE_SIZE); page++) {
                const url = viewerUrl(name, page, EGOV_PAGE_SIZE);
                const { json } = await http.getJson(url, { sourceName: 'data.egov.kz state register', headers: egovHeaders });
                urls.push(url);
                const recs = extractRecords(json);
                out.push(...recs);
                const totalPages = Number(json?.totalPages ?? 1);
                if (!recs.length || page >= totalPages) break;
            }
        }
        return { urls, records: out };
    }

    /** Statistical register card for a BIN, or null when the BIN is unknown. */
    async function statisticsByBin(bin, lang) {
        const url = `${statBase}/api/juridical/counter/api/?${new URLSearchParams({ bin, lang })}`;
        const { status, json } = await http.getJson(url, { sourceName: 'stat.gov.kz statistical register' });
        const obj = json?.obj ?? null;
        if (status === 404 || !json || json.success === false || !obj || (typeof obj === 'object' && !Object.keys(obj).length)) {
            return { url, record: null };
        }
        return { url, record: obj };
    }

    return { registryByBin, registryByName, statisticsByBin };
}

function redact(url) {
    return url.replace(/apiKey=[^&]+/, 'apiKey=***');
}
