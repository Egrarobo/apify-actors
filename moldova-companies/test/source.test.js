// Offline test of the "find the latest official file" logic, with fetch mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLatestSource, dateFromText } from '../src/source.js';

const ckanJson = {
    result: {
        resources: [
            { name: 'Informații la data de 29.01.2024', format: 'XLSX', url: 'https://dataset.gov.md/x/2024.01.29-company.xlsx' },
            { name: 'Informații la data de 14.05.2024', format: 'XLSX', url: 'https://dataset.gov.md/x/company-2024.05.14.xlsx' },
            { name: 'Descriere', format: 'PDF', url: 'https://dataset.gov.md/x/readme.pdf' },
        ],
    },
};
const aspHtml = '<a href="/sites/default/files/date-deschise/date-statistice/2026/rsud/company.xlsx">Date din Registrul</a>'
    + '<a href="/sites/default/files/date-deschise/date-statistice/2026/rsud/RSON.xlsx">ONG</a>';

function mockFetch({ ckan = true, asp = true } = {}) {
    return async (url, opts = {}) => {
        const u = String(url);
        const resp = (body, init = {}) => new Response(body, init);
        if (u.includes('/api/3/action/package_show')) return ckan ? resp(JSON.stringify(ckanJson), { headers: { 'content-type': 'application/json' } }) : resp('no', { status: 503 });
        if (u.includes('date-deschise/date-statistice') && !u.endsWith('.xlsx')) return asp ? resp(aspHtml, { headers: { 'content-type': 'text/html' } }) : resp('no', { status: 503 });
        if (u.endsWith('/2026/rsud/company.xlsx') && asp && (opts.method === 'HEAD' || opts.headers?.range)) {
            return resp(null, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'last-modified': 'Mon, 21 Sep 2026 06:00:00 GMT' } });
        }
        return resp('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    };
}

test('dateFromText parses resource names and file names', () => {
    assert.equal(dateFromText('Informații la data de 29.01.2024'), '2024-01-29');
    assert.equal(dateFromText('company-2024.05.14.xlsx'), '2024-05-14');
    assert.equal(dateFromText('2022.04.18 Company.xlsx'), '2022-04-18');
    assert.equal(dateFromText('company.xlsx'), null);
});

test('picks the newest file across asp.gov.md and dataset.gov.md', async (t) => {
    const orig = globalThis.fetch;
    t.after(() => { globalThis.fetch = orig; });

    globalThis.fetch = mockFetch();
    let s = await resolveLatestSource();
    assert.equal(s.url, 'https://www.asp.gov.md/sites/default/files/date-deschise/date-statistice/2026/rsud/company.xlsx');
    assert.equal(s.dataDate, '2026-09-21');

    globalThis.fetch = mockFetch({ asp: false });
    s = await resolveLatestSource();
    assert.equal(s.url, 'https://dataset.gov.md/x/company-2024.05.14.xlsx');
    assert.equal(s.dataDate, '2024-05-14');

    globalThis.fetch = mockFetch({ asp: false, ckan: false });
    await assert.rejects(resolveLatestSource(), /Could not find the official company file/);
});
