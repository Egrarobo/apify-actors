// Unit tests: parsers against the real ACA detail page and the reconstructed search pages, plus helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDetail, parseSearchForm, parseResults, serializeForm, setField, csvToRows, parseCsv, findExportUrl, findBlockMarkers, acaErrorMessage, parseContactLines, isDetailPage } from '../src/parse.js';
import { splitAddress, categorize, buildMatcher, isoDate, keywordCategory } from '../src/normalize.js';
import { resolveAgency, AGENCIES } from '../src/agencies.js';
import { parseInput, dateWindows, InputError } from '../src/input.js';
import { capHomePage, resultsGrid, errorPage } from './fixtures/aca-pages.mjs';
import { makePermits } from './mock-server.mjs';

const REAL = readFileSync(new URL('./fixtures/capdetail-ljcmg-real.html', import.meta.url), 'utf8');

test('real CapDetail page (LJCMG): record, status, location, description, owner, parcel, more details', () => {
    assert.equal(isDetailPage(REAL), true);
    const d = parseDetail(REAL, 'https://aca-prod.accela.com/LJCMG/Cap/CapDetail.aspx?x=1');
    assert.equal(d.recordNumber, 'ENF-PMNT-24-012338');
    assert.equal(d.recordType, 'Property Maintenance Case');
    assert.equal(d.status, 'Hearing');
    assert.equal(d.address, '100 SAMPLE AVE, LOUISVILLE KY 40212');
    assert.match(d.description, /grass is knee high/);
    assert.equal(d.owner.name, 'SAMPLE OWNER TRUST');
    assert.equal(d.owner.address, '100 EXAMPLE PKWY PMB 1, LOUISVILLE KY 40222-0000');
    assert.equal(d.parcelNumber, '011B00630000');
    assert.equal(d.moreDetails['Hearing Schedule Date'], '09/22/2025');
    assert.equal(d.valuation, null);
    assert.equal(d.contractor, null);
});

test('real CapDetail page: ASP.NET form serialization keeps hidden fields incl. ACA_CS_FIELD, skips file inputs', () => {
    const f = serializeForm(REAL, 'https://aca-prod.accela.com/LJCMG/Cap/CapDetail.aspx');
    const names = f.fields.map(([k]) => k);
    for (const n of ['__EVENTTARGET', '__EVENTARGUMENT', '__VIEWSTATE', '__VIEWSTATEGENERATOR', '__VIEWSTATEENCRYPTED', 'ACA_CS_FIELD']) assert.ok(names.includes(n), n);
    assert.equal(f.fields.find(([k]) => k === 'ACA_CS_FIELD')[1], '1a55226d92124146917d0473362809c6');
    assert.equal(f.action, 'https://aca-prod.accela.com/LJCMG/Cap/CapDetail.aspx?Module=Enforcement&capID1=24REC&capID2=00000&capID3=F0452&agencyCode=LJCMG');
    const set = setField(f.fields, '__EVENTTARGET', 'x$y');
    assert.equal(set.find(([k]) => k === '__EVENTTARGET')[1], 'x$y');
});

test('search form: date fields, record types, search target, CAPTCHA and modules', () => {
    const html = capHomePage({ agency: 'TEST', module: 'Building', viewstate: 'vs', csField: 'cs', recordTypes: [{ value: 'Residential Roofing', text: 'Residential Roofing' }] });
    const f = parseSearchForm(html);
    assert.equal(f.ok, true);
    assert.equal(f.startName, 'ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate');
    assert.equal(f.endName, 'ctl00$PlaceHolderMain$generalSearchForm$txtGSEndDate');
    assert.equal(f.typeName, 'ctl00$PlaceHolderMain$generalSearchForm$ddlGSPermitType');
    assert.deepEqual(f.recordTypes, [{ value: 'Residential Roofing', text: 'Residential Roofing' }]);
    assert.equal(f.searchTarget, 'ctl00$PlaceHolderMain$btnNewSearch');
    assert.equal(f.captcha, false);
    assert.deepEqual(f.modules, ['Home', 'Building', 'Enforcement', 'Planning']);
    assert.equal(parseSearchForm(capHomePage({ agency: 'T', module: 'Building', viewstate: 'v', csField: 'c', recordTypes: [], captcha: true })).captcha, true);
    assert.equal(parseSearchForm(REAL).ok, false, 'a detail page has no date search');
});

test('results grid: header-based mapping (leading checkbox column), links, pager, export link', () => {
    const rows = makePermits('TEST', 3);
    const cols = ['', 'Date', 'Record Number', 'Record Type', 'Description', 'Project Name', 'Status', 'Address', 'Expiration Date'];
    const grid = resultsGrid({ agency: 'TEST', module: 'Building', columns: cols, rows, total: 23, exportTarget: 'exp$btnExport', pager: { page: 2, pages: 3, targets: { 1: 'p$1', 2: 'p$2', 3: 'p$3' }, nextTarget: 'p$next', prevTarget: 'p$prev' } });
    const r = parseResults(capHomePage({ agency: 'TEST', module: 'Building', viewstate: 'v', csField: 'c', recordTypes: [], results: grid }), 'https://aca-prod.accela.com/TEST/Cap/CapHome.aspx?module=Building');
    assert.equal(r.grid, true);
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows[0].byKey.recordNumber, rows[0].number);
    assert.equal(r.rows[0].byKey.openedDate, rows[0].date);
    assert.equal(r.rows[0].byKey.address, rows[0].address);
    assert.equal(r.rows[0].byKey.status, rows[0].status);
    assert.match(r.rows[0].detailHref, /^https:\/\/aca-prod\.accela\.com\/TEST\/Cap\/CapDetail\.aspx\?Module=Building&TabName=Building&capID1=/);
    assert.equal(r.currentPage, 2);
    assert.equal(r.nextTarget, 'p$next');
    assert.equal(r.exportTarget, 'exp$btnExport');
    assert.equal(r.countText, 'Showing 11-13 of 23');

    const last = resultsGrid({ agency: 'TEST', module: 'Building', columns: cols, rows, total: 23, pager: { page: 3, pages: 3, targets: { 1: 'p$1', 2: 'p$2', 3: 'p$3' }, nextTarget: 'p$next', prevTarget: 'p$prev' } });
    assert.equal(parseResults(last, 'https://x/').nextTarget, null, 'no Next on the last page');
    // Pager without a "Next" link: page current+1 is used.
    const noNext = last.replace(/<td><a href="javascript:__doPostBack\('p\$prev','[^']*'\)"[^>]*>&lt; Prev<\/a><\/td>/, '').replace('<span class="SelectedPageButton font11px">3</span>', '<a href="javascript:__doPostBack(\'p$3\',\'\')">3</a>').replace(/<a href="javascript:__doPostBack\('p\$1',''\)"[^>]*>1<\/a>/, '<span class="SelectedPageButton">1</span>');
    assert.equal(parseResults(noNext, 'https://x/').nextTarget, 'p$2');
});

test('results page: "no results" and ACA error page', () => {
    const r = parseResults(capHomePage({ agency: 'T', module: 'Building', viewstate: 'v', csField: 'c', recordTypes: [], results: '<span class="ACA_Message_Notice">Your search returned no results.</span>' }), 'https://x/');
    assert.equal(r.grid, false);
    assert.equal(r.noResults, true);
    assert.equal(acaErrorMessage(errorPage()), 'An error has occurred. Your session may have expired. Please return to the home page.');
    assert.equal(acaErrorMessage(REAL), null);
});

test('CSV export parsing (quotes, BOM, CRLF) and follow-up export URL detection', () => {
    const csv = '﻿Date,Record Number,Record Type,Description,Project Name,Status,Address,Expiration Date\r\n09/25/2026,BLD-26-1,Residential Roofing,"Re-roof, 20 sq ""shingle""",,Issued,"1 MAIN ST, TAMPA FL 33602",03/24/2027\r\n';
    assert.equal(parseCsv(csv).length, 2);
    const rows = csvToRows(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].byKey.description, 'Re-roof, 20 sq "shingle"');
    assert.equal(rows[0].byKey.address, '1 MAIN ST, TAMPA FL 33602');
    assert.equal(csvToRows('a,b\n1,2'), null, 'not an ACA export');
    assert.equal(findExportUrl("<script>window.open('../Cap/Export.ashx?token=ab&amp;flag=csv');</script>", 'https://h/AG/Cap/CapHome.aspx'), 'https://h/AG/Cap/Export.ashx?token=ab&flag=csv');
    assert.equal(findExportUrl('1|#||4|123|pageRedirect||%2FAG%2FExport%2FDownload.aspx%3Fid%3D5|', 'https://h/AG/Cap/CapHome.aspx'), 'https://h/AG/Export/Download.aspx?id=5');
    assert.equal(findExportUrl('<html>nothing</html>', 'https://h/'), null);
});

test('contact blocks: licensed professional, applicant', () => {
    const lp = parseContactLines(['JOHN SMITH', 'SUNCOAST ROOFING LLC', '500 INDUSTRIAL WAY', 'LARGO, FL, 33771', 'Work Phone:7275551234', 'Certified Roofing Contractor CCC1330001']);
    assert.deepEqual(lp, { name: 'JOHN SMITH', company: 'SUNCOAST ROOFING LLC', address: '500 INDUSTRIAL WAY, LARGO, FL, 33771', phone: '(727) 555-1234', email: null, license: 'CCC1330001', licenseType: 'Certified Roofing Contractor' });
    const biz = parseContactLines(['ABC ROOFING INC', 'Business Phone: (813) 555-0101', 'Contractor License #RC29027']);
    assert.equal(biz.company, 'ABC ROOFING INC');
    assert.equal(biz.phone, '(813) 555-0101');
    assert.equal(biz.license, 'RC29027');
});

test('block markers', () => {
    assert.deepEqual(findBlockMarkers('<title>Just a moment...</title><script>_cf_chl_opt</script>'), ['Cloudflare challenge page', 'Cloudflare challenge script']);
    assert.deepEqual(findBlockMarkers(REAL), []);
});

test('address split, dates, categories, matcher', () => {
    assert.deepEqual(splitAddress('3920 PFLANZ AVE, LOUISVILLE KY 40212 *'), { street: '3920 PFLANZ AVE', city: 'Louisville', state: 'KY', zip: '40212' });
    assert.deepEqual(splitAddress('4501 W GANDY BLVD N UNIT 3 TAMPA FL 33611'), { street: '4501 W GANDY BLVD N UNIT 3', city: 'Tampa', state: 'FL', zip: '33611' });
    assert.deepEqual(splitAddress('123 Main St, Palm Harbor, FL, 34683-1234'), { street: '123 Main St', city: 'Palm Harbor', state: 'FL', zip: '34683' });
    assert.equal(splitAddress('LOT 5 SUNSET HILLS').city, null);
    assert.equal(isoDate('9/5/2026'), '2026-09-05');
    assert.equal(isoDate(''), null);
    assert.equal(categorize('Residential Solar', 'roof mounted PV'), 'solar', 'record type wins over description');
    assert.equal(categorize('Building/Residential/Reroof/NA'), 'roofing');
    assert.equal(categorize('Residential Mechanical', 'A/C change-out'), 'hvac');
    assert.equal(categorize('Design Review'), 'other', '"sign" must not match "design"');
    assert.equal(keywordCategory('roof'), 'roofing');
    assert.equal(keywordCategory('new'), 'new-construction');
    assert.equal(keywordCategory('kitchen'), null);
    const m = buildMatcher({ permitTypes: ['roof', 'kitchen'], excludeKeywords: ['commercial'] });
    assert.deepEqual(m({ recordType: 'Residential Remodel', description: 'Kitchen remodel and new roof', category: 'remodel' }), { ok: true, matched: ['roof', 'kitchen'] });
    assert.equal(m({ recordType: 'Residential Solar', description: 'roof mounted', category: 'solar' }).ok, false);
    assert.equal(m({ recordType: 'Commercial Re-Roof', category: 'roofing' }).ok, false, 'excluded');
});

test('agency resolution: codes, ACA URLs, self-hosted URLs, host override', () => {
    assert.equal(AGENCIES.length >= 25, true);
    const t = resolveAgency('tampa');
    assert.deepEqual([t.code, t.baseUrl, t.module, t.state], ['TAMPA', 'https://aca-prod.accela.com/TAMPA', 'Building', 'FL']);
    const u = resolveAgency('https://aca-prod.accela.com/INDY/Cap/CapHome.aspx?module=Permits&TabName=HOME');
    assert.deepEqual([u.code, u.baseUrl, u.module, u.moduleFromUrl], ['INDY', 'https://aca-prod.accela.com/INDY', 'Permits', true]);
    const fw = resolveAgency('https://accela.fortworthtexas.gov/CitizenAccess/Cap/CapHome.aspx?TabName=Home&module=Development');
    assert.deepEqual([fw.code, fw.baseUrl, fw.module], ['FORTWORTH', 'https://accela.fortworthtexas.gov/CitizenAccess', 'Development']);
    const other = resolveAgency('https://permits.example.gov/CitizenAccess/Default.aspx');
    assert.deepEqual([other.code, other.baseUrl, other.module], ['CITIZENACCESS', 'https://permits.example.gov/CitizenAccess', null]);
    assert.equal(resolveAgency('SPOKANE', { hostOverride: 'http://127.0.0.1:9' }).baseUrl, 'http://127.0.0.1:9/SPOKANE');
    assert.equal(resolveAgency('not a code!'), null);
});

test('input: defaults, windows, validation', () => {
    const now = Date.parse('2026-09-27T16:00:00Z');
    const c = parseInput({}, { now });
    assert.deepEqual(c.agencies.map((a) => a.code), ['PINELLAS']);
    assert.deepEqual([c.dateFrom, c.dateTo, c.maxRecordsPerAgency, c.exportMode], ['2026-09-21', '2026-09-27', 500, 'auto']);
    const d = parseInput({ agencies: ['INDY'], customAgencies: ['https://aca-prod.accela.com/TAMPA/Cap/CapHome.aspx?module=Planning', 'indy'], module: 'Building', dateFrom: '09/01/2026' }, { now });
    assert.deepEqual(d.agencies.map((a) => `${a.code}/${a.module}`), ['INDY/Building', 'TAMPA/Planning'], 'module override, URL module wins, duplicates removed');
    assert.equal(d.dateFrom, '2026-09-01');
    assert.deepEqual(dateWindows('2026-09-01', '2026-09-20', 7), [{ from: '2026-09-14', to: '2026-09-20' }, { from: '2026-09-07', to: '2026-09-13' }, { from: '2026-09-01', to: '2026-09-06' }]);
    for (const bad of [{ dateFrom: '2026-09-10', dateTo: '2026-09-01' }, { customAgencies: ['no spaces allowed!'] }, { exportMode: 'xls' }, { lastNDays: 0 }, { dateFrom: 'last spring' }]) {
        assert.throws(() => parseInput(bad, { now }), InputError, JSON.stringify(bad));
    }
});
