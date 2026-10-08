// End-to-end tests: run src/main.js as a child process against the local mock ACA portal (test/mock-server.mjs).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startMockServer, makePermits } from './mock-server.mjs';
import { runActor, newStorageDir } from './helpers.mjs';

let srv;
before(async () => { srv = await startMockServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const env = () => ({ ACCELA_BASE_URL: srv.url, ACCELA_TELEGRAM_API: `${srv.url}/telegram` });
const run = (input, opts = {}) => runActor({ requestDelayMs: 0, ...input }, { ...opts, env: { ...env(), ...(opts.env ?? {}) } });
const nums = (items) => items.map((i) => i.recordNumber);
const usToday = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(`${usToday()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const expected = (code, fromDays, toDays = 0) => srv.agencies[code].permits.filter((p) => p.opened >= daysAgo(fromDays) && p.opened <= daysAgo(toDays));

test('default-style search: date postback, grid paging, normalized output, no personal names', async () => {
    const r = await run({ agencies: ['PINELLAS'], lastNDays: 7 });
    assert.equal(r.code, 0, r.log);
    const exp = expected('PINELLAS', 6);
    assert.ok(exp.length > 10, 'fixture spans more than one page');
    assert.deepEqual(nums(r.items).sort(), exp.map((p) => p.number).sort());
    const posts = srv.posts('PINELLAS');
    assert.equal(posts.length, 2, 'one search + one next-page postback');
    const search = new URLSearchParams(posts[0].body);
    assert.equal(search.get('__EVENTTARGET'), 'ctl00$PlaceHolderMain$btnNewSearch');
    assert.equal(search.get('ctl00$PlaceHolderMain$generalSearchForm$txtGSStartDate'), `${daysAgo(6).slice(5, 7)}/${daysAgo(6).slice(8, 10)}/${daysAgo(6).slice(0, 4)}`);
    assert.ok(search.get('ACA_CS_FIELD') && search.get('__VIEWSTATE'));
    assert.equal(new URLSearchParams(posts[1].body).get('__EVENTTARGET'), 'ctl00$PlaceHolderMain$dgvPermitList$gdvPermitList$ctl13$lnkNext');

    const p = srv.agencies.PINELLAS.permits.find((x) => x.number === r.items[0].recordNumber);
    const it = r.items[0];
    assert.equal(it.agency, 'PINELLAS');
    assert.equal(it.agencyName, 'Pinellas County, FL');
    assert.equal(it.recordType, p.type);
    assert.equal(it.status, p.status);
    assert.equal(it.openedDate, p.opened);
    assert.equal(it.address, p.addressLines[0]);
    assert.equal(it.zip, p.address.slice(-5));
    assert.equal(it.state, 'FL');
    assert.equal(it.description, p.description);
    assert.match(it.detailUrl, new RegExp(`/PINELLAS/Cap/CapDetail\\.aspx\\?Module=Building&TabName=Building&capID1=${p.capID1}&capID2=00000&capID3=${p.capID3}`));
    assert.equal(it.detailsFetched, false);
    assert.equal(it.ownerName, null);
    assert.equal(it.source, 'grid');
    assert.equal(r.output.agencies[0].strategy, 'http');
    assert.match(r.log, /Search page loaded \(HTTP 200/);
    assert.match(r.log, /Page 1: 10 rows \(Showing 1-10 of \d+\)/);
});

test('details: contractor, license, phone, valuation, parcel; personal names only with the toggle', async () => {
    const r = await run({ agencies: ['PINELLAS'], lastNDays: 3, includeDetails: true });
    assert.equal(r.code, 0, r.log);
    assert.ok(r.items.length >= 2);
    for (const it of r.items) {
        const p = srv.agencies.PINELLAS.permits.find((x) => x.number === it.recordNumber);
        assert.equal(it.detailsFetched, true);
        assert.equal(it.contractorName, p.contractor.company);
        assert.equal(it.contractorPerson, p.contractor.person);
        assert.equal(it.contractorLicense, p.contractor.license);
        assert.equal(it.contractorLicenseType, p.contractor.licenseType);
        assert.equal(it.contractorPhone, `(${p.contractor.phone.slice(0, 3)}) ${p.contractor.phone.slice(3, 6)}-${p.contractor.phone.slice(6)}`);
        assert.equal(it.valuation, p.valuation);
        assert.equal(it.parcelNumber, p.parcel);
        assert.equal(it.applicantCompany, 'PERMIT RUNNERS INC');
        assert.equal(it.ownerName, null);
        assert.equal(it.applicantName, null);
        assert.equal(it.moreDetails['Owner Phone'], undefined, 'personal More Details fields are dropped');
    }
    assert.equal(srv.gets('PINELLAS', 'CapDetail').length, r.items.length);
    const withNames = await run({ agencies: ['PINELLAS'], lastNDays: 1, includeDetails: true, includePersonalNames: true });
    const it = withNames.items[0];
    const p = srv.agencies.PINELLAS.permits.find((x) => x.number === it.recordNumber);
    assert.equal(it.ownerName, p.owner.name);
    assert.equal(it.ownerMailingAddress, `${p.owner.street}, ${p.owner.csz}`);
    assert.equal(it.applicantName, p.applicant.name);
});

test('filters: trade categories / keywords, exclude, and server-side record types', async () => {
    const r = await run({ agencies: ['PINELLAS'], lastNDays: 20, permitTypes: ['roof', 'solar'] });
    assert.equal(r.code, 0, r.log);
    const exp = expected('PINELLAS', 19).filter((p) => /Roofing|Solar/.test(p.type));
    assert.deepEqual(nums(r.items).sort(), exp.map((p) => p.number).sort());
    assert.ok(r.items.every((i) => ['roofing', 'solar'].includes(i.category) && i.matchedKeywords.length === 1));

    const iss = await run({ agencies: ['PINELLAS'], lastNDays: 20, statuses: ['issued'] });
    assert.deepEqual(nums(iss.items).sort(), expected('PINELLAS', 19).filter((p) => p.status === 'Issued').map((p) => p.number).sort());

    const ex = await run({ agencies: ['PINELLAS'], lastNDays: 20, excludeKeywords: ['commercial'] });
    assert.ok(ex.items.length > 0 && ex.items.every((i) => !/Commercial/.test(i.recordType)));

    srv.reset();
    const st = await run({ agencies: ['PINELLAS'], lastNDays: 20, recordTypes: ['pools'] });
    assert.equal(st.code, 0, st.log);
    assert.deepEqual(nums(st.items).sort(), expected('PINELLAS', 19).filter((p) => p.type === 'Residential Pools and Spas').map((p) => p.number).sort());
    assert.equal(new URLSearchParams(srv.posts('PINELLAS')[0].body).get('ctl00$PlaceHolderMain$generalSearchForm$ddlGSPermitType'), 'Residential Pools and Spas');
    assert.match(st.log, /Searching 1 portal record type\(s\): Residential Pools and Spas/);

    const none = await run({ agencies: ['PINELLAS'], lastNDays: 2, recordTypes: ['Elevator'] });
    assert.equal(none.code, 0);
    assert.match(none.log, /None of the record types "Elevator" is in this portal's dropdown \(available: Commercial Signs; Residential Electrical/);
});

test('long period: split into date windows, newest first, no duplicates, maxRecordsPerAgency stops early', async () => {
    const r = await run({ agencies: ['PINELLAS'], lastNDays: 21, searchWindowDays: 7, exportMode: 'grid' });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, srv.agencies.PINELLAS.permits.length);
    assert.equal(new Set(nums(r.items)).size, r.items.length);
    const dates = r.items.map((i) => i.openedDate);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
    assert.equal(r.output.agencies[0].windows, 3);

    srv.reset();
    const lim = await run({ agencies: ['PINELLAS'], lastNDays: 21, maxRecordsPerAgency: 5 });
    assert.equal(lim.items.length, 5);
    assert.equal(srv.posts('PINELLAS').length, 1, 'no further pages or windows once the limit is reached');
});

test('CSV export: direct file, export handler link, and fallback to the grid when the export is not a file', async () => {
    const r = await run({ agencies: ['PINELLAS'], lastNDays: 21, searchWindowDays: 30, exportMode: 'csv' });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 35);
    assert.ok(r.items.every((i) => i.source === 'csv' && i.detailUrl === null && i.recordType && i.address));
    assert.equal(srv.posts('PINELLAS').length, 2, 'search + export instead of 4 page postbacks');
    assert.equal(r.output.agencies[0].csvExports, 1);

    srv.reset();
    const small = await run({ agencies: ['PINELLAS'], lastNDays: 21, searchWindowDays: 30, maxRecordsPerAgency: 0 });
    assert.equal(small.output.agencies[0].csvExports, 0, 'auto keeps the grid (with links) for 35 results');
    srv.reset();
    const auto = await run({ customAgencies: ['BIG'], lastNDays: 10, searchWindowDays: 30, maxRecordsPerAgency: 0 });
    assert.equal(auto.code, 0, auto.log);
    assert.equal(auto.output.agencies[0].csvExports, 1, 'auto uses CSV for a big pull (130 results) without details');
    assert.equal(auto.items.length, 130);
    assert.equal(srv.posts('BIG').length, 2);

    srv.reset();
    const h = await run({ customAgencies: ['EXPORTLINK'], lastNDays: 21, searchWindowDays: 30, exportMode: 'csv' });
    assert.equal(h.code, 0, h.log);
    assert.equal(h.items.length, 25);
    assert.equal(srv.gets('EXPORTLINK', 'Export.ashx').length, 1, 'followed the window.open(…) export link');

    srv.reset();
    const b = await run({ customAgencies: ['BROKENEXPORT'], lastNDays: 21, searchWindowDays: 30, exportMode: 'csv' });
    assert.equal(b.code, 0, b.log);
    assert.equal(b.items.length, 25);
    assert.ok(b.items.every((i) => i.source === 'grid' && i.detailUrl));
    assert.match(b.log, /"Download results" did not return a file/);
});

test('other grid layout (Clearwater-style columns) is mapped by header text', async () => {
    const r = await run({ agencies: ['CLEARWATER'], lastNDays: 21 });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 14);
    for (const it of r.items) {
        const p = srv.agencies.CLEARWATER.permits.find((x) => x.number === it.recordNumber);
        assert.equal(it.status, p.status);
        assert.equal(it.fullAddress, p.address);
        assert.equal(it.recordType, p.type);
    }
});

test('single match: ACA opens the record directly; flaky session is retried', async () => {
    const s = await run({ customAgencies: ['SINGLE'], lastNDays: 3, includeDetails: true });
    assert.equal(s.code, 0, s.log);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].source, 'detail');
    assert.equal(s.items[0].contractorName, srv.agencies.SINGLE.permits[0].contractor.company);

    const f = await run({ customAgencies: ['FLAKY'], lastNDays: 21 });
    assert.equal(f.code, 0, f.log);
    assert.equal(f.items.length, 12);
    assert.match(f.log, /the portal answered "An error has occurred/);
    assert.equal(f.output.agencies[0].sessions, 2);
});

test('broken detail page: permit saved without details and details not charged', async () => {
    const p0 = srv.agencies.PINELLAS.permits[0];
    p0.brokenDetail = true;
    try {
        const r = await run({ agencies: ['PINELLAS'], lastNDays: 1, includeDetails: true }, { env: ppeEnv(100) });
        assert.equal(r.code, 0, r.log);
        const it = r.items.find((i) => i.recordNumber === p0.number);
        assert.equal(it.detailsFetched, false);
        assert.match(r.log, /Details of .* could not be loaded/);
        assert.equal(r.output.detailsFetched, r.items.length - 1);
    } finally {
        p0.brokenDetail = false;
    }
});

test('monitor: silent baseline, then only new permits + Telegram/Slack/webhook alerts, then nothing', async () => {
    const storageDir = newStorageDir();
    const input = {
        agencies: ['PINELLAS'], lastNDays: 7, monitorName: 'pinellas-roofers', permitTypes: ['roof', 'solar', 'pool'],
        telegramBotToken: '123:ABC', telegramChatId: '42', slackWebhookUrl: `${srv.url}/hooks/slack`, webhookUrl: `${srv.url}/hooks/webhook`,
    };
    const r1 = await run(input, { storageDir });
    assert.equal(r1.code, 0, r1.log);
    assert.equal(r1.items.length, 0);
    assert.match(r1.log, /Baseline saved: \d+ matching permits remembered/);
    assert.equal(srv.state.notifications.length, 0, 'no alerts for the baseline');

    srv.state.laterPermits.PINELLAS = makePermits('PINELLAS', 4, { days: 1, prefix: 'NEW' });
    const newOnes = srv.state.laterPermits.PINELLAS.filter((p) => /Roofing|Solar|Pools/.test(p.type));
    const r2 = await run(input, { storageDir });
    assert.equal(r2.code, 0, r2.log);
    assert.deepEqual(nums(r2.items).sort(), newOnes.map((p) => p.number).sort());
    assert.ok(r2.items.every((i) => i.isNew && i.monitorName === 'pinellas-roofers'));
    const paths = srv.state.notifications.map((x) => x.path).sort();
    assert.deepEqual(paths, ['/hooks/slack', '/hooks/webhook', '/telegram/bot123:ABC/sendMessage']);
    const hook = srv.state.notifications.find((x) => x.path === '/hooks/webhook').body;
    assert.equal(hook.event, 'permits.new');
    assert.equal(hook.summary.newPermits, newOnes.length);
    assert.deepEqual(hook.permits.map((p) => p.recordNumber).sort(), newOnes.map((p) => p.number).sort());
    const slack = srv.state.notifications.find((x) => x.path === '/hooks/slack').body.text;
    assert.match(slack, new RegExp(`pinellas-roofers: ${newOnes.length} new permit`));
    assert.match(slack, /CapDetail\.aspx/);

    srv.state.notifications.length = 0;
    const r3 = await run(input, { storageDir });
    assert.equal(r3.items.length, 0);
    assert.equal(srv.state.notifications.length, 0, 'nothing new, no alert');
    const r4 = await run({ ...input, notifyOnNoChanges: true }, { storageDir });
    assert.equal(r4.items.length, 0);
    assert.match(srv.state.notifications[0].body.text, /no new permits/);
});

test('monitor: reportAllOnFirstRun and changed filters start a new baseline', async () => {
    const storageDir = newStorageDir();
    const r1 = await run({ agencies: ['PINELLAS'], lastNDays: 3, monitorName: 'all', reportAllOnFirstRun: true }, { storageDir });
    assert.equal(r1.items.length, expected('PINELLAS', 2).length);
    const r2 = await run({ agencies: ['PINELLAS'], lastNDays: 3, monitorName: 'all', permitTypes: ['pool'] }, { storageDir });
    assert.equal(r2.items.length, 0);
    assert.match(r2.log, /filters differ from the previous run/);
});

// Outside the Apify platform the SDK prices every event at 1 USD, so ACTOR_MAX_TOTAL_CHARGE_USD=2.5 allows 2 events.
const ppeEnv = (maxUsd) => ({
    ACTOR_TEST_PAY_PER_EVENT: 'true',
    ACTOR_MAX_TOTAL_CHARGE_USD: String(maxUsd),
    APIFY_ACTOR_PRICING_INFO: JSON.stringify({
        pricingModel: 'PAY_PER_EVENT',
        pricingPerEvent: { actorChargeEvents: { permit: { eventTitle: 'Permit', eventPriceUsd: 0.01 }, 'permit-details': { eventTitle: 'Permit details', eventPriceUsd: 0.01 } } },
    }),
    APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
});

test('pay-per-event: stops cleanly at the spending limit (with and without details)', async () => {
    const r = await run({ agencies: ['PINELLAS'], lastNDays: 7 }, { env: ppeEnv(2.5) });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 2);
    assert.equal(r.output.stoppedAtCostLimit, true);
    assert.equal(srv.posts('PINELLAS').length, 1, 'no more pages loaded once the budget is used');
    assert.match(r.log, /Stopped at your maximum cost per run/);

    srv.reset();
    const d = await run({ agencies: ['PINELLAS'], lastNDays: 7, includeDetails: true }, { env: ppeEnv(2.5) });
    assert.equal(d.code, 0, d.log);
    assert.equal(d.items.length, 1, 'permit + details = 2 events');
    assert.equal(srv.gets('PINELLAS', 'CapDetail').length, 1, 'details are not fetched beyond the budget');
});

test('pay-per-event: monitor at the limit reports the rest on the next run (no loss, no duplicates)', async () => {
    const storageDir = newStorageDir();
    const input = { agencies: ['PINELLAS'], lastNDays: 7, monitorName: 'budget', reportAllOnFirstRun: true };
    const r1 = await run(input, { storageDir, env: ppeEnv(3.5) });
    assert.equal(r1.items.length, 3);
    const r2 = await run(input, { storageDir, env: ppeEnv(100) });
    const all = [...nums(r1.items), ...nums(r2.items)];
    assert.equal(new Set(all).size, all.length, 'no duplicates');
    assert.equal(all.length, expected('PINELLAS', 6).length, 'every permit reported exactly once');
});

test('errors: unknown agency, login-only module, CAPTCHA, wrong module, blocked portal', async () => {
    const bad = await run({ customAgencies: ['NOSUCHCITY'] });
    assert.notEqual(bad.code, 0);
    assert.match(bad.log, /"NOSUCHCITY" does not look like an Accela Citizen Access agency \(HTTP 404/);

    const mixed = await run({ agencies: ['PINELLAS'], customAgencies: ['NOSUCHCITY'], lastNDays: 2 });
    assert.equal(mixed.code, 0, 'one good agency is enough');
    assert.ok(mixed.items.length > 0);
    assert.match(mixed.output.agencies.find((a) => a.agency === 'NOSUCHCITY').error, /does not look like/);

    const login = await run({ customAgencies: ['LOGINONLY'] });
    assert.notEqual(login.code, 0);
    assert.match(login.log, /asks for a login/);

    const cap = await run({ customAgencies: ['CAPTCHA'] });
    assert.notEqual(cap.code, 0);
    assert.match(cap.log, /requires a CAPTCHA/);

    const mod = await run({ agencies: ['INDY'], module: 'Building' });
    assert.notEqual(mod.code, 0);
    assert.match(mod.log, /the Building module of INDY has no public date search\. Modules linked on this portal: Home, Permits, Licenses/);
    const ok = await run({ agencies: ['INDY'], lastNDays: 30 });
    assert.equal(ok.code, 0, ok.log);
    assert.equal(ok.items.length, 5, 'INDY uses its Permits module by default');

    const blocked = await run({ customAgencies: ['BLOCKED'], maxRetries: 1, browserFallback: false });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.log, /HTTP 403, Cloudflare challenge page/);
    assert.match(blocked.log, /Enable Apify Proxy \(ideally RESIDENTIAL/);
    assert.match(blocked.log, /DEBUG-BLOCKED-blocked-1/);
});

const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p));

test('blocked plain HTTP: escalates to browser cookies, then continues over HTTP', { skip: !CHROME && 'no Chrome/Chromium on this machine' }, async () => {
    const r = await run({ customAgencies: ['JSCHALLENGE'], lastNDays: 21, maxRetries: 3 }, { env: { BROWSER_EXECUTABLE_PATH: CHROME } });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.items.length, 12);
    assert.match(r.log, /Blocked \(open search page: HTTP 403, Cloudflare challenge page/);
    assert.match(r.log, /Session #3: HTTP with cookies from a real browser/);
    assert.match(r.log, /Browser passed the portal \(200, "Search for Records - Accela Citizen Access"\); continuing over HTTP with its cookies \(.*cf_clearance/);
    assert.equal(r.output.agencies[0].strategy, 'browser-cookies');

    const fb = await run({ customAgencies: ['JSCHALLENGE'], lastNDays: 21, forceBrowser: true, includeDetails: true, maxRecordsPerAgency: 2 }, { env: { BROWSER_EXECUTABLE_PATH: CHROME } });
    assert.equal(fb.code, 0, fb.log);
    assert.equal(fb.items.length, 2);
    assert.ok(fb.items.every((i) => i.detailsFetched && i.contractorName));
    assert.equal(fb.output.agencies[0].strategy, 'browser');
});

test('bad input fails with a clear message', async () => {
    for (const [input, re] of [
        [{ dateFrom: '2026-09-10', dateTo: '2026-09-01' }, /before "dateFrom"/],
        [{ customAgencies: ['not a code!'] }, /Not an Accela agency code or portal URL/],
        [{ exportMode: 'xls' }, /exportMode/],
    ]) {
        const r = await run(input);
        assert.notEqual(r.code, 0);
        assert.match(r.log, /Invalid input/);
        assert.match(r.log, re);
    }
});

test('default input: two agencies (PINELLAS + HCFL), both saved', async () => {
    const r = await run({ lastNDays: 7 });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.output.agencies.map((a) => `${a.agency}:${a.status}`), ['PINELLAS:ok', 'HCFL:ok']);
    assert.ok(r.items.some((i) => i.agency === 'PINELLAS') && r.items.some((i) => i.agency === 'HCFL'));
});

test('one agency down for the whole run: retried once, reported as failed, the other agency is still saved and the run succeeds', async () => {
    srv.state.downLeft = 1000;
    const r = await run({ agencies: ['PINELLAS'], customAgencies: ['DOWN'], lastNDays: 7 });
    assert.equal(r.code, 0, r.log);
    assert.ok(r.items.length > 0 && r.items.every((i) => i.agency === 'PINELLAS'));
    const down = r.output.agencies.find((a) => a.agency === 'DOWN');
    assert.equal(down.status, 'failed');
    assert.equal(down.agencyRetries, 1);
    assert.match(down.error, /maintenance page/);
    assert.match(r.log, /\[DOWN\] Attempt 1\/2 failed: .*maintenance page.* Trying this agency once more/);
    assert.match(r.log, /\[DOWN\] FAILED after 2 attempts: .* The other agencies continue/);
    assert.match(r.log, /permit\(s\) saved from 1 agencies .* Failed: DOWN \(see log\)/);
});

test('short portal outage: the agency is tried once more and its permits are saved', async () => {
    srv.state.downLeft = 1;
    const r = await run({ customAgencies: ['DOWN'], lastNDays: 30 });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.output.agencies[0].status, 'ok');
    assert.equal(r.output.agencies[0].agencyRetries, 1);
    assert.equal(r.items.length, srv.agencies.DOWN.permits.filter((p) => p.opened >= daysAgo(29)).length);
});

test('settings errors are not retried (unknown agency fails at once)', async () => {
    const r = await run({ agencies: ['PINELLAS'], customAgencies: ['NOSUCHCITY'], lastNDays: 2 });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.output.agencies.find((a) => a.agency === 'NOSUCHCITY').agencyRetries, undefined);
    assert.doesNotMatch(r.log, /\[NOSUCHCITY\] Attempt 1\/2 failed/);
});
