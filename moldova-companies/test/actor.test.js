// End-to-end tests: runs `node src/main.js` against the fictional fixtures with local storage.
// Run: npm run fixture && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { norm, statusCategory, extractActivityCodes, toIsoDate, mapHeaderCell, legalFormMatches } from '../src/normalize.js';
import { buildNameQuery, prepareName, scoreName } from '../src/search.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const XLSX = path.join(ROOT, 'test/fixtures/company-2026.09.15.xlsx');
const CSV = path.join(ROOT, 'test/fixtures/company-ru.csv');

function run(input) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreg-'));
    fs.mkdirSync(path.join(dir, 'key_value_stores/default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'key_value_stores/default/INPUT.json'), JSON.stringify(input));
    const r = spawnSync(process.execPath, ['src/main.js'], { cwd: ROOT, env: { ...process.env, CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, APIFY_LOG_LEVEL: 'INFO' }, encoding: 'utf8' });
    const dsDir = path.join(dir, 'datasets/default');
    const items = fs.existsSync(dsDir) ? fs.readdirSync(dsDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8'))) : [];
    const outFile = path.join(dir, 'key_value_stores/default/OUTPUT.json');
    const output = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    return { code: r.status, log: r.stdout + r.stderr, items, output };
}

test('normalization: diacritics variants and Cyrillic', () => {
    assert.equal(norm('ŞTIINŢA'), norm('Știința'));
    assert.equal(norm('Țara'), 'tara');
    assert.equal(norm('S.R.L.'), 'srl');
    assert.equal(norm('МОЛДАГРОТЕХ'), 'moldagroteh');
    assert.equal(mapHeaderCell('Наименование'), 'name');
    assert.equal(mapHeaderCell('Genuri de activitate nelicențiate'), 'activitiesUnlicensed');
    assert.equal(mapHeaderCell('Data lichidării'), 'liquidationDate');
    assert.equal(toIsoDate('05.07.2010'), '2010-07-05');
    assert.equal(toIsoDate(45000), '2023-03-15');
    assert.deepEqual(extractActivityCodes('62.01 Soft; la 12.05.2020 47.19.1 x'), ['62.01', '47.19.1']);
    assert.equal(statusCategory('În proces de lichidare'), 'in_process');
    assert.equal(statusCategory('Lichidată'), 'liquidated');
    assert.equal(statusCategory('Activ'), 'active');
    assert.ok(legalFormMatches('Societate cu răspundere limitată', 'SRL'));
    assert.ok(!legalFormMatches('Societate pe acțiuni', 'SRL'));
});

test('name scoring: contains, exact, fuzzy', () => {
    const n = prepareName('ROBO SOFT S.R.L.');
    assert.ok(scoreName(n, buildNameQuery('robosoft', 'contains', 0.8)) > 0);
    assert.equal(scoreName(n, buildNameQuery('Robo Soft SRL', 'exact', 0.8)), 1);
    assert.equal(scoreName(prepareName('ROBOSOFT LOGISTICS'), buildNameQuery('robo soft', 'exact', 0.8)), 0);
    assert.equal(scoreName(n, buildNameQuery('robo sotf', 'contains', 0.8)), 0);
    assert.ok(scoreName(n, buildNameQuery('robo sotf', 'fuzzy', 0.7)) > 0);
    assert.throws(() => buildNameQuery('S.R.L.', 'contains', 0.8), /empty/);
});

test('IDNO lookup + not found + invalid', () => {
    const r = run({ sourceFileUrl: XLSX, idnos: ['1003600000011', '1003 6000 00055', '1003600009999', '12345'] });
    assert.equal(r.code, 0, r.log);
    const found = r.items.filter((i) => i.found);
    assert.deepEqual(found.map((i) => i.idno), ['1003600000011', '1003600000055']);
    assert.equal(found[0].registrationDate, '2003-03-12');
    assert.deepEqual(found[0].founders, ['Popescu Ion', 'Rusu Maria']);
    assert.equal(found[0].dataDate, '2026-09-15');
    assert.ok(found[0].sourceUrl.endsWith('.xlsx'));
    assert.equal(r.items.filter((i) => !i.found).length, 2);
    assert.deepEqual(r.output.notFoundIdnos, ['1003600009999']);
    assert.equal(r.output.chargedEvents['company-result'], 2);
});

test('name search with ș/ş, ț/ţ variants and Cyrillic', () => {
    const r = run({ sourceFileUrl: XLSX, names: ['Stiinta', 'cafeneaua lui țurcanu', 'молдагротех', 'gheorghita marin'] });
    assert.equal(r.code, 0, r.log);
    const names = r.items.map((i) => i.name);
    assert.ok(names.includes('ŞTIINŢA GRUP S.A.'));
    assert.ok(names.includes('CAFENEAUA LUI ŢURCANU S.R.L.'));
    assert.ok(names.includes('МОЛДАГРОТЕХ S.R.L.'));
    assert.ok(names.includes('Î.I. "GHEORGHIȚĂ MARIN"'));
});

test('filters: legal form, status, dates, activity code, location', () => {
    let r = run({ sourceFileUrl: XLSX, filters: { legalForms: ['SRL'], statuses: ['active'], location: 'Chisinau' }, maxResults: 50 });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.items.map((i) => i.idno).sort(), ['1003600000011', '1003600000033', '1003600000088']);
    r = run({ sourceFileUrl: XLSX, filters: { activityCodes: ['62'], registeredFrom: '2020-01-01' } });
    assert.deepEqual(r.items.map((i) => i.name), ['ROBOCODE ACADEMY S.R.L.']);
    r = run({ sourceFileUrl: XLSX, filters: { statuses: ['in_process', 'liquidated'] } });
    assert.deepEqual(r.items.map((i) => i.idno).sort(), ['1003600000044', '1003600000077']);
    r = run({ sourceFileUrl: XLSX, names: ['robo'], filters: { location: 'Bălţi' } });
    assert.equal(r.items.length, 0);
});

test('exportAll with limit and filters; includePeople=false; raw columns', () => {
    const r = run({ sourceFileUrl: XLSX, exportAll: true, exportLimit: 3, includePeople: false, includeRawColumns: true });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 3);
    assert.equal(r.items[0].directors, undefined);
    assert.equal(r.items[0].raw['Denumirea completă'], 'ȚARA VERDE AGRO S.R.L.');
    assert.equal(r.output.chargedEvents['bulk-export-item'], 3);
    const all = run({ sourceFileUrl: XLSX, exportAll: true, filters: { legalForms: ['SA'] } });
    assert.equal(all.items.length, 2);
});

test('fuzzy name search in percent threshold', () => {
    const r = run({ sourceFileUrl: XLSX, names: ['robo sotf'], nameMatch: 'fuzzy', fuzzyThreshold: 75 });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items[0].name, 'ROBO SOFT S.R.L.');
});

test('CSV with Russian headers', () => {
    const r = run({ sourceFileUrl: CSV, names: ['Tara Verde'], idnos: ['1003600000055'] });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2);
    assert.equal(r.items.find((i) => i.idno === '1003600000055').statusCategory, 'liquidated');
});

test('bad input produces clear errors', () => {
    const cases = [
        [{ sourceFileUrl: XLSX }, /Nothing to look up/],
        [{ sourceFileUrl: XLSX, idnos: ['123'] }, /No valid IDNO/],
        [{ sourceFileUrl: XLSX, idnos: '1003600000011' }, /must be an array/],
        [{ sourceFileUrl: XLSX, names: ['robo'], filters: { city: 'Chisinau' } }, /Unknown filter/],
        [{ sourceFileUrl: XLSX, filters: { registeredFrom: '01.01.2020' } }, /YYYY-MM-DD/],
        [{ sourceFileUrl: XLSX, filters: { statuses: ['open'] } }, /statuses/],
        [{ sourceFileUrl: XLSX, exportAll: true, names: ['robo'] }, /Remove "idnos"\/"names"/],
        [{ sourceFileUrl: XLSX, names: ['robo'], maxResults: 0 }, /maxResults/],
        [{ sourceFileUrl: '/nope/missing.xlsx', names: ['robo'] }, /not found/],
        [{ sourceFileUrl: XLSX, names: ['robo'], nameMatch: 'fuzzy', fuzzyThreshold: 30 }, /fuzzyThreshold/],
    ];
    for (const [input, re] of cases) {
        const r = run(input);
        assert.notEqual(r.code, 0, `expected failure for ${JSON.stringify(input)}`);
        assert.match(r.log, re);
    }
});
