import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { validateInputSchema } from '@apify/input_schema';
import { parseBin, checkDigit, decodeBin } from '../src/bin.js';
import { statusCategory, legalFormCode, splitActivity, toIsoDate, nameScore } from '../src/normalize.js';

test('BIN checksum: real published BINs validate', () => {
    // 950440001673: example BIN on org-id.guide (KZ-BIN); the others are well-known public companies.
    for (const bin of ['950440001673', '971240001315', '020240000555']) assert.equal(parseBin(bin).valid, true, bin);
    assert.equal(checkDigit('95044000167'), 3);
});

test('BIN: format, IIN detection, month, check digit, cleanup', () => {
    assert.equal(parseBin('9504 4000-1673').bin, '950440001673');
    assert.match(parseBin('95044000167').error, /12 digits/);
    assert.match(parseBin('880101300123').error, /IIN/);
    assert.match(parseBin('951340001673').error, /month/);
    assert.match(parseBin('950440001674').error, /check digit/);
    assert.match(parseBin('950470001673').error, /5th digit/);
});

test('BIN decoding', () => {
    const now = new Date('2026-09-26');
    assert.deepEqual(decodeBin('950440001673', now), { registrationYearMonth: '1995-04', entityType: 'resident_legal_entity', unitType: 'head_office' });
    assert.equal(decodeBin('230151000014', now).unitType, 'branch');
    assert.equal(decodeBin('230152000014', now).unitType, 'representative_office');
    assert.equal(decodeBin('230150000014', now).entityType, 'non_resident_legal_entity');
    assert.equal(decodeBin('230160000014', now).entityType, 'joint_individual_entrepreneurship');
});

test('normalization helpers', () => {
    assert.equal(statusCategory('Зарегистрирован'), 'active');
    assert.equal(statusCategory('Снят с регистрации'), 'liquidated');
    assert.equal(statusCategory('Ликвидирован'), 'liquidated');
    assert.equal(statusCategory('Тіркелген'), 'active');
    assert.equal(statusCategory('Приостановлен'), 'suspended');
    assert.equal(statusCategory(null), 'unknown');
    assert.equal(legalFormCode('Товарищество с ограниченной ответственностью "X"'), 'LLP');
    assert.equal(legalFormCode('"X" жауапкершілігі шектеулі серіктестігі'), 'LLP');
    assert.equal(legalFormCode('Акционерное общество "Y"'), 'JSC');
    assert.equal(legalFormCode('Филиал ТОО "Z" в г. Алматы'), 'BRANCH');
    assert.equal(legalFormCode('ТОО "Z"'), 'LLP');
    assert.equal(legalFormCode('"Z" ЖШС'), 'LLP');
    assert.equal(legalFormCode('АО "Z"'), 'JSC');
    assert.equal(legalFormCode('ТОО "Заокеанский"'), 'LLP');
    assert.deepEqual(splitActivity('64190 Прочая денежно-кредитная деятельность'), { code: '64190', name: 'Прочая денежно-кредитная деятельность' });
    assert.deepEqual(splitActivity('Разработка ПО'), { code: null, name: 'Разработка ПО' });
    assert.equal(toIsoDate('2015-01-20T00:00:00'), '2015-01-20');
    assert.equal(toIsoDate('20.01.2015'), '2015-01-20');
    assert.ok(nameScore({ nameru: 'ТОО "Робокод Казахстан"' }, 'робокод') > 0.5);
    assert.equal(nameScore({ nameru: 'ТОО "Робокод Казахстан"' }, 'робокод алматы'), 0);
    assert.equal(nameScore({ nameru: 'ТОО "Робокод"' }, 'ТОО Робокод'), 1);
});

test('input schema is valid for the Apify platform', () => {
    const schema = JSON.parse(fs.readFileSync(new URL('../.actor/input_schema.json', import.meta.url), 'utf8'));
    validateInputSchema(new Ajv2019({ strict: false }), schema);
});
