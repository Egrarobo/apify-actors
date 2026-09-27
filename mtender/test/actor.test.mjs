// End-to-end tests: run src/main.js as a child process against the local mock MTender API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './mock-server.mjs';
import { runActor, newStorageDir } from './helpers.mjs';

const T = {
    medicines: 'ocds-b3wdp1-MD-1789027200000',
    roads: 'ocds-b3wdp1-MD-1789030800000',
    computersRu: 'ocds-b3wdp1-MD-1789113600000',
    itEur: 'ocds-b3wdp1-MD-1789120800000',
    old2025: 'ocds-b3wdp1-MD-1761984000000',
    cleaningPlan: 'ocds-b3wdp1-MD-1789200000000',
    flakyReagents: 'ocds-b3wdp1-MD-1789210800000',
    deleted: 'ocds-b3wdp1-MD-1789200000000'.replace('1789200000000', String(Date.parse('2026-09-12T12:00:00Z'))),
    later: 'ocds-b3wdp1-MD-1789891200000',
};

let srv;
before(async () => { srv = await startMockServer({ pageSize: 3 }); });
after(async () => { await srv.close(); });
beforeEach(() => srv.resetFlaky());

const search = (extra = {}) => ({ apiBaseUrl: srv.url, dateFrom: '2026-09-01', dateTo: '2026-09-19', requestDelayMs: 0, ...extra });
const ocids = (items) => items.map((i) => i.ocid).sort();

test('search: keyword (partial word, diacritics-insensitive) + published-in-period filter', async () => {
    const r = await runActor(search({ keywords: ['medicament'] }));
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(ocids(r.items), [T.medicines], 'the 2025 tender only updated in the period is excluded');
    assert.deepEqual(r.items[0].matchedKeywords, ['medicament']);
    assert.equal(r.output.pagesRead >= 3, true, 'feed pagination was followed');
    assert.equal(r.output.notFound, 1, 'deleted tender counted, not fatal');
    assert.ok(r.output.apiRetries >= 3, 'flaky tender needed retries (500, 429, 200-error body)');

    const all = await runActor(search({ keywords: ['medicament'], onlyNewlyPublished: false }));
    assert.deepEqual(ocids(all.items), [T.old2025, T.medicines].sort());
});

test('search: Romanian without diacritics, and Russian', async () => {
    const ro = await runActor(search({ keywords: ['reparatia capitala', 'STEFAN'], keywordsMatch: 'all' }));
    assert.deepEqual(ocids(ro.items), [T.roads]);
    const ru = await runActor(search({ keywords: ['КОМПЬЮТЕРНОЙ'] }));
    assert.deepEqual(ocids(ru.items), [T.computersRu]);
});

test('search: status, CPV, buyer, value, method, category, currency filters', async () => {
    const cases = [
        [{ statuses: ['complete'] }, [T.roads]],
        [{ statuses: ['cancelled', 'unsuccessful'] }, [T.computersRu, T.itEur]],
        [{ cpvPrefixes: ['45'] }, [T.roads]],
        [{ cpvPrefixes: ['33'] }, [T.medicines, T.flakyReagents]],
        [{ cpvPrefixes: ['30213100'] }, [T.computersRu], 'item-level CPV'],
        [{ buyerIdnos: ['1003600012345'] }, [T.medicines, T.flakyReagents]],
        [{ buyerNames: ['primaria municipiului chisinau'] }, [T.roads]],
        [{ minValue: 100000, maxValue: 2000000, currency: 'MDL' }, [T.medicines]],
        [{ maxValue: 100000 }, [T.computersRu, T.itEur, T.flakyReagents]],
        [{ maxValue: 50000, includeWithoutValue: true }, [T.itEur, T.cleaningPlan, T.flakyReagents]],
        [{ currency: 'EUR' }, [T.itEur]],
        [{ methods: ['smallValue'] }, [T.computersRu, T.flakyReagents]],
        [{ methods: ['selective'] }, [T.computersRu, T.flakyReagents]],
        [{ categories: ['services'] }, [T.itEur, T.cleaningPlan]],
        [{ categories: ['works'], statuses: ['complete'], keywords: ['drum'] }, [T.roads]],
    ];
    for (const [f, expected, note] of cases) {
        srv.resetFlaky();
        const r = await runActor(search(f));
        assert.equal(r.code, 0, r.log);
        assert.deepEqual(ocids(r.items), [...expected].sort(), `${JSON.stringify(f)} ${note ?? ''}`);
    }
});

test('search: normalized output fields', async () => {
    const r = await runActor(search({ statuses: ['complete'] }));
    const t = r.items[0];
    for (const k of ['ocid', 'url', 'title', 'description', 'buyer', 'buyerIdno', 'status', 'method', 'methodDetails', 'category', 'cpv', 'value', 'currency',
        'datePublished', 'tenderPeriodStart', 'tenderPeriodEnd', 'enquiryPeriodEnd', 'lots', 'items', 'documents', 'awards', 'contracts', 'suppliers', 'awardedValue', 'apiUrl', 'scrapedAt']) {
        assert.ok(k in t, `missing ${k}`);
    }
    assert.equal(t.url, `https://mtender.gov.md/tenders/${T.roads}`);
    assert.equal(t.apiUrl, `${srv.url}/tenders/${T.roads}`);
    assert.equal(t.awards[0].suppliers[0].name, 'Drumuri-Construct SRL');
    assert.equal(t.raw, undefined);
    const raw = await runActor(search({ statuses: ['complete'], includeRaw: true }));
    assert.ok(Array.isArray(raw.items[0].raw.records));
});

test('search: maxResults and maxScan', async () => {
    const r = await runActor(search({ onlyNewlyPublished: false, maxResults: 2 }));
    assert.equal(r.items.length, 2);
    assert.equal(r.output.stoppedAtMaxResults, true);
    const s = await runActor(search({ onlyNewlyPublished: false, maxScan: 4, maxResults: 0 }));
    assert.equal(s.output.tendersScanned, 4);
    assert.equal(s.output.stoppedAtMaxScan, true);
});

test('search: feed that ends with an empty body instead of {}', async () => {
    srv.state.endWithEmptyBody = true;
    try {
        const r = await runActor(search({ keywords: ['medicament'] }));
        assert.equal(r.code, 0, r.log);
        assert.deepEqual(ocids(r.items), [T.medicines]);
    } finally {
        srv.state.endWithEmptyBody = false;
    }
});

test('search: plans feed', async () => {
    const r = await runActor(search({ feed: 'plans', onlyNewlyPublished: false }));
    assert.deepEqual(ocids(r.items), [T.cleaningPlan]);
});

test('details: by OCID and link, not-found ID reported without failing', async () => {
    const r = await runActor({ apiBaseUrl: srv.url, requestDelayMs: 0, tenderIds: [T.roads, `https://mtender.gov.md/en/tenders/${T.medicines}`, T.deleted, T.roads] });
    assert.equal(r.code, 0, r.log);
    const good = r.items.filter((i) => !i.error);
    const bad = r.items.filter((i) => i.error);
    assert.deepEqual(ocids(good), [T.medicines, T.roads].sort(), 'duplicates removed, filters not applied');
    assert.equal(bad.length, 1);
    assert.equal(bad[0].ocid, T.deleted);
    assert.match(bad[0].error, /not found/);
    assert.equal(r.output.mode, 'details');
    assert.equal(r.output.pushed, 2);
});

test('monitor: baseline, then only new tenders with Telegram/Slack/webhook alerts; email failure is not fatal', async () => {
    const storageDir = newStorageDir();
    const env = { MTENDER_TELEGRAM_API: `${srv.url}/telegram` };
    const input = {
        apiBaseUrl: srv.url, requestDelayMs: 0, monitorName: 'Medical supplies!', dateFrom: '2026-09-01', cpvPrefixes: ['33'],
        telegramBotToken: '123:SECRET', telegramChatId: '42', slackWebhookUrl: `${srv.url}/slack`, webhookUrl: `${srv.url}/webhook`, emailTo: 'a@example.com',
    };
    srv.state.received.length = 0;

    const r1 = await runActor(input, { storageDir, env });
    assert.equal(r1.code, 0, r1.log);
    assert.equal(r1.items.length, 0, 'baseline outputs nothing');
    assert.equal(r1.output.isBaseline, true);
    assert.equal(r1.output.matched, 2);
    assert.equal(srv.state.received.length, 0, 'no alerts on baseline');

    srv.showLater(); // a new medicines tender appears
    const r2 = await runActor(input, { storageDir, env });
    assert.equal(r2.code, 0, r2.log);
    assert.deepEqual(ocids(r2.items), [T.later]);
    assert.equal(r2.items[0].isNew, true);
    assert.equal(r2.items[0].monitorName, 'Medical supplies!');
    assert.equal(r2.output.isBaseline, false);
    assert.equal(r2.output.newTenders, 1);
    assert.ok(r2.output.checkedFrom > '2026-09-12', `continued from the cursor, got ${r2.output.checkedFrom}`);
    const paths = srv.state.received.map((x) => x.path).sort();
    assert.deepEqual(paths, ['/slack', '/telegram/bot123:SECRET/sendMessage', '/webhook']);
    const tg = srv.state.received.find((x) => x.path.startsWith('/telegram')).body;
    assert.equal(tg.chat_id, '42');
    assert.match(tg.text, /1 new MTender tender/);
    assert.match(tg.text, /Medicamente oncologice/);
    assert.match(tg.text, /2,100,000 MDL/);
    const wh = srv.state.received.find((x) => x.path === '/webhook').body;
    assert.equal(wh.event, 'tenders.new');
    assert.equal(wh.tenders[0].ocid, T.later);
    assert.equal(wh.tenders[0].raw, undefined);
    assert.equal(r2.output.notifications.telegram, 'sent');
    assert.match(r2.output.notifications.email, /^failed/, 'email via apify/send-mail needs the platform; failure is reported, not fatal');

    srv.state.received.length = 0;
    const r3 = await runActor(input, { storageDir, env });
    assert.equal(r3.code, 0, r3.log);
    assert.equal(r3.items.length, 0, 'nothing new on the third run');
    assert.equal(srv.state.received.length, 0, 'no message when nothing is new');

    const r4 = await runActor({ ...input, notifyOnNoChanges: true, telegramBotToken: '', telegramChatId: '', emailTo: '', slackWebhookUrl: '', webhookUrl: `${srv.url}/webhook-fail` }, { storageDir, env });
    assert.equal(r4.code, 0, 'failed webhook does not fail the run');
    assert.match(r4.output.notifications.webhook, /failed: Webhook answered HTTP 500/);
});

test('monitor: changed filters start a new baseline; resetState forgets', async () => {
    const storageDir = newStorageDir();
    const base = { apiBaseUrl: srv.url, requestDelayMs: 0, monitorName: 'm2', dateFrom: '2026-09-01' };
    await runActor({ ...base, keywords: ['medicament'] }, { storageDir });
    const r = await runActor({ ...base, keywords: ['drum'] }, { storageDir });
    assert.equal(r.output.isBaseline, true);
    assert.match(r.log, /filters differ/);
    const z = await runActor({ ...base, keywords: ['drum'], resetState: true, reportAllOnFirstRun: true }, { storageDir });
    assert.deepEqual(ocids(z.items), [T.roads]);
});

test('monitor: a tender that fails to load is retried on the next run (no missed alert)', async () => {
    const own = await startMockServer({ pageSize: 3 });
    try {
        const storageDir = newStorageDir();
        const input = { apiBaseUrl: own.url, requestDelayMs: 0, monitorName: 'retry', dateFrom: '2026-09-01', keywords: ['oncologice'] };
        const r1 = await runActor(input, { storageDir });
        assert.equal(r1.output.isBaseline, true);
        assert.equal(r1.output.matched, 0);

        own.showLater();
        own.state.failOcids.add(T.later); // the new tender appears but MTender fails on it
        const r2 = await runActor(input, { storageDir });
        assert.equal(r2.code, 0, r2.log);
        assert.equal(r2.items.length, 0);
        assert.equal(r2.output.fetchErrors, 1);
        assert.match(r2.log, /will be retried on the next run/);

        own.state.failOcids.clear();
        const r3 = await runActor(input, { storageDir });
        assert.equal(r3.code, 0, r3.log);
        assert.deepEqual(ocids(r3.items), [T.later], 'alerted on the retry although the feed cursor had moved on');
        assert.match(r3.log, /Retrying 1 tender/);
    } finally {
        await own.close();
    }
});

// Note: outside the Apify platform the SDK prices every event at 1 USD so a budget can be reached locally,
// so ACTOR_MAX_TOTAL_CHARGE_USD=2.5 allows exactly 2 events.
const ppeEnv = (maxUsd) => ({
    ACTOR_TEST_PAY_PER_EVENT: 'true',
    ACTOR_MAX_TOTAL_CHARGE_USD: String(maxUsd),
    APIFY_ACTOR_PRICING_INFO: JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: { 'tender-result': { eventTitle: 'Tender', eventPriceUsd: 0.002 }, 'new-tender-alert': { eventTitle: 'New tender alert', eventPriceUsd: 0.01 } } },
    }),
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
});

test('pay-per-event: search stops cleanly at the spending limit', async () => {
    const r = await runActor(search({ onlyNewlyPublished: false, maxResults: 0 }), { env: ppeEnv(2.5) });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2, 'budget for exactly 2 results');
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.match(r.log, /maximum cost per run/);
});

test('pay-per-event: monitor at the limit keeps the rest for the next run (no loss, no duplicates)', async () => {
    const storageDir = newStorageDir();
    const input = { apiBaseUrl: srv.url, requestDelayMs: 0, monitorName: 'limits', dateFrom: '2026-09-01', onlyNewlyPublished: false, reportAllOnFirstRun: true, maxResults: 0 };
    const r1 = await runActor(input, { storageDir, env: ppeEnv(2.5) });
    assert.equal(r1.code, 0, r1.log);
    assert.equal(r1.items.length, 2, 'budget for exactly 2 alerts');
    assert.equal(r1.output.stoppedAtCostLimit, true);
    const r2 = await runActor(input, { storageDir, env: ppeEnv(100) });
    assert.equal(r2.code, 0, r2.log);
    const all = [...r1.items, ...r2.items].map((i) => i.ocid);
    assert.equal(new Set(all).size, all.length, 'no duplicates');
    const expected = srv.index.filter((e) => !e.missing && (!e.later || srv.state.showLater)).length;
    assert.equal(all.length, expected, 'every existing tender reported exactly once across the two runs');
    assert.equal(r2.output.stoppedAtCostLimit, false);
});

test('bad input fails with a clear message', async () => {
    const cases = [
        [{ tenderIds: ['12345'] }, /not valid MTender OCIDs/],
        [{ dateFrom: 'last spring' }, /not a valid date/],
        [{ statuses: ['open'] }, /Unknown status "open"/],
        [{ cpvPrefixes: ['medical'] }, /not a CPV code/],
        [{ minValue: -5 }, /minValue/],
    ];
    for (const [input, re] of cases) {
        const r = await runActor({ apiBaseUrl: srv.url, ...input });
        assert.notEqual(r.code, 0, `should fail: ${JSON.stringify(input)}`);
        assert.match(r.log, re);
        assert.match(r.log, /Invalid input/);
    }
});

test('API unreachable fails with a clear message after retries', async () => {
    // A port that was just free: nothing listens there.
    const net = await import('node:net');
    const port = await new Promise((resolve) => { const x = net.createServer().listen(0, '127.0.0.1', () => { const p = x.address().port; x.close(() => resolve(p)); }); });
    const r = await runActor({ apiBaseUrl: `http://127.0.0.1:${port}`, requestDelayMs: 0 });
    assert.notEqual(r.code, 0);
    assert.match(r.log, /Could not connect to MTender at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\) \(gave up after 6 attempts\)/);
});
