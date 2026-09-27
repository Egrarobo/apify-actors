import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fold, buildMatcher } from '../src/filters.js';
import { parseOcid } from '../src/api.js';
import { parseDate, parseInput, InputError } from '../src/input.js';
import { normalizeTender, extractIdno } from '../src/normalize.js';

const fixture = (ocid) => JSON.parse(readFileSync(new URL(`./fixtures/tenders/${ocid}.json`, import.meta.url), 'utf8'));

test('fold removes Romanian diacritics (both comma-below and cedilla) and case, keeps Cyrillic', () => {
    assert.equal(fold('Achiziționarea MEDICAMENTELOR'), 'achizitionarea medicamentelor');
    assert.equal(fold('Reparația capitală, str. Ştefan cel Mare'), 'reparatia capitala str stefan cel mare');
    assert.equal(fold('ţară şi ţărm'), 'tara si tarm');
    assert.equal(fold('Закупка КОМПЬЮТЕРНОЙ техники, ёлка'), 'закупка компьютернои техники елка');
});

test('parseOcid accepts OCIDs, portal/API links and stage OCIDs', () => {
    assert.equal(parseOcid('ocds-b3wdp1-MD-1612345678901'), 'ocds-b3wdp1-MD-1612345678901');
    assert.equal(parseOcid('https://mtender.gov.md/tenders/ocds-b3wdp1-MD-1612345678901'), 'ocds-b3wdp1-MD-1612345678901');
    assert.equal(parseOcid('https://mtender.gov.md/en/tenders/ocds-b3wdp1-md-1612345678901?tab=lots'), 'ocds-b3wdp1-MD-1612345678901');
    assert.equal(parseOcid('ocds-b3wdp1-MD-1612345678901-EV-1612345679999'), 'ocds-b3wdp1-MD-1612345678901');
    assert.equal(parseOcid('abc'), null);
});

test('parseDate: absolute, date-only, relative', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    assert.equal(parseDate('2026-09-01', 'x', { now }), '2026-09-01T00:00:00.000Z');
    assert.equal(parseDate('2026-09-01', 'x', { now, endOfDay: true }), '2026-09-01T23:59:59.999Z');
    assert.equal(parseDate('7 days', 'x', { now }), '2026-09-19T12:00:00.000Z');
    assert.equal(parseDate('-12 hours', 'x', { now }), '2026-09-26T00:00:00.000Z');
    assert.equal(parseDate('2 weeks ago', 'x', { now }), '2026-09-12T12:00:00.000Z');
    assert.throws(() => parseDate('last tuesday', 'dateFrom', { now }), InputError);
});

test('parseInput: modes and validation', () => {
    assert.equal(parseInput({}).mode, 'search');
    assert.equal(parseInput({ monitorName: 'x' }).mode, 'monitor');
    assert.equal(parseInput({ monitorName: 'x', tenderIds: ['ocds-b3wdp1-MD-1612345678901'] }).mode, 'details');
    assert.throws(() => parseInput({ tenderIds: ['nope'] }), /not valid MTender OCIDs/);
    assert.throws(() => parseInput({ statuses: ['open'] }), /Unknown status/);
    assert.throws(() => parseInput({ cpvPrefixes: ['abc'] }), /not a CPV code/);
    assert.throws(() => parseInput({ minValue: 10, maxValue: 5 }), /larger than/);
    assert.throws(() => parseInput({ currency: 'lei MD' }), /3-letter/);
    assert.throws(() => parseInput({ dateFrom: '2026-09-10', dateTo: '2026-09-01' }), /before/);
    assert.throws(() => parseInput({ apiBaseUrl: 'ftp://x' }), /apiBaseUrl/);
    assert.throws(() => parseInput({ stateStoreName: 'bad name' }), /stateStoreName/);
    assert.throws(() => parseInput([]), /JSON object/);
});

test('normalizeTender merges the process record with EV/AC stage records', () => {
    const ocid = 'ocds-b3wdp1-MD-1789030800000';
    const t = normalizeTender(fixture(ocid), ocid);
    assert.equal(t.title, 'Reparația capitală a drumului str. Ștefan cel Mare');
    assert.equal(t.status, 'complete');
    assert.equal(t.value, 8500000);
    assert.equal(t.buyerIdno, '1007601004785');
    assert.deepEqual(t.suppliers, ['Drumuri-Construct SRL']);
    assert.equal(t.awardedValue, 7950000);
    assert.equal(t.contracts[0].awardId, 'aw-1');
    assert.equal(t.bidsCount, 3);
    assert.deepEqual(t.stages, ['EV', 'AC']);
    assert.equal(t.url, `https://mtender.gov.md/tenders/${ocid}`);
    assert.equal(t.raw, undefined);
    assert.ok(normalizeTender(fixture(ocid), ocid, { includeRaw: true }).raw.records);
});

test('normalizeTender: lots, items, documents, periods, auction', () => {
    const ocid = 'ocds-b3wdp1-MD-1789027200000';
    const t = normalizeTender(fixture(ocid), ocid);
    assert.equal(t.lotsCount, 2);
    assert.equal(t.lots[0].cpv, '33651100-9');
    assert.match(t.lots[0].placeOfPerformance, /Testemițanu/);
    assert.deepEqual(t.cpvCodes, ['33600000-6', '33651100-9', '33661000-5']);
    assert.equal(t.enquiryPeriodEnd, '2026-09-20T08:00:00Z');
    assert.equal(t.tenderPeriodEnd, '2026-09-30T08:00:00Z');
    assert.equal(t.hasElectronicAuction, true);
    assert.equal(t.documents.length, 2);
    assert.match(t.documents[0].url, /^https:\/\/storage\.mtender\.gov\.md\/get\//);
    assert.equal(t.awards.length, 0);
    assert.equal(t.awardedValue, null);
});

test('normalizeTender: planning notice without value uses creation time as publication date', () => {
    const ocid = 'ocds-b3wdp1-MD-1789200000000';
    const t = normalizeTender(fixture(ocid), ocid);
    assert.equal(t.value, null);
    assert.equal(t.status, 'planning');
    assert.equal(t.datePublished, '2026-09-12T08:00:00.000Z');
    assert.equal(t.tenderPeriodStart, '2026-10-15T00:00:00Z');
});

test('normalizeTender tolerates empty and odd packages', () => {
    assert.equal(normalizeTender({}, 'x'), null);
    assert.equal(normalizeTender({ records: [{ ocid: 'x' }] }, 'x'), null);
    const t = normalizeTender({ records: [{ ocid: 'ocds-b3wdp1-MD-1', compiledRelease: { ocid: 'ocds-b3wdp1-MD-1', tender: { title: 'T', value: { amount: '12.5', currency: 'MDL' } } } }] }, 'ocds-b3wdp1-MD-1');
    assert.equal(t.title, 'T');
    assert.equal(t.value, 12.5);
    assert.deepEqual(t.lots, []);
    assert.equal(extractIdno('MD-IDNO-1003600012345'), '1003600012345');
});

test('matcher: keywords any/all, exclude, buyer, value, currency', () => {
    const ocid = 'ocds-b3wdp1-MD-1789027200000';
    const t = normalizeTender(fixture(ocid), ocid);
    const base = { keywords: [], excludeKeywords: [], keywordsMatch: 'any', statuses: [], methods: [], categories: [], cpvPrefixes: [], buyerNames: [], buyerIdnos: [], minValue: null, maxValue: null, currency: null, includeWithoutValue: false };
    const m = (f) => buildMatcher({ ...base, ...f })(t);
    assert.deepEqual(m({ keywords: ['MEDICAMENT', 'beton'] }).matchedKeywords, ['MEDICAMENT']);
    assert.equal(m({ keywords: ['medicament', 'beton'], keywordsMatch: 'all' }).ok, false);
    assert.equal(m({ keywords: ['amoxicilina'] }).ok, true, 'item descriptions are searched, diacritics-insensitive');
    assert.equal(m({ keywords: ['medicament'], excludeKeywords: ['analgezice'] }).ok, false);
    assert.equal(m({ buyerNames: ['timofei mosneaga'] }).ok, true);
    assert.equal(m({ buyerIdnos: ['1003600012345'] }).ok, true);
    assert.equal(m({ minValue: 1000000, maxValue: 2000000, currency: 'mdl' }).ok, true);
    assert.equal(m({ currency: 'EUR' }).ok, false);
    assert.equal(m({ cpvPrefixes: ['3365'] }).ok, true);
    assert.equal(m({ cpvPrefixes: ['45'] }).ok, false);
    assert.equal(m({ methods: ['OPENTENDER'] }).ok, true);
    assert.equal(m({ statuses: ['complete'] }).ok, false);
    assert.equal(m({ publishedFrom: '2026-09-11T00:00:00Z' }).ok, false);
});
