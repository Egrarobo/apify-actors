import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Actor, log } from 'apify';
import { resolveLatestSource, describeSource, downloadSource, isLocal } from './source.js';
import { parseCompanies } from './parse.js';
import { openCache, readMeta, touchMeta, writeCache, readCache } from './cache.js';
import { buildFilters, passesFilters, buildNameQuery, scoreName, prepareName } from './search.js';

const EVENT_RESULT = 'company-result';
const EVENT_BULK = 'bulk-export-item';
const MAX_RESULTS_CAP = 5000;
const BATCH = 500;

function validateInput(input) {
    const errors = [];
    const idnosIn = input.idnos ?? [];
    const namesIn = input.names ?? [];
    if (!Array.isArray(idnosIn)) errors.push('"idnos" must be an array of 13-digit codes, e.g. ["1002600048836"].');
    if (!Array.isArray(namesIn)) errors.push('"names" must be an array of strings, e.g. ["Moldtelecom"].');
    if (errors.length) throw new Error(errors.join(' '));

    const idnos = [];
    const invalidIdnos = [];
    for (const raw of idnosIn) {
        const s = String(raw ?? '').replace(/[\s-]/g, '');
        if (/^\d{13}$/.test(s)) { if (!idnos.includes(s)) idnos.push(s); } else if (String(raw ?? '').trim()) invalidIdnos.push(String(raw));
    }
    const names = [...new Set(namesIn.map((n) => String(n ?? '').trim()).filter(Boolean))];
    if (names.some((n) => n.length < 2)) throw new Error('Each name query must have at least 2 characters.');

    const nameMatch = input.nameMatch ?? 'contains';
    if (!['contains', 'exact', 'fuzzy'].includes(nameMatch)) throw new Error('"nameMatch" must be "contains", "exact" or "fuzzy".');
    // Accepts a percentage (50-100, as in the input form) or a fraction (0.5-1).
    let fuzzyThreshold = Number(input.fuzzyThreshold ?? 75);
    if (fuzzyThreshold > 1) fuzzyThreshold /= 100;
    if (!(fuzzyThreshold >= 0.5 && fuzzyThreshold <= 1)) throw new Error('"fuzzyThreshold" must be a percentage from 50 to 100.');
    const maxResults = Number(input.maxResults ?? 25);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_CAP) throw new Error(`"maxResults" must be an integer from 1 to ${MAX_RESULTS_CAP}.`);
    const exportLimit = Number(input.exportLimit ?? 0);
    if (!Number.isInteger(exportLimit) || exportLimit < 0) throw new Error('"exportLimit" must be 0 (no limit) or a positive integer.');
    const cacheMaxAgeHours = Number(input.cacheMaxAgeHours ?? 24);
    if (!(cacheMaxAgeHours >= 0)) throw new Error('"cacheMaxAgeHours" must be 0 or more.');

    const filters = buildFilters(input.filters ?? {});
    const exportAll = input.exportAll === true;

    if (exportAll && (idnos.length || names.length)) {
        throw new Error('"exportAll" exports the whole register (optionally narrowed by "filters"). Remove "idnos"/"names", or turn "exportAll" off to do a lookup.');
    }
    if (!exportAll && !idnos.length && !names.length && !filters.active) {
        throw new Error(invalidIdnos.length
            ? `No valid IDNO given. An IDNO is exactly 13 digits (e.g. 1002600048836). Invalid: ${invalidIdnos.join(', ')}.`
            : 'Nothing to look up. Provide "idnos", "names" or "filters" (or set "exportAll": true).');
    }
    return {
        idnos, invalidIdnos, names, nameMatch, fuzzyThreshold, maxResults, exportAll, exportLimit, filters,
        cacheMaxAgeHours, forceRefresh: input.forceRefresh === true,
        includePeople: input.includePeople !== false,
        includeRawColumns: input.includeRawColumns === true,
        sourceFileUrl: input.sourceFileUrl ? String(input.sourceFileUrl).trim() : null,
    };
}

async function loadData(opts) {
    const store = await openCache();
    const meta = await readMeta(store);
    const ageH = meta ? (Date.now() - new Date(meta.checkedAt).getTime()) / 3600000 : Infinity;

    const rebuild = async (src) => {
        const tmp = path.join(os.tmpdir(), 'moldova-registry');
        const dl = await downloadSource(src.url, tmp);
        try {
            const newMeta = await writeCache(store, parseCompanies(dl.filePath, dl.kind), src);
            return newMeta;
        } finally {
            if (!isLocal(src.url)) fs.rmSync(dl.filePath, { force: true });
        }
    };
    const sameFile = (m, src) => m && m.sourceUrl === src.url
        && (!src.lastModified || !m.lastModified || m.lastModified === src.lastModified)
        && (!src.dataDate || !m.dataDate || m.dataDate === src.dataDate);

    let active;
    if (opts.sourceFileUrl) {
        const src = await describeSource(opts.sourceFileUrl);
        if (!opts.forceRefresh && sameFile(meta, src) && meta.lastModified === src.lastModified) {
            log.info('Using cached data for the given sourceFileUrl.');
            active = meta;
        } else active = await rebuild(src);
    } else if (meta && !opts.forceRefresh && !isLocal(meta.sourceUrl) && ageH < opts.cacheMaxAgeHours) {
        log.info(`Using cached register (checked ${ageH.toFixed(1)} h ago, data date ${meta.dataDate ?? 'unknown'}).`);
        active = meta;
    } else {
        let latest;
        try {
            latest = await resolveLatestSource();
        } catch (e) {
            if (meta && !isLocal(meta.sourceUrl)) {
                log.warning(`${e.message} Using the previously cached copy (data date ${meta.dataDate ?? 'unknown'}).`);
                return { store, meta, stale: true };
            }
            throw e;
        }
        if (!opts.forceRefresh && sameFile(meta, latest)) {
            log.info('The official file has not changed since the last download. Using cache.');
            active = await touchMeta(store, meta);
        } else {
            active = await rebuild(latest);
        }
    }
    return { store, meta: active, stale: false };
}

function toItem(rec, meta, opts, extra = {}) {
    const item = {
        found: true,
        idno: rec.idno,
        name: rec.name,
        legalForm: rec.legalForm,
        legalFormCode: rec.legalFormCode,
        status: rec.status,
        statusCategory: rec.statusCategory,
        registrationDate: rec.registrationDate,
        liquidationDate: rec.liquidationDate,
        address: rec.address,
    };
    if (opts.includePeople) {
        item.directors = rec.directors;
        item.founders = rec.founders;
        if (rec.beneficialOwners?.length) item.beneficialOwners = rec.beneficialOwners;
    }
    item.activityCodes = rec.activityCodes;
    item.activities = rec.activities;
    if (rec.licensedActivities?.length) item.licensedActivities = rec.licensedActivities;
    Object.assign(item, extra);
    if (opts.includeRawColumns) item.raw = rec.raw ?? {};
    item.sourceUrl = meta.sourceUrl;
    item.dataDate = meta.dataDate;
    return item;
}

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const opts = validateInput(input);
    if (opts.invalidIdnos.length) log.warning(`Ignoring invalid IDNO(s) (must be 13 digits): ${opts.invalidIdnos.join(', ')}`);

    const { store, meta, stale } = await loadData(opts);
    const isPpe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    let limitReached = false;
    const charged = { [EVENT_RESULT]: 0, [EVENT_BULK]: 0 };

    // Charges for a batch and pushes only what was paid for (the rest is dropped if the user's spending limit is hit).
    const emit = async (items, eventName) => {
        if (!items.length || limitReached) return 0;
        const res = isPpe ? await Actor.charge({ eventName, count: items.length }) : { chargedCount: items.length };
        if (res.chargedCount < items.length) {
            items = items.slice(0, res.chargedCount);
            limitReached = true;
            log.warning('Stopped early: the run reached the maximum cost you set.');
        }
        if (items.length) await Actor.pushData(items);
        charged[eventName] += items.length;
        return items.length;
    };

    const summary = { mode: opts.exportAll ? 'export' : 'lookup', sourceUrl: meta.sourceUrl, dataDate: meta.dataDate, companiesInRegister: meta.recordCount, staleCache: stale };

    if (opts.exportAll) {
        let batch = [];
        let exported = 0;
        for await (const rec of readCache(store, meta)) {
            if (!passesFilters(rec, opts.filters)) continue;
            batch.push(toItem(rec, meta, opts));
            if (opts.exportLimit && exported + batch.length >= opts.exportLimit) {
                batch = batch.slice(0, opts.exportLimit - exported);
                exported += await emit(batch, EVENT_BULK);
                batch = [];
                break;
            }
            if (batch.length >= BATCH) {
                exported += await emit(batch, EVENT_BULK);
                batch = [];
                if (limitReached) break;
                if (exported % 20000 === 0) log.info(`Exported ${exported} companies…`);
            }
        }
        exported += await emit(batch, EVENT_BULK);
        summary.exported = exported;
    } else {
        const idnoSet = new Set(opts.idnos);
        const byIdno = new Map();
        const queries = opts.names.map((n) => buildNameQuery(n, opts.nameMatch, opts.fuzzyThreshold));
        const hits = queries.map(() => []);
        const filterOnly = !opts.idnos.length && !opts.names.length;
        const filterHits = [];
        const rank = (a, b) => b.score - a.score
            || (a.rec.statusCategory === 'active' ? -1 : 0) - (b.rec.statusCategory === 'active' ? -1 : 0)
            || a.rec.name.length - b.rec.name.length;

        for await (const rec of readCache(store, meta)) {
            if (idnoSet.has(rec.idno)) byIdno.set(rec.idno, rec); // IDNO lookups ignore filters
            if (queries.length) {
                let pn = null;
                for (let qi = 0; qi < queries.length; qi++) {
                    pn ??= prepareName(rec.name);
                    const score = scoreName(pn, queries[qi]);
                    if (score > 0 && passesFilters(rec, opts.filters)) {
                        const list = hits[qi];
                        list.push({ rec, score });
                        if (list.length > Math.max(200, opts.maxResults * 3)) { list.sort(rank); list.length = opts.maxResults; }
                    }
                }
            } else if (filterOnly && passesFilters(rec, opts.filters)) {
                filterHits.push(rec);
                if (filterHits.length >= opts.maxResults) break;
            }
        }

        const out = [];
        const seen = new Set();
        const notFound = [];
        for (const idno of opts.idnos) {
            const rec = byIdno.get(idno);
            if (rec) { out.push(toItem(rec, meta, opts, { matchedQuery: idno })); seen.add(idno); } else notFound.push(idno);
        }
        queries.forEach((q, qi) => {
            const list = hits[qi].sort(rank).slice(0, opts.maxResults);
            if (!list.length) log.info(`No company matches name "${q.original}".`);
            for (const { rec, score } of list) {
                if (seen.has(rec.idno)) continue;
                seen.add(rec.idno);
                out.push(toItem(rec, meta, opts, { matchedQuery: q.original, matchScore: score }));
            }
        });
        for (const rec of filterHits) out.push(toItem(rec, meta, opts));

        let returned = 0;
        for (let i = 0; i < out.length && !limitReached; i += BATCH) returned += await emit(out.slice(i, i + BATCH), EVENT_RESULT);

        // Not-found and invalid IDNOs are reported as free items so agents get an explicit answer.
        const misses = [
            ...notFound.map((idno) => ({ found: false, idno, matchedQuery: idno, error: 'IDNO not found in the official register file.', sourceUrl: meta.sourceUrl, dataDate: meta.dataDate })),
            ...opts.invalidIdnos.map((q) => ({ found: false, idno: null, matchedQuery: q, error: 'Invalid IDNO: must be exactly 13 digits.', sourceUrl: meta.sourceUrl, dataDate: meta.dataDate })),
        ];
        if (misses.length) await Actor.pushData(misses);
        Object.assign(summary, { returned, notFoundIdnos: notFound, invalidIdnos: opts.invalidIdnos, nameQueriesWithoutMatch: queries.filter((_, qi) => !hits[qi].length).map((q) => q.original) });
    }

    summary.chargedEvents = charged;
    summary.stoppedBySpendingLimit = limitReached;
    await Actor.setValue('OUTPUT', summary);
    const msg = opts.exportAll
        ? `Exported ${summary.exported} companies (data date ${meta.dataDate ?? 'unknown'}).`
        : `Found ${summary.returned} companies${summary.notFoundIdnos.length ? `, ${summary.notFoundIdnos.length} IDNO(s) not found` : ''} (data date ${meta.dataDate ?? 'unknown'}).`;
    log.info(msg);
    await Actor.setStatusMessage(msg).catch(() => {});
    await Actor.exit();
} catch (err) {
    log.error(err.message);
    await Actor.fail(err.message);
}
