// End-to-end tests: runs `node src/main.js` with local storage against a local mock of the official endpoints.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMockServer } from './mock-server.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function newStorage() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kzlookup-'));
}

/** Runs the Actor once. Reuse `dir` to keep named stores (the cache) between runs. */
function run(input, { dir = newStorage(), env = {} } = {}) {
    fs.mkdirSync(path.join(dir, 'key_value_stores/default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'key_value_stores/default/INPUT.json'), JSON.stringify(input));
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['src/main.js'], {
            cwd: ROOT,
            env: { ...process.env, CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, APIFY_LOG_LEVEL: 'INFO', KZ_RETRY_BASE_MS: '20', ...env },
        });
        let logText = '';
        child.stdout.on('data', (d) => { logText += d; });
        child.stderr.on('data', (d) => { logText += d; });
        child.on('close', (code) => {
            const dsDir = path.join(dir, 'datasets/default');
            const items = fs.existsSync(dsDir) ? fs.readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8'))) : [];
            const outFile = path.join(dir, 'key_value_stores/default/OUTPUT.json');
            const output = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
            resolve({ code, log: logText, items, output, dir });
        });
    });
}

let mock;
before(async () => { mock = await startMockServer({ apiKey: 'test-key' }); });
after(async () => { await mock.close(); });

const byBin = (items, bin) => items.find((i) => i.bin === bin);

test('BIN lookup: found (both sources), not found, invalid, IIN', async () => {
    const r = await run({ apiBaseUrl: mock.url, bins: ['150140010013', '1501 4001 0025', '230150000014', '12345', '150140010014', '210310010017'] });
    assert.equal(r.code, 0, r.log);

    const a = byBin(r.items, '150140010013');
    assert.equal(a.found, true);
    assert.equal(a.lookupStatus, 'found');
    assert.equal(a.name, 'Товарищество с ограниченной ответственностью "Робокод Казахстан"');
    assert.equal(a.nameKz, '"Робокод Қазақстан" жауапкершілігі шектеулі серіктестігі');
    assert.equal(a.legalFormCode, 'LLP');
    assert.equal(a.registrationDate, '2015-01-20');
    assert.equal(a.statusCategory, 'active');
    assert.equal(a.director, 'ИВАНОВ ИВАН ИВАНОВИЧ');
    assert.deepEqual(a.primaryActivity, { code: '62011', name: 'Разработка программного обеспечения' });
    assert.deepEqual(a.secondaryActivityCodes, ['85599', '62020']);
    assert.deepEqual(a.size, { code: '105', name: 'Малые предприятия (<= 5 чел.)' });
    assert.equal(a.katoCode, '751210000');
    assert.deepEqual(a.binInfo, { registrationYearMonth: '2015-01', entityType: 'resident_legal_entity', unitType: 'head_office' });
    assert.deepEqual(a.sources, ['registry', 'statistics']);
    assert.equal(a.sourceUrls.length, 2);
    assert.ok(a.original.registry && a.original.statistics);
    assert.ok(!Number.isNaN(Date.parse(a.retrievedAt)));
    assert.equal(a.fromCache, false);

    const bank = byBin(r.items, '150140010025');
    assert.equal(bank.legalFormCode, 'JSC');
    assert.equal(bank.matchedQuery, '150140010025');

    const nf = byBin(r.items, '230150000014');
    assert.equal(nf.found, false);
    assert.equal(nf.lookupStatus, 'not_found');
    assert.equal(nf.binInfo.entityType, 'non_resident_legal_entity');

    const inv = r.items.filter((i) => i.lookupStatus === 'invalid');
    assert.deepEqual(inv.map((i) => i.matchedQuery).sort(), ['12345', '150140010014', '210310010017']);
    assert.match(inv.find((i) => i.matchedQuery === '150140010014').error, /check digit/);
    assert.match(inv.find((i) => i.matchedQuery === '210310010017').error, /IIN/);

    assert.equal(r.output.foundCompanies, 2);
    assert.equal(r.output.notFound, 1);
    assert.equal(r.output.invalidBins.length, 3);
});

test('status mapping, duplicate registry records, one-source-only results', async () => {
    const r = await run({ apiBaseUrl: mock.url, bins: ['150140010037', '180540020017', '201140020021'], includeOriginal: false });
    assert.equal(r.code, 0, r.log);
    const liq = byBin(r.items, '150140010037');
    assert.equal(liq.statusCategory, 'liquidated');
    assert.equal(liq.director, null); // "-" placeholder
    assert.deepEqual(liq.sources, ['registry']);
    assert.equal(liq.original, undefined);
    const dup = byBin(r.items, '180540020017');
    assert.equal(dup.statusCategory, 'active'); // registered record preferred over the deregistered one
    assert.equal(dup.registryRecordCount, 2);
    const statOnly = byBin(r.items, '201140020021');
    assert.equal(statOnly.found, true);
    assert.deepEqual(statOnly.sources, ['statistics']);
    assert.equal(statOnly.name, 'ТОО "Только В Статистике"');
    assert.equal(statOnly.registrationDate, '2020-11-10');
});

test('language kz / en', async () => {
    let r = await run({ apiBaseUrl: mock.url, bins: ['150140010013'], language: 'kz' });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items[0].name, '"Робокод Қазақстан" жауапкершілігі шектеулі серіктестігі');
    assert.equal(r.items[0].status, 'Тіркелген');
    assert.equal(r.items[0].size.name, 'Шағын кәсіпорындар (<= 5 адам)');
    r = await run({ apiBaseUrl: mock.url, bins: ['150140010013'], language: 'en' });
    assert.equal(r.items[0].primaryActivity.name, 'Software development');
    assert.equal(r.items[0].nameRu, 'Товарищество с ограниченной ответственностью "Робокод Казахстан"');
    assert.ok(mock.requests.some((q) => q.query.lang === 'en'));
});

test('name search (Cyrillic, legal form ignored, maxResults, no match)', async () => {
    const r = await run({ apiBaseUrl: mock.url, names: ['ТОО Робокод', 'несуществующая компания'], maxResults: 2, sources: ['registry'] });
    assert.equal(r.code, 0, r.log);
    const hits = r.items.filter((i) => i.matchedQuery === 'ТОО Робокод' && i.found);
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.statusCategory === 'active'));
    assert.ok(hits.every((h) => h.matchScore > 0.5));
    const miss = r.items.find((i) => i.matchedQuery === 'несуществующая компания');
    assert.equal(miss.found, false);
    assert.equal(miss.lookupStatus, 'not_found');
    assert.equal(r.output.names.find((n) => n.name === 'ТОО Робокод').returned, 2);
});

test('optional data.egov.kz API key uses API v4', async () => {
    const before = mock.requests.length;
    const r = await run({ apiBaseUrl: mock.url, bins: ['150140010025'], names: ['Робокод Астана'], egovApiKey: 'test-key', sources: ['registry'] });
    assert.equal(r.code, 0, r.log);
    const reqs = mock.requests.slice(before);
    assert.ok(reqs.length >= 2 && reqs.every((q) => q.path === '/api/v4/gbd_ul/v1'));
    assert.equal(byBin(r.items, '150140010025').found, true);
    assert.equal(r.items.find((i) => i.matchedQuery === 'Робокод Астана').bin, '220640030018');
    assert.ok(byBin(r.items, '150140010025').sourceUrls[0].includes('apiKey=***'), 'API key must not leak into output');
    assert.ok(!r.log.includes('test-key'), 'API key must not leak into the log');
});

test('cache: second run is served from the named key-value store', async () => {
    const dir = newStorage();
    const input = { apiBaseUrl: mock.url, bins: ['150140010013', '150140010025'], names: ['Степной'] };
    const first = await run(input, { dir });
    assert.equal(first.code, 0, first.log);
    assert.ok(first.output.requestsToSources >= 5);
    const n = mock.requests.length;
    const second = await run(input, { dir });
    assert.equal(second.code, 0, second.log);
    assert.equal(mock.requests.length, n, 'no requests to the sources on the cached run');
    assert.equal(second.output.requestsToSources, 0);
    assert.ok(second.items.filter((i) => i.bin).every((i) => i.fromCache === true));
    assert.equal(second.items.length, first.items.length);
    assert.equal(second.output.foundCompanies, first.output.foundCompanies);
    // forceRefresh bypasses the cache
    const third = await run({ ...input, forceRefresh: true }, { dir });
    assert.ok(mock.requests.length > n);
    assert.equal(third.items.filter((i) => i.fromCache).length, 0);
});

test('pay per event: charges found companies only and stops at the spending limit', async () => {
    const env = { ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_MAX_TOTAL_CHARGE_USD: '2' }; // local price = $1 per event
    const r = await run({ apiBaseUrl: mock.url, bins: ['150140010013', '150140010025', '150140010037', '180540020017', '201140020021', '230150000014', '999'], maxConcurrency: 2 }, { env });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.filter((i) => i.found).length, 2);
    assert.equal(r.output.chargedEvents['company-result'], 2);
    assert.equal(r.output.stoppedBySpendingLimit, true);
    assert.match(r.log, /maximum cost/);
    // Under budget: not-found and invalid items are free.
    const ok = await run({ apiBaseUrl: mock.url, bins: ['150140010013', '230150000014', '999'] }, { env: { ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_MAX_TOTAL_CHARGE_USD: '10' } });
    assert.equal(ok.output.chargedEvents['company-result'], 1);
    assert.equal(ok.output.stoppedBySpendingLimit, false);
    assert.equal(ok.items.length, 3);
});

test('statistics source blocked: partial results with warnings; HTML block page handled', async () => {
    const m = await startMockServer({ blockStat: true });
    try {
        const r = await run({ apiBaseUrl: m.url, bins: ['150140010013', '150140010025', '150140010037'], maxConcurrency: 1 });
        assert.equal(r.code, 0, r.log);
        const a = byBin(r.items, '150140010013');
        assert.equal(a.found, true);
        assert.deepEqual(a.sources, ['registry']);
        assert.match(a.warnings.join(' '), /not reachable.*RESIDENTIAL proxy/s);
        assert.deepEqual(r.output.unavailableSources, ['statistics']);
        // circuit breaker: after 2 failed BINs the statistics source is skipped
        const statCalls = m.requests.filter((q) => q.path.startsWith('/api/juridical')).length;
        assert.equal(statCalls, 2 * 4, 'two BINs x (1 try + 3 retries), then skipped');
    } finally { await m.close(); }

    const h = await startMockServer({ htmlStat: true });
    try {
        const r = await run({ apiBaseUrl: h.url, bins: ['201140020021'] });
        const it = byBin(r.items, '201140020021');
        assert.equal(it.found, false);
        assert.equal(it.lookupStatus, 'error');
        assert.match(it.error, /not JSON/);
    } finally { await h.close(); }
});

test('all sources blocked: run fails with a clear geo-blocking message and charges nothing', async () => {
    const m = await startMockServer({ blockAll: true });
    try {
        const r = await run({ apiBaseUrl: m.url, bins: ['150140010013', '150140010025', '150140010037'] }, { env: { ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_MAX_TOTAL_CHARGE_USD: '10' } });
        assert.notEqual(r.code, 0);
        assert.match(r.log, /outside Kazakhstan/);
        assert.match(r.log, /Proxy configuration/);
        assert.equal(r.output.chargedEvents['company-result'], 0);
        assert.ok(r.items.every((i) => i.found === false && i.lookupStatus === 'error'));
    } finally { await m.close(); }
});

test('validateChecksum=false lets a BIN with a wrong check digit through', async () => {
    const r = await run({ apiBaseUrl: mock.url, bins: ['150140010014'], validateChecksum: false, sources: ['statistics'] });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items[0].lookupStatus, 'not_found');
});

test('bad input produces clear errors', async () => {
    const cases = [
        [{}, /Nothing to look up/],
        [{ bins: ['12345'] }, /No valid BIN given.*12 digits/],
        [{ bins: '150140010013' }, /"bins" must be an array/],
        [{ bins: ['150140010013'], language: 'de' }, /"language"/],
        [{ bins: ['150140010013'], sources: ['kgd'] }, /"sources"/],
        [{ names: ['Робокод'], sources: ['statistics'] }, /Name search uses the state register/],
        [{ names: ['ТОО'] }, /only legal-form words/],
        [{ bins: ['150140010013'], maxConcurrency: 20 }, /maxConcurrency/],
        [{ bins: ['150140010013'], maxResults: 0 }, /maxResults/],
        [{ bin: '150140010013' }, /Unknown input field.*bin/],
        [{ bins: ['150140010013'], apiBaseUrl: 'not a url' }, /apiBaseUrl/],
    ];
    for (const [input, re] of cases) {
        const r = await run(input);
        assert.notEqual(r.code, 0, `expected failure for ${JSON.stringify(input)}`);
        assert.match(r.log, re, `for ${JSON.stringify(input)}`);
    }
});
