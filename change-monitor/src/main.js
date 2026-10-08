import { Actor, log } from 'apify';
import { resolveSource, hasSource } from './source.js';
import { runDemoComparison } from './demo.js';
import { StateStore } from './state.js';
import { project, normalize, hash, fingerprint, stableStringify, diff, keyOf } from './diff.js';
import { sendNotifications } from './notify.js';

const EVENT_CHANGE = 'change-detected';
const EVENT_COMPARED = 'items-compared'; // charged once per started 1,000 items
const PUSH_BATCH = 250;
const DEFAULT_STORE = 'change-monitor-state';

const toList = (v, name) => {
    if (v === undefined || v === null || v === '') return [];
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    if (!Array.isArray(v)) throw new Error(`"${name}" must be a list of field names, e.g. ["url"].`);
    return v.map((s) => String(s).trim()).filter(Boolean);
};
const toInt = (v, def, min, max, name) => {
    if (v === undefined || v === null || v === '') return def;
    const x = Number(v);
    if (!Number.isFinite(x) || x < min) throw new Error(`"${name}" must be a number of at least ${min}.`);
    return Math.min(Math.floor(x), max);
};

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const idFields = toList(input.idFields, 'idFields');
    const compareFields = toList(input.compareFields, 'compareFields');
    const ignoreFields = toList(input.ignoreFields, 'ignoreFields');
    const reportNew = input.reportNew !== false;
    const reportChanged = input.reportChanged !== false;
    const trackRemoved = input.trackRemoved !== false;
    const reportAllOnFirstRun = input.reportAllOnFirstRun === true;
    const detailedDiff = input.detailedDiff !== false;
    const resetState = input.resetState === true;
    const allowEmptySource = input.allowEmptySource === true;
    const maxItems = toInt(input.maxItems, 0, 0, Number.MAX_SAFE_INTEGER, 'maxItems'); // 0 = no limit
    const maxChangesPerItem = toInt(input.maxChangesPerItem, 20, 1, 200, 'maxChangesPerItem');
    const notifyMaxItems = toInt(input.notifyMaxItems, 10, 0, 100, 'notifyMaxItems');
    const webhookMaxItems = toInt(input.webhookMaxItems, 100, 0, 1000, 'webhookMaxItems');
    const notifyOnNoChanges = input.notifyOnNoChanges === true;
    const storeName = (input.stateStoreName || DEFAULT_STORE).trim();
    if (!/^[a-zA-Z0-9-]{1,63}$/.test(storeName)) throw new Error('"stateStoreName" may only contain letters, digits and "-" (max 63 characters).');
    if (!reportNew && !reportChanged && !trackRemoved) throw new Error('Nothing to report: enable at least one of "Report new items", "Report changed items" or "Report removed items".');

    if (!hasSource(input)) {
        // No data source: run a free built-in demo instead of failing, so the first click in Console,
        // the Store "Try" button and the daily Store health check always show a real result.
        log.warning('No data source given ("datasetId", "actorRunId", "datasetUrl", "items" or an integration). '
            + 'Running a free DEMO that compares two built-in sample snapshots of a fictional shop. No state is saved and no change events are charged.');
        const demo = runDemoComparison({ idFields, compareFields, ignoreFields, maxChangesPerItem });
        const detectedAt = new Date().toISOString();
        const records = demo.changes.map((c) => ({ ...c, monitorName: 'demo', detectedAt, demo: true }));
        await Actor.pushData(records);
        const demoCounts = { new: 0, changed: 0, removed: 0 };
        for (const r of records) demoCounts[r.changeType]++;
        const status = `DEMO: ${demoCounts.new} new, ${demoCounts.changed} changed, ${demoCounts.removed} removed, ${demo.unchanged} unchanged. `
            + 'Add a dataset ID, run ID, JSON/CSV URL or items to monitor your own data.';
        await Actor.setValue('OUTPUT', {
            monitorName: 'demo', demo: true, isBaseline: false, ...demoCounts, unchanged: demo.unchanged,
            reported: records.length, previousItems: demo.previousItems, currentItems: demo.currentItems,
            snapshotUpdated: false, finishedAt: new Date().toISOString(),
        });
        log.info(status);
        await Actor.exit({ statusMessage: status });
    }

    const source = await resolveSource(input);
    const monitorName = String(input.monitorName ?? '').trim()
        || (source.sourceRun.taskId && `task-${source.sourceRun.taskId}`)
        || (source.sourceRun.actorId && `actor-${source.sourceRun.actorId}`)
        || 'default';
    if (!input.monitorName) log.info(`No "monitorName" given, using "${monitorName}".`);
    log.info(`Monitor "${monitorName}": comparing ${source.description}. Key: ${idFields.length ? idFields.join(' + ') : 'whole item'}.`);

    const settingsFingerprint = hash(stableStringify({ idFields, compareFields, ignoreFields: compareFields.length ? [] : ignoreFields }));
    const store = await new StateStore(storeName, monitorName).open();
    let prevMeta = await store.loadMeta();
    if (prevMeta && resetState) {
        log.info('"Start over" is enabled: the previous snapshot is discarded and this run becomes the new baseline.');
        await store.reset(prevMeta);
        prevMeta = null;
    }
    if (prevMeta && prevMeta.settingsFingerprint !== settingsFingerprint) {
        log.warning('The key / compared / ignored fields differ from the previous run, so the old snapshot cannot be compared. This run becomes the new baseline.');
        prevMeta = { ...prevMeta, incompatible: true };
    }
    const prev = prevMeta && !prevMeta.incompatible ? await store.loadEntries(prevMeta) : null;
    const isBaseline = !prev;
    if (prev) log.info(`Previous snapshot: ${prev.size.toLocaleString('en-US')} items from ${prevMeta.updatedAt}.`);
    else log.info('No previous snapshot: this run creates the baseline.');
    const prevSize = prev?.size ?? 0;
    const baselineReport = isBaseline && reportAllOnFirstRun;

    const isPpe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    const detectedAt = new Date().toISOString();
    const next = new Map();
    const counts = { new: 0, changed: 0, removed: 0, unchanged: 0 };
    const stats = { itemsCompared: 0, duplicates: 0, itemsWithoutKey: 0, invalidItems: 0 };
    const previewByType = { new: [], changed: [], removed: [] };
    const webhookChanges = [];
    let reported = 0;
    let pending = [];
    let limitReached = false;
    let truncated = false;

    const flush = async () => {
        if (!pending.length || limitReached) return;
        let batch = pending;
        pending = [];
        const charge = await Actor.charge({ eventName: EVENT_CHANGE, count: batch.length });
        if (isPpe && charge.chargedCount < batch.length) {
            batch = batch.slice(0, charge.chargedCount);
            limitReached = true;
        }
        if (batch.length) await Actor.pushData(batch);
        reported += batch.length;
        for (const record of batch) {
            const bucket = previewByType[record.changeType];
            if (bucket.length < notifyMaxItems) bucket.push(record);
            if (webhookChanges.length < webhookMaxItems) webhookChanges.push(record);
        }
    };
    const report = async (change) => {
        if (limitReached) return;
        counts[change.changeType]++;
        const record = { changeType: change.changeType, key: change.key, changedFields: change.changedFields ?? [], ...change, monitorName, detectedAt };
        pending.push(record);
        if (pending.length >= PUSH_BATCH) await flush();
    };

    outer:
    for await (const page of source.iterate()) {
        for (const item of page) {
            if (maxItems && stats.itemsCompared >= maxItems) {
                truncated = true;
                break outer;
            }
            if (item === null || typeof item !== 'object' || Array.isArray(item)) {
                stats.invalidItems++;
                continue;
            }
            if (stats.itemsCompared % 1000 === 0) {
                const charge = await Actor.charge({ eventName: EVENT_COMPARED, count: 1 });
                if (isPpe && charge.chargedCount < 1) {
                    limitReached = true;
                    break outer;
                }
            }
            stats.itemsCompared++;

            const norm = normalize(project(item, { compareFields, ignoreFields }));
            const itemHash = fingerprint(norm);
            const key = keyOf(item, idFields, norm);
            if (key === null) {
                stats.itemsWithoutKey++;
                continue;
            }
            if (next.has(key)) {
                stats.duplicates++;
                continue;
            }
            next.set(key, [itemHash, detailedDiff ? norm : undefined]);

            if (!prev) {
                if (baselineReport && reportNew) await report({ changeType: 'new', key, item });
                continue;
            }
            const old = prev.get(key);
            if (!old) {
                if (reportNew) await report({ changeType: 'new', key, item });
                else counts.new++;
                continue;
            }
            prev.delete(key);
            if (old[0] === itemHash) {
                counts.unchanged++;
                continue;
            }
            if (!reportChanged) {
                counts.changed++;
                continue;
            }
            let changes = null;
            let totalChangedFields = null;
            if (detailedDiff && old[1] !== undefined) {
                ({ changes, totalChangedFields } = diff(old[1], norm, { maxChanges: maxChangesPerItem }));
            }
            await report({
                changeType: 'changed',
                key,
                changedFields: changes ? changes.map((c) => c.field) : [],
                changes: changes ?? undefined,
                totalChangedFields: totalChangedFields ?? undefined,
                item,
            });
        }
        if (stats.itemsCompared && stats.itemsCompared % 10000 < page.length) log.info(`Compared ${stats.itemsCompared.toLocaleString('en-US')} items…`);
    }

    // Safety net: an empty source (e.g. a scraper that got blocked) would otherwise mark everything as removed.
    const emptySourceGuard = stats.itemsCompared === 0 && !allowEmptySource && !limitReached;
    if (emptySourceGuard) {
        log.warning(prev
            ? 'The source has no items, but the previous run had some. Nothing is reported as removed and the previous snapshot is kept. '
                + 'Enable "Allow an empty source" if an empty result is legitimate.'
            : 'The source has no items, so no baseline was saved. The next run with data becomes the baseline.');
    }
    if (truncated) log.warning(`Stopped at maxItems = ${maxItems}. Items beyond the limit are not compared, so removals are not reported in this run.`);

    if (prev && !limitReached && !emptySourceGuard) {
        if (truncated) {
            for (const [key, entry] of prev) next.set(key, entry); // keep unseen items for the next run
        } else {
            for (const [key, [, snap]] of prev) {
                if (trackRemoved) await report({ changeType: 'removed', key, item: snap ?? null });
                else counts.removed++;
                if (limitReached) break;
            }
        }
    }
    await flush();

    const summary = {
        ...counts,
        reported,
        itemsCompared: stats.itemsCompared,
        previousItems: prevSize,
        currentItems: next.size,
    };
    // Counts include types the user switched off (informational); "reported" is what was output and charged.

    let savedState = false;
    if (limitReached) {
        log.warning(`The run reached your maximum cost per run after reporting ${reported} changes. `
            + 'The snapshot was NOT updated, so the next run will compare against the same previous data again. Raise the limit to process everything.');
    } else if (emptySourceGuard) {
        log.info(prev ? 'Previous snapshot kept unchanged.' : 'Nothing saved.');
    } else {
        const meta = await store.save(next, {
            monitorName, settingsFingerprint, idFields, compareFields, ignoreFields, detailedDiff, source: source.description,
            runId: process.env.ACTOR_RUN_ID ?? process.env.APIFY_ACTOR_RUN_ID ?? null,
        }, prevMeta);
        savedState = true;
        log.info(`Snapshot saved: ${meta.itemCount.toLocaleString('en-US')} items in store "${storeName}" (${meta.parts} part(s)).`);
    }

    const datasetId = process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID;
    const resultsUrl = Actor.isAtHome() && datasetId ? `https://console.apify.com/storage/datasets/${datasetId}` : null;

    // Mix change types in the message so e.g. 500 changed items do not hide the new ones.
    const previewChanges = [];
    const buckets = Object.values(previewByType).map((b) => [...b]);
    while (previewChanges.length < notifyMaxItems && buckets.some((b) => b.length)) {
        for (const b of buckets) if (b.length && previewChanges.length < notifyMaxItems) previewChanges.push(b.shift());
    }

    let notifications = {};
    if ((reported > 0 || notifyOnNoChanges) && !emptySourceGuard) {
        notifications = await sendNotifications(input, { monitorName, summary, previewChanges, webhookChanges, resultsUrl, costLimitReached: limitReached });
    }

    const output = {
        monitorName,
        isBaseline,
        ...summary,
        duplicateKeysSkipped: stats.duplicates,
        itemsWithoutKey: stats.itemsWithoutKey,
        invalidItemsSkipped: stats.invalidItems,
        stoppedAtMaxItems: truncated,
        stoppedAtCostLimit: limitReached,
        emptySourceIgnored: emptySourceGuard,
        snapshotUpdated: savedState,
        stateStore: storeName,
        stateKey: store.metaKey,
        source: source.description,
        resultsUrl,
        notifications,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);
    if (stats.duplicates) log.warning(`${stats.duplicates} items had a key that already appeared earlier in the data and were skipped. Check "idFields".`);
    if (stats.itemsWithoutKey) log.warning(`${stats.itemsWithoutKey} items had no value in ${idFields.join(' + ')} and were skipped.`);

    const status = isBaseline && !reportAllOnFirstRun
        ? `Baseline saved: ${next.size.toLocaleString('en-US')} items. Changes will be reported from the next run.`
        : `${summary.new} new, ${summary.changed} changed, ${summary.removed} removed, ${summary.unchanged} unchanged (${stats.itemsCompared.toLocaleString('en-US')} compared).`;
    log.info(status);
    await Actor.exit({ statusMessage: status });
} catch (err) {
    log.error(err.message);
    await Actor.fail(err.message);
}
