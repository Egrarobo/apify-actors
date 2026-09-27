// Local mock of aca-prod.accela.com that behaves like an ASP.NET WebForms ACA portal:
//  - GET CapHome.aspx sets ASP.NET_SessionId and returns the search form with a fresh __VIEWSTATE and ACA_CS_FIELD;
//  - every POST must carry the session cookie, the session's ACA_CS_FIELD and a __VIEWSTATE the server issued in
//    that session, else ACA's "An error has occurred." page is returned;
//  - __EVENTTARGET btnNewSearch runs the date search (MM/DD/YYYY), pager targets move between pages (the target of
//    each page link is remembered with the ViewState, like server-side controls), "Download results" exports CSV;
//  - exactly one match redirects to CapDetail.aspx (ACA behaviour);
//  - special agencies simulate blocks, CAPTCHA, login-only modules, unknown agency codes and flaky sessions.
import http from 'node:http';
import crypto from 'node:crypto';
import { capHomePage, resultsGrid, noResults, errorPage, capDetailPage } from './fixtures/aca-pages.mjs';

const DAY = 86_400_000;
const usToday = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mdY = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const fromMdY = (s) => {
    const m = String(s ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

const TYPES = [
    { type: 'Residential Roofing', desc: 'Tear off and re-roof {n} squares architectural shingle', value: 16_500, lic: ['Certified Roofing Contractor', 'CCC13'], company: 'SUNCOAST ROOFING LLC' },
    { type: 'Residential Solar', desc: 'Install {n} kW roof mounted photovoltaic system with battery', value: 32_000, lic: ['Certified Solar Contractor', 'CVC57'], company: 'BRIGHT SKY SOLAR INC' },
    { type: 'Residential Pools and Spas', desc: 'New in-ground pool and spa with screen enclosure', value: 68_000, lic: ['Certified Pool/Spa Contractor', 'CPC14'], company: 'BLUE WAVE POOLS INC' },
    { type: 'Residential Mechanical', desc: 'A/C change-out {n} ton heat pump like for like', value: 9_800, lic: ['Certified Air Conditioning Contractor', 'CAC18'], company: 'COOL BREEZE AIR CONDITIONING LLC' },
    { type: 'Residential New Construction', desc: 'New single family dwelling {n} sq ft 2 story', value: 412_000, lic: ['Certified Building Contractor', 'CBC12'], company: 'GULF COAST HOMES LLC' },
    { type: 'Residential Remodel/Repair/Renovation', desc: 'Kitchen remodel, remove non bearing wall', value: 45_000, lic: ['Certified Residential Contractor', 'CRC15'], company: 'PREMIER REMODELING CO' },
    { type: 'Residential Electrical', desc: 'Service upgrade to 200 amp', value: 3_200, lic: ['Certified Electrical Contractor', 'EC130'], company: 'SPARK ELECTRIC INC' },
    { type: 'Commercial Signs', desc: 'Wall sign for retail tenant', value: 5_000, lic: ['Sign Contractor', 'SC-'], company: 'SIGNS NOW' },
];
const STATUSES = ['Issued', 'In Review', 'Received', 'Issued', 'Finaled'];
const STREETS = ['GULF BLVD', 'SEMINOLE BLVD', 'ULMERTON RD', 'EAST LAKE RD', 'BELCHER RD', 'KEENE RD', 'PARK BLVD'];
const CITIES = [['LARGO', '33771'], ['SEMINOLE', '33772'], ['PALM HARBOR', '34683'], ['CLEARWATER', '33764'], ['TARPON SPRINGS', '34689']];

/** Deterministic permits opened over the last `days` days (newest first). */
export function makePermits(agency, count, { days = 20, prefix = 'BLD' } = {}) {
    const today = usToday();
    const out = [];
    for (let i = 0; i < count; i++) {
        const t = TYPES[i % TYPES.length];
        const opened = addDays(today, -Math.floor((i * days) / count));
        const [city, zip] = CITIES[i % CITIES.length];
        const street = `${1000 + i * 37} ${STREETS[i % STREETS.length]}`;
        const n = 10 + (i % 20);
        out.push({
            agency,
            number: `${prefix}-${opened.slice(2, 4)}-${String(4000 + i).padStart(5, '0')}`,
            capID1: `${opened.slice(2, 4)}CAP`,
            capID3: `${prefix[0]}${(1000 + i).toString(36).toUpperCase()}`,
            opened,
            date: mdY(opened),
            expiration: mdY(addDays(opened, 180)),
            type: t.type,
            description: t.desc.replace('{n}', n),
            projectName: i % 3 === 0 ? `${street} ${t.type.split(' ').pop()}` : '',
            status: STATUSES[i % STATUSES.length],
            address: `${street}, ${city} FL ${zip}`,
            addressLines: [street, `${city} FL ${zip}`],
            valuation: t.value + i * 100,
            valuationText: `$${(t.value + i * 100).toLocaleString('en-US')}.00`,
            parcel: `19-29-15-${String(10000 + i).padStart(5, '0')}-000-0100`,
            owner: { name: `OWNER NUMBER ${i}`, street: `${200 + i} OWNER LN`, csz: `${city} FL ${zip}` },
            applicant: { name: `APPLICANT PERSON ${i}`, company: 'PERMIT RUNNERS INC', phone: `813555${String(1000 + i).slice(-4)}`, email: `applicant${i}@example.com` },
            contractor: {
                person: `QUALIFIER ${i}`,
                company: t.company,
                street: `${500 + i} INDUSTRIAL WAY`,
                csz: 'LARGO, FL, 33771',
                phone: `727555${String(2000 + i).slice(-4)}`,
                licenseType: t.lic[0],
                license: `${t.lic[1]}${String(30000 + i)}`,
            },
        });
    }
    return out;
}

const PINELLAS_COLUMNS = ['', 'Date', 'Record Number', 'Record Type', 'Description', 'Project Name', 'Status', 'Address', 'Expiration Date'];
const CLEARWATER_COLUMNS = ['', 'Date', 'Record Number', 'Record Type', 'Description', 'Action', 'Status', 'Short Notes', 'Related Records', 'Address'];

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export async function startMockServer({ pageSize = 10 } = {}) {
    const agencies = {
        PINELLAS: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('PINELLAS', 35), exportMode: 'direct' },
        BIG: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('BIG', 130, { days: 10 }), exportMode: 'direct' },
        CLEARWATER: { module: 'Building', columns: CLEARWATER_COLUMNS, permits: makePermits('CLEARWATER', 14, { prefix: 'BCP' }), exportMode: null },
        EXPORTLINK: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('EXPORTLINK', 25), exportMode: 'handler' },
        BROKENEXPORT: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('BROKENEXPORT', 25), exportMode: 'html' },
        SINGLE: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('SINGLE', 1), exportMode: null },
        FLAKY: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('FLAKY', 12), exportMode: null, flaky: true },
        CAPTCHA: { module: 'Building', columns: PINELLAS_COLUMNS, permits: [], captcha: true },
        LOGINONLY: { module: 'Building', columns: PINELLAS_COLUMNS, permits: [], login: true },
        JSCHALLENGE: { module: 'Building', columns: PINELLAS_COLUMNS, permits: makePermits('JSCHALLENGE', 12), jsChallenge: true },
        BLOCKED: { module: 'Building', columns: PINELLAS_COLUMNS, permits: [], blocked: true },
        INDY: { module: 'Permits', columns: PINELLAS_COLUMNS, permits: makePermits('INDY', 5, { prefix: 'PER' }) },
    };
    const state = { sessions: new Map(), requests: [], notifications: [], laterPermits: {}, blockedCount: 0, flakyFailures: 0 };

    const pageOf = (a, list, page, vs, sess, search) => {
        const pages = Math.max(1, Math.ceil(list.length / pageSize));
        const rows = list.slice((page - 1) * pageSize, page * pageSize);
        // Every rendered pager link gets its own control target, remembered with the ViewState (like ASP.NET).
        const targets = {};
        for (let p = 1; p <= pages; p++) targets[p] = `ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$ctl${String(p).padStart(2, '0')}`;
        const nextTarget = 'ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$lnkNext';
        const prevTarget = 'ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$lnkPrev';
        const exportTarget = a.exportMode ? 'ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$gdvPermitListtop4btnExport' : null;
        const map = { [nextTarget]: page + 1, [prevTarget]: page - 1 };
        for (const [p, t] of Object.entries(targets)) map[t] = Number(p);
        sess.viewstates.set(vs, { search, page, pages, map, exportTarget });
        return resultsGrid({ agency: a.code, module: a.module, columns: a.columns, rows, total: list.length, exportTarget, pager: { page, pages, targets, nextTarget, prevTarget } });
    };

    const newVs = () => `/wEP${crypto.randomBytes(24).toString('base64')}`;

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        for await (const chunk of req) body += chunk;
        state.requests.push({ method: req.method, path: url.pathname, search: url.search, body });
        const send = (status, html, headers = {}) => {
            res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
            res.end(html);
        };

        // ── notification sinks ──
        if (url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/telegram/')) {
            state.notifications.push({ path: url.pathname, body: JSON.parse(body || '{}') });
            return send(200, '{"ok":true}', { 'content-type': 'application/json' });
        }

        const m = url.pathname.match(/^\/([^/]+)\/Cap\/(CapHome|CapDetail|Export)\.(aspx|ashx)$/i);
        const code = m?.[1]?.toUpperCase();
        const a0 = code ? agencies[code] : null;
        if (!a0) return send(404, '<html><head><title>The resource cannot be found.</title></head><body><h1>Server Error in \'/\' Application.</h1><h2><i>The resource cannot be found.</i></h2></body></html>');
        const a = { ...a0, code };

        if (a.blocked) {
            state.blockedCount++;
            return send(403, '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="cf-browser-verification"></div><script>window._cf_chl_opt={}</script></body></html>');
        }

        const cookies = Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
        if (a.jsChallenge && cookies.cf_clearance !== 'ok') {
            // Cloudflare-like JS challenge: only a client that runs JavaScript gets the clearance cookie.
            state.blockedCount++;
            return send(403, '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};document.cookie="cf_clearance=ok; path=/";setTimeout(function(){location.reload()},200);</script></body></html>');
        }
        let sid = cookies['ASP.NET_SessionId'];
        let sess = sid ? state.sessions.get(sid) : null;
        const setCookie = [];
        if (!sess) {
            sid = crypto.randomBytes(12).toString('hex');
            sess = { csField: crypto.randomBytes(16).toString('hex'), viewstates: new Map(), posts: 0 };
            state.sessions.set(sid, sess);
            setCookie.push(`ASP.NET_SessionId=${sid}; path=/; HttpOnly; SameSite=Lax`);
        }
        const headers = setCookie.length ? { 'set-cookie': setCookie } : {};
        const list = (search) => [...a.permits, ...(state.laterPermits[code] ?? [])]
            .filter((p) => p.opened >= search.from && p.opened <= search.to && (!search.type || p.type === search.type))
            .sort((x, y) => (x.opened < y.opened ? 1 : x.opened > y.opened ? -1 : x.number < y.number ? 1 : -1));
        const recordTypes = [...new Set(a.permits.map((p) => p.type))].sort().map((t) => ({ value: t, text: t }));
        const page = (vs, extra) => capHomePage({ agency: code, module: a.module, viewstate: vs, csField: sess.csField, recordTypes, captcha: a.captcha, ...extra });

        if (m[2].toLowerCase() === 'capdetail') {
            const cap3 = url.searchParams.get('capID3');
            const p = [...a.permits, ...(state.laterPermits[code] ?? [])].find((x) => x.capID3 === cap3);
            if (!p || p.brokenDetail) return send(200, errorPage(), headers);
            return send(200, capDetailPage(p), headers);
        }

        if (m[2].toLowerCase() === 'export') {
            const token = url.searchParams.get('token');
            const search = sess.exports?.[token];
            if (!search) return send(200, errorPage(), headers);
            return sendCsv(list(search));
        }

        function sendCsv(rows) {
            const cols = a.columns.filter((c) => c && c !== 'Action');
            const val = (p, c) => ({ Date: p.date, 'Record Number': p.number, 'Record Type': p.type, Description: p.description, 'Project Name': p.projectName, Status: p.status, Address: p.address, 'Expiration Date': p.expiration }[c] ?? '');
            const csv = [cols.join(','), ...rows.map((p) => cols.map((c) => csvCell(val(p, c))).join(','))].join('\r\n');
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="RecordList.csv"', ...headers });
            return res.end(`﻿${csv}`);
        }

        // CapHome
        const moduleParam = [...url.searchParams.entries()].find(([k]) => k.toLowerCase() === 'module')?.[1];
        if (a.login) return send(302, '', { location: `/${code}/Login.aspx?ReturnUrl=${encodeURIComponent(url.pathname + url.search)}`, ...headers });
        if (moduleParam && moduleParam.toLowerCase() !== a.module.toLowerCase()) {
            // Module without a public search: ACA shows the home page (no search form).
            const vs = newVs();
            sess.viewstates.set(vs, {});
            return send(200, capHomePage({ agency: code, module: a.module, viewstate: vs, csField: sess.csField, recordTypes, modules: ['Home', a.module, 'Licenses'] })
                .replace(/<div id="ctl00_PlaceHolderMain_dvSearchForm">[\s\S]*?<\/div>\s*<div id="ctl00_PlaceHolderMain_dgvPermitList_updatePanel">/, '<div id="ctl00_PlaceHolderMain_dgvPermitList_updatePanel">'), headers);
        }
        if (req.method === 'GET') {
            const vs = newVs();
            sess.viewstates.set(vs, { search: null });
            return send(200, page(vs, {}), headers);
        }

        // POST: validate like ASP.NET/ACA.
        const form = new URLSearchParams(body);
        const vsIn = form.get('__VIEWSTATE');
        const vstate = sess.viewstates.get(vsIn);
        if (!sid || setCookie.length || form.get('ACA_CS_FIELD') !== sess.csField || !vstate || form.get('__VIEWSTATEGENERATOR') !== 'A1B2C3D4') {
            return send(200, errorPage(), headers);
        }
        sess.posts++;
        if (a.flaky && sess.posts === 1 && state.flakyFailures < 1) {
            state.flakyFailures++;
            return send(200, errorPage(), headers);
        }
        const target = form.get('__EVENTTARGET');
        const P = 'ctl00$PlaceHolderMain$generalSearchForm$';
        if (target === 'ctl00$PlaceHolderMain$btnNewSearch') {
            const from = fromMdY(form.get(`${P}txtGSStartDate`));
            const to = fromMdY(form.get(`${P}txtGSEndDate`));
            const vs = newVs();
            if (!from || !to) {
                sess.viewstates.set(vs, { search: null });
                return send(200, page(vs, { results: '<span class="ACA_Message_Error">Please enter a valid date (MM/DD/YYYY).</span>' }), headers);
            }
            const search = { from, to, type: form.get(`${P}ddlGSPermitType`) || '' };
            const found = list(search);
            if (found.length === 0) {
                sess.viewstates.set(vs, { search });
                return send(200, page(vs, { start: mdY(from), end: mdY(to), selectedType: search.type, results: noResults() }), headers);
            }
            if (found.length === 1) {
                const p = found[0];
                return send(302, '', { location: `/${code}/Cap/CapDetail.aspx?Module=${a.module}&TabName=${a.module}&capID1=${p.capID1}&capID2=00000&capID3=${p.capID3}&agencyCode=${code}&IsToShowInspection=`, ...headers });
            }
            return send(200, page(vs, { start: mdY(from), end: mdY(to), selectedType: search.type, results: pageOf(a, found, 1, vs, sess, search) }), headers);
        }
        if (vstate.search && vstate.exportTarget && target === vstate.exportTarget) {
            const found = list(vstate.search);
            if (a.exportMode === 'direct') return sendCsv(found);
            if (a.exportMode === 'handler') {
                const token = crypto.randomBytes(6).toString('hex');
                sess.exports ??= {};
                sess.exports[token] = vstate.search;
                const vs = newVs();
                const html = page(vs, { start: mdY(vstate.search.from), end: mdY(vstate.search.to), results: pageOf(a, found, vstate.page, vs, sess, vstate.search) })
                    .replace('</form>', `<script type="text/javascript">window.open('../Cap/Export.ashx?token=${token}&amp;flag=csv');</script></form>`);
                return send(200, html, headers);
            }
            const vs = newVs();
            return send(200, page(vs, { start: mdY(vstate.search.from), end: mdY(vstate.search.to), results: pageOf(a, found, vstate.page, vs, sess, vstate.search) }), headers);
        }
        if (vstate.search && vstate.map?.[target]) {
            const p = vstate.map[target];
            const found = list(vstate.search);
            const vs = newVs();
            return send(200, page(vs, { start: mdY(vstate.search.from), end: mdY(vstate.search.to), selectedType: vstate.search.type, results: pageOf(a, found, p, vs, sess, vstate.search) }), headers);
        }
        return send(200, errorPage(), headers);
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        state,
        agencies,
        posts: (code) => state.requests.filter((r) => r.method === 'POST' && r.path.toUpperCase().startsWith(`/${code}/`)),
        gets: (code, what) => state.requests.filter((r) => r.method === 'GET' && r.path.toUpperCase().startsWith(`/${code}/`) && (!what || r.path.includes(what))),
        reset() {
            state.requests.length = 0;
            state.notifications.length = 0;
            state.laterPermits = {};
            state.flakyFailures = 0;
            state.blockedCount = 0;
        },
        close: () => new Promise((r) => server.close(r)),
    };
}
