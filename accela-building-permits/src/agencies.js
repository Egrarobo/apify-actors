// Known Accela Citizen Access (ACA) agencies.
//
// `evidence` says how the portal was checked (September 2026). The shell used to build this Actor cannot reach
// the portals, so nothing here was loaded live:
//   "search-page"  a search engine has the agency's CapHome.aspx record-search page for this module indexed
//                  (page title such as "Search for Building Permits - Accela Citizen Access").
//   "code"         the portal/module is used by working open-source scraper code (see README).
//   "portal-only"  the agency's ACA portal exists, but the public search page for the module was not confirmed.
// Any other code works too: pass it (or a full portal URL) in "Other agencies".

export const ACA_HOST = 'https://aca-prod.accela.com';

export const AGENCIES = [
    { code: 'PINELLAS', name: 'Pinellas County', state: 'FL', module: 'Building', evidence: 'code' },
    { code: 'HCFL', name: 'Hillsborough County', state: 'FL', module: 'Building', evidence: 'search-page' },
    { code: 'TAMPA', name: 'Tampa', state: 'FL', module: 'Building', evidence: 'search-page' },
    { code: 'PASCO', name: 'Pasco County', state: 'FL', module: 'Building', evidence: 'search-page' },
    { code: 'CLEARWATER', name: 'Clearwater', state: 'FL', module: 'Building', evidence: 'search-page' },
    { code: 'WESTON', name: 'Weston', state: 'FL', module: 'Building', evidence: 'search-page' },
    { code: 'SACRAMENTO', name: 'Sacramento', state: 'CA', module: 'Building', evidence: 'search-page' },
    { code: 'SANTACLARA', name: 'Santa Clara', state: 'CA', module: 'Building', evidence: 'search-page' },
    { code: 'ONT', name: 'Ontario', state: 'CA', module: 'Building', evidence: 'search-page' },
    { code: 'SJCO', name: 'San Joaquin County', state: 'CA', module: 'Building', evidence: 'search-page' },
    { code: 'LANCASTER', name: 'Lancaster', state: 'CA', module: 'Permits', evidence: 'search-page' },
    { code: 'OAKLAND', name: 'Oakland', state: 'CA', module: 'Building', evidence: 'portal-only' },
    { code: 'CLARKCO', name: 'Clark County', state: 'NV', module: 'Building', evidence: 'search-page' },
    { code: 'PIMA', name: 'Pima County', state: 'AZ', module: 'Building', evidence: 'search-page' },
    { code: 'SLCREF', name: 'Salt Lake City', state: 'UT', module: 'Building', evidence: 'search-page' },
    { code: 'DENVER', name: 'Denver', state: 'CO', module: 'Development', evidence: 'search-page' },
    { code: 'ATLANTA_GA', name: 'Atlanta', state: 'GA', module: 'Building', evidence: 'search-page' },
    { code: 'LJCMG', name: 'Louisville / Jefferson County', state: 'KY', module: 'Building', evidence: 'search-page' },
    { code: 'LEXKY', name: 'Lexington', state: 'KY', module: 'Building', evidence: 'search-page' },
    { code: 'INDY', name: 'Indianapolis', state: 'IN', module: 'Permits', evidence: 'search-page' },
    { code: 'OKC', name: 'Oklahoma City', state: 'OK', module: 'Permits', evidence: 'search-page' },
    { code: 'CVB', name: 'Virginia Beach', state: 'VA', module: 'Permits', evidence: 'search-page' },
    { code: 'AACO', name: 'Anne Arundel County', state: 'MD', module: 'Permits', evidence: 'search-page' },
    { code: 'CABARRUS', name: 'Cabarrus County', state: 'NC', module: 'Permits', evidence: 'search-page' },
    { code: 'CLACKAMAS', name: 'Clackamas County', state: 'OR', module: 'Building', evidence: 'search-page' },
    { code: 'COWLITZ', name: 'Cowlitz County', state: 'WA', module: 'Permits', evidence: 'search-page' },
    { code: 'PHARR', name: 'Pharr', state: 'TX', module: 'Building', evidence: 'search-page' },
    { code: 'FORTWORTH', name: 'Fort Worth', state: 'TX', module: 'Development', evidence: 'search-page', baseUrl: 'https://accela.fortworthtexas.gov/CitizenAccess' },
    { code: 'DALLASTX', name: 'Dallas (DallasNow)', state: 'TX', module: 'Building', evidence: 'portal-only' },
    { code: 'COSA', name: 'San Antonio', state: 'TX', module: 'Building', evidence: 'portal-only' },
    { code: 'FTL', name: 'Fort Lauderdale', state: 'FL', module: 'Permits', evidence: 'portal-only' },
    { code: 'SANDIEGO', name: 'San Diego County', state: 'CA', module: 'Building', evidence: 'portal-only' },
];

// Two agencies by default (and in the prefilled example), so one portal being down does not leave the run empty.
export const DEFAULT_AGENCIES = ['PINELLAS', 'HCFL'];

const byCode = new Map(AGENCIES.map((a) => [a.code.toUpperCase(), a]));

export const findAgency = (code) => byCode.get(String(code ?? '').trim().toUpperCase()) ?? null;

/**
 * Turns "TAMPA", "tampa", "https://aca-prod.accela.com/TAMPA/Cap/CapHome.aspx?module=Building" or a self-hosted
 * portal URL ("https://accela.fortworthtexas.gov/CitizenAccess/Cap/CapHome.aspx?module=Development") into
 * { code, name, state, baseUrl, module, evidence }. Returns null when the value is neither a code nor a portal URL.
 *
 * `hostOverride` (tests / self-hosted mirrors) replaces https://aca-prod.accela.com for codes.
 */
export function resolveAgency(value, { hostOverride = null } = {}) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const host = (hostOverride || ACA_HOST).replace(/\/+$/, '');
    if (/^https?:\/\//i.test(raw)) {
        let u;
        try {
            u = new URL(raw);
        } catch {
            return null;
        }
        // The portal root is everything before "/Cap/", "/Default.aspx", "/Welcome.aspx", ... (case-insensitive).
        const path = u.pathname.replace(/\/+$/, '');
        const m = path.match(/^(.*?)(?:\/(?:cap|default\.aspx|welcome\.aspx|login\.aspx|dashboard\.aspx|account)(?:\/|$).*)?$/i);
        const rootPath = (m?.[1] ?? path) || '';
        const segs = rootPath.split('/').filter(Boolean);
        const module = [...u.searchParams.entries()].find(([k]) => k.toLowerCase() === 'module')?.[1] || null;
        const onAcaHost = u.hostname.toLowerCase() === 'aca-prod.accela.com';
        const code = (onAcaHost ? segs[0] : segs[segs.length - 1] || u.hostname.split('.')[0] || 'ACA').toUpperCase();
        const known = onAcaHost ? findAgency(code) : AGENCIES.find((a) => a.baseUrl && raw.toLowerCase().startsWith(a.baseUrl.toLowerCase()));
        return {
            code: known?.code ?? code,
            name: known?.name ?? null,
            state: known?.state ?? null,
            module: module || known?.module || null,
            evidence: known?.evidence ?? 'user-url',
            baseUrl: `${u.origin}${rootPath}`,
            moduleFromUrl: !!module,
        };
    }
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(raw)) return null;
    const known = findAgency(raw);
    const code = known?.code ?? raw.toUpperCase();
    return {
        code,
        name: known?.name ?? null,
        state: known?.state ?? null,
        module: known?.module ?? null,
        evidence: known?.evidence ?? 'user-code',
        baseUrl: known?.baseUrl && !hostOverride ? known.baseUrl : `${host}/${code}`,
        moduleFromUrl: false,
    };
}
