/**
 * End-to-end scenarios: runs the Actor locally (node src/main.js) against test/mock-server.mjs.
 *   node test/scenarios.mjs
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeFixtures } from './fixtures.mjs';
import { buildFilter } from '../src/normalize.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 8799;
const API = `http://127.0.0.1:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'prozorro-test-'));
const results = [];

const server = spawn(process.execPath, [path.join(ROOT, 'test/mock-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));

const post = (p, body) => fetch(`${API}${p}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const mockLog = () => fetch(`${API}/__admin/log`).then((r) => r.json());

/** Runs the Actor with the given input in storage dir `store` (shared named stores persist between runs). */
function run(input, { store = 'default', env = {} } = {}) {
    const dir = path.join(WORK, store);
    fs.mkdirSync(path.join(dir, 'key_value_stores/default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'key_value_stores/default/INPUT.json'), JSON.stringify({ apiBaseUrl: API, requestIntervalMs: 100, ...input }));
    const res = spawnSync(process.execPath, ['src/main.js'], {
        cwd: ROOT,
        env: { ...process.env, CRAWLEE_STORAGE_DIR: dir, PROZORRO_TELEGRAM_API: API, ...env },
        encoding: 'utf8',
    });
    const code = res.status;
    const out = `${res.stdout}${res.stderr}`;
    const dsDir = path.join(dir, 'datasets/default');
    const items = fs.existsSync(dsDir) ? fs.readdirSync(dsDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dsDir, f), 'utf8'))) : [];
    const outFile = path.join(dir, 'key_value_stores/default/OUTPUT.json');
    const output = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    return { code, out, items, output };
}

async function scenario(name, fn) {
    const t = Date.now();
    try {
        await fn();
        results.push({ name, ok: true, ms: Date.now() - t });
        console.log(`PASS ${name} (${Date.now() - t} ms)`);
    } catch (err) {
        results.push({ name, ok: false, error: err.message });
        console.log(`FAIL ${name}\n     ${err.message.split('\n').slice(0, 6).join('\n     ')}`);
    }
}

const fixtures = makeFixtures(); // same generator as the server (timestamps differ by milliseconds only)
const uniqueIds = (items) => new Set(items.map((i) => i.procedureId)).size === items.length;

await scenario('input schema is valid (@apify/input_schema)', () => {
    execFileSync(process.execPath, ['scripts/validate-schema.mjs'], { cwd: ROOT, stdio: 'pipe' });
});

await scenario('search: latest per type, open for bids', () => {
    const r = run({ sellingMethods: ['landRental'], openForBidsOnly: true });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.items.length > 0, 'expected results');
    for (const it of r.items) {
        assert.match(it.sellingMethod, /^landRental-/);
        assert.ok(['active_rectification', 'active_tendering'].includes(it.status), it.status);
        assert.equal(it.url, `https://prozorro.sale/auction/${it.auctionId}`);
    }
    assert.equal(r.output.scan.strategy, 'latestByType');
});

await scenario('search: change feed over >100 records, combined filters, exact match count', () => {
    const filters = { regions: ['Львів', 'одеса'], minPrice: 50000, maxPrice: 400000, publishedFrom: '3 days' };
    const r = run({ ...filters, maxPages: 20, maxResults: 0 });
    assert.equal(r.code, 0, r.out);
    // Expected set computed directly from the fixtures with the same filter semantics.
    const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const expected = fixtures.filter(buildFilter({ regions: filters.regions, minPrice: 50000, maxPrice: 400000, publishedFrom: from }));
    assert.equal(r.items.length, expected.length, `got ${r.items.length}, expected ${expected.length}`);
    assert.ok(uniqueIds(r.items), 'duplicate auctions in output');
    assert.ok(r.output.scan.pages >= 3, `expected paging, got ${r.output.scan.pages} pages`);
    assert.equal(r.output.scan.reachedPresent, true);
    for (const it of r.items) {
        assert.ok(it.startingPrice >= 50000 && it.startingPrice <= 400000);
        assert.ok(/львів|одеса/i.test(`${it.region} ${it.city}`), `${it.region} ${it.city}`);
    }
});

await scenario('search: keyword + classification + status + auction date', () => {
    const r = run({ keywords: 'ЗЕМЕЛЬНОЇ ділянки', classificationCodes: ['06'], statuses: ['active_tendering', 'complete'], auctionDateFrom: '+1 day', lookbackHours: 72, maxResults: 0 });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.items.length > 0, 'expected results');
    for (const it of r.items) {
        assert.ok(it.classificationCodes.some((c) => c.startsWith('06')));
        assert.ok(['active_tendering', 'complete'].includes(it.status));
        assert.ok(/земельної ділянки/i.test(it.title), it.title);
        assert.ok(Date.parse(it.auctionDate) >= Date.now());
    }
});

await scenario('search: English keyword matches English titles', () => {
    const r = run({ keywords: 'COMMERCIAL property', regions: ['київська'], lookbackHours: 72, maxResults: 0 });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.items.length > 0, 'expected results');
    assert.ok(r.items.every((i) => /^Commercial property \d+/.test(i.titleEn) && i.city === 'Бровари'));
});

await scenario('search: maxResults stops early; maxPages gives an honest partial note', () => {
    const a = run({ lookbackHours: 72, maxResults: 7 });
    assert.equal(a.items.length, 7);
    const b = run({ lookbackHours: 72, maxPages: 1, maxResults: 0 });
    assert.equal(b.code, 0, b.out);
    assert.equal(b.output.scan.truncated, true);
    assert.match(b.output.scan.note, /PARTIAL/);
});

await scenario('details: public IDs, procedure ID, winner & final price, not found', () => {
    const complete = fixtures.find((p) => p.status === 'complete');
    const r = run({ auctionIds: ['LLE001-UA-20210820-93432', complete._id, 'lre001-ua-20260916-77195', 'SPE001-UA-20990101-00001'], includeRaw: true });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.items.length, 3);
    const lease = r.items.find((i) => i.auctionId === 'LLE001-UA-20210820-93432');
    assert.equal(lease.startingPrice, 861.84);
    assert.equal(lease.guarantee, 3447.36);
    assert.equal(lease.minimalStep, 86.18);
    assert.equal(lease.result.outcome, 'cancelled');
    assert.match(lease.result.cancellationReason, /Порушення/);
    assert.match(lease.seller.name, /Фонду державного майна/);
    assert.equal(lease.classificationCodes[0], '04000000-8');
    const won = r.items.find((i) => i.procedureId === complete._id);
    assert.equal(won.result.outcome, 'sold');
    assert.equal(won.result.winnerName, 'ТОВ "Переможець"');
    assert.ok(won.result.finalPrice > won.startingPrice);
    assert.ok(won.result.priceIncreasePercent > 30);
    assert.ok(won.documents.some((d) => d.documentOf === 'contract' && d.url));
    assert.ok(won.raw && won.raw._id === complete._id, 'raw missing');
    assert.deepEqual(r.output.notFound, ['SPE001-UA-20990101-00001']);
});

await scenario('types: lists selling methods with prefixes', () => {
    const r = run({ mode: 'types' });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.items.find((i) => i.sellingMethod === 'landRental-english' && i.auctionIdPrefix === 'LRE'));
});

await scenario('retries: 429 (Retry-After) and 503 are retried', async () => {
    await post('/__admin/faults', { 429: 2, 503: 1 });
    const r = run({ sellingMethods: ['timber'] });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.output.retries >= 3, `retries=${r.output.retries}`);
    assert.match(r.out, /HTTP 429/);
});

await scenario('monitor: baseline, then only new auctions + notifications, then nothing', async () => {
    const input = {
        monitorName: 'land-test', sellingMethods: ['landRental'], lookbackHours: 72,
        webhookUrl: `${API}/webhook`, slackWebhookUrl: `${API}/slack`, telegramBotToken: '123:SECRET', telegramChatId: '42',
    };
    const r1 = run(input, { store: 'mon' });
    assert.equal(r1.code, 0, r1.out);
    assert.equal(r1.items.length, 0);
    assert.equal(r1.output.isBaseline, true);
    assert.ok(r1.output.rememberedIds > 0);

    await post('/__admin/add', { count: 3 });
    const before = (await mockLog()).notifications.length;
    const r2 = run(input, { store: 'mon' });
    assert.equal(r2.code, 0, r2.out);
    assert.equal(r2.items.length, 3, `expected 3 new, got ${r2.items.length}`);
    assert.ok(r2.items.every((i) => i.isNew && i.monitorName === 'land-test'));
    assert.deepEqual(r2.output.notifications, { telegram: 'sent', slack: 'sent', webhook: 'sent' });
    const notes = (await mockLog()).notifications.slice(before);
    const hook = notes.find((x) => x.path === '/webhook').body;
    assert.equal(hook.event, 'auctions.new');
    assert.equal(hook.newCount, 3);
    assert.equal(hook.auctions.length, 3);
    assert.ok(notes.find((x) => x.path.includes('sendMessage')).body.text.includes('3 new Prozorro.Sale auctions'));
    assert.ok(!JSON.stringify(notes).includes('SECRET'), 'bot token leaked');

    const r3 = run(input, { store: 'mon' });
    assert.equal(r3.items.length, 0, 'third run should report nothing');
    assert.equal(r3.output.newAuctions, 0);
});

await scenario('monitor: failing webhook does not fail the run', async () => {
    const input = { monitorName: 'hookfail', sellingMethods: ['landRental'], lookbackHours: 72, reportAllOnFirstRun: true, webhookUrl: `${API}/webhook-fail` };
    const r = run(input, { store: 'hookfail' });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.items.length > 0);
    assert.match(r.output.notifications.webhook, /^failed: .*HTTP 500/);
});

await scenario('spending limit: search stops cleanly at the budget', () => {
    const r = run({ lookbackHours: 72, maxResults: 0 }, { env: { ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_MAX_TOTAL_CHARGE_USD: '5' } });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.items.length, 5); // locally every event costs $1
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.match(r.out, /maximum cost per run/);
});

await scenario('spending limit: monitor delivers the rest on the next run (nothing lost, no duplicates)', async () => {
    const input = { monitorName: 'budget', sellingMethods: ['landRental'], lookbackHours: 72 };
    run(input, { store: 'budget' });
    await post('/__admin/add', { count: 4 });
    const r1 = run(input, { store: 'budget', env: { ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_MAX_TOTAL_CHARGE_USD: '2' } });
    assert.equal(r1.code, 0, r1.out);
    assert.equal(r1.items.length, 2);
    assert.equal(r1.output.stoppedAtCostLimit, true);
    assert.equal(r1.output.newNotDeliveredDueToCostLimit, 2);
    const r2 = run(input, { store: 'budget' });
    assert.equal(r2.items.length, 2, `expected remaining 2, got ${r2.items.length}`);
    const ids = new Set([...r1.items, ...r2.items].map((i) => i.auctionId));
    assert.equal(ids.size, 4);
});

for (const [name, input, pattern] of [
    ['bad input: details without IDs', { mode: 'details' }, /needs at least one auction ID/],
    ['bad input: malformed auction ID', { auctionIds: ['hello world'] }, /do not look valid/],
    ['bad input: minPrice > maxPrice', { minPrice: 10, maxPrice: 5 }, /higher than "maxPrice"/],
    ['bad input: invalid date', { publishedFrom: 'yesterday-ish' }, /not a valid date/],
    ['bad input: latestByType without types', { scanMode: 'latestByType' }, /needs at least one value/],
    ['bad input: bad store name', { monitorName: 'x', stateStoreName: 'bad name!' }, /stateStoreName/],
    ['API unreachable: clear error', { apiBaseUrl: 'http://127.0.0.1:1', sellingMethods: ['timber'], requestIntervalMs: 100 }, /Prozorro\.Sale API request failed.*Network error/],
]) {
    await scenario(name, () => {
        const r = run(input);
        assert.notEqual(r.code, 0, 'run should fail');
        assert.match(r.out, pattern);
    });
}

server.kill();
fs.rmSync(WORK, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed.`);
process.exit(failed.length ? 1 : 0);
