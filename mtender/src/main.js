import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { MTenderClient } from './api.js';
import { normalizeTender } from './normalize.js';
import { buildMatcher } from './filters.js';
import { parseInput, InputError } from './input.js';
import { MonitorState } from './state.js';
import { sendNotifications, hasNotificationTargets } from './notify.js';

const EVENT_RESULT = 'tender-result';
const EVENT_ALERT = 'new-tender-alert';
// Re-check the last hour of the feed on every monitor run, in case MTender indexes updates with a delay.
const CURSOR_OVERLAP_MS = 60 * 60_000;
const MAX_PENDING_ATTEMPTS = 3;

const n = (x) => Number(x).toLocaleString('en-US');
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('base64url').slice(0, 16);

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const cfg = parseInput(input);
    const client = new MTenderClient({
        baseUrl: cfg.apiBaseUrl,
        concurrency: cfg.maxConcurrency,
        minDelayMs: cfg.requestDelayMs,
        backoffBaseMs: Number(process.env.MTENDER_BACKOFF_MS) || 1000,
    });
    const isPpe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    const startedAt = new Date().toISOString();
    const datasetId = process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID;
    const resultsUrl = Actor.isAtHome() && datasetId ? `https://console.apify.com/storage/datasets/${datasetId}` : null;

    const stats = { tendersScanned: 0, matched: 0, pushed: 0, notFound: 0, fetchErrors: 0, pagesRead: 0 };
    let limitReached = false;

    const finish = (t, extra = {}) => {
        t.apiUrl = `${cfg.apiBaseUrl}/tenders/${t.ocid}`;
        return { ...t, ...extra, scrapedAt: startedAt };
    };

    /** Charges and stores tenders; stops cleanly at the user's spending limit. Returns how many were stored. */
    const chargingManager = Actor.getChargingManager();
    const emit = async (tenders, eventName) => {
        if (!tenders.length || limitReached) return 0;
        let batch = tenders;
        if (isPpe) {
            // Charge only what the budget allows (the SDK would otherwise overcharge by one event and the
            // platform would abort the run instead of letting it finish cleanly).
            const allowed = chargingManager.calculateMaxEventChargeCountWithinLimit(eventName);
            if (allowed < batch.length) {
                batch = batch.slice(0, Math.max(0, allowed));
                limitReached = true;
            }
            if (!batch.length) return 0;
        }
        const charge = await Actor.charge({ eventName, count: batch.length });
        if (isPpe && charge.chargedCount < batch.length) {
            batch = batch.slice(0, charge.chargedCount);
            limitReached = true;
        }
        if (batch.length) await Actor.pushData(batch);
        stats.pushed += batch.length;
        // Budget used up exactly: stop now instead of loading more tenders that could not be paid for.
        if (isPpe && chargingManager.calculateMaxEventChargeCountWithinLimit(eventName) < 1) limitReached = true;
        return batch.length;
    };

    /** Fetches and normalizes a list of OCIDs with the client's concurrency. */
    const fetchTenders = async (ocids) => Promise.all(ocids.map(async (ocid) => {
        try {
            const pkg = await client.getRecordPackage(ocid);
            if (!pkg) return { ocid, notFound: true };
            const tender = normalizeTender(pkg, ocid, { includeRaw: cfg.includeRaw });
            if (!tender) return { ocid, notFound: true };
            return { ocid, tender };
        } catch (err) {
            return { ocid, error: err.message };
        }
    }));

    let output;

    if (cfg.mode === 'details') {
        // ── Details for given tender IDs ───────────────────────────────────────────────
        log.info(`Getting details for ${cfg.tenderIds.length} tender(s) from ${cfg.apiBaseUrl}…`);
        const ids = cfg.maxResults ? cfg.tenderIds.slice(0, cfg.maxResults) : cfg.tenderIds;
        if (ids.length < cfg.tenderIds.length) log.warning(`Only the first ${ids.length} IDs are processed (maxResults).`);
        const failed = [];
        for (let i = 0; i < ids.length && !limitReached; i += 25) {
            const results = await fetchTenders(ids.slice(i, i + 25));
            const found = [];
            const problems = [];
            for (const r of results) {
                stats.tendersScanned++;
                if (r.tender) found.push(finish(r.tender));
                else if (r.notFound) {
                    stats.notFound++;
                    problems.push({ ocid: r.ocid, url: `https://mtender.gov.md/tenders/${r.ocid}`, error: 'Tender not found on MTender. Check the ID.', scrapedAt: startedAt });
                } else {
                    stats.fetchErrors++;
                    failed.push(r.ocid);
                    problems.push({ ocid: r.ocid, url: `https://mtender.gov.md/tenders/${r.ocid}`, error: `Could not load the tender: ${r.error}`, scrapedAt: startedAt });
                }
            }
            await emit(found, EVENT_RESULT);
            // Error records are free and help integrations see which IDs failed.
            if (!limitReached && problems.length) await Actor.pushData(problems);
        }
        if (stats.notFound) log.warning(`${stats.notFound} tender ID(s) were not found on MTender.`);
        if (failed.length) log.warning(`${failed.length} tender(s) could not be loaded after retries: ${failed.slice(0, 5).join(', ')}`);
        if (stats.fetchErrors && stats.fetchErrors === ids.length) {
            throw new Error(`None of the tenders could be loaded from ${cfg.apiBaseUrl}. MTender may be down; try again later.`);
        }
        output = { mode: 'details', ...stats };
    } else {
        // ── Search or monitor: walk the MTender feed and filter ──────────────────────────
        const isMonitor = cfg.mode === 'monitor';
        let state = null;
        let store = null;
        let isBaseline = false;
        const settingsFingerprint = hash({ f: cfg.filters, feed: cfg.feed, p: cfg.onlyNewlyPublished });
        let since = cfg.dateFrom;
        let publishedFrom = cfg.onlyNewlyPublished ? cfg.dateFrom : null;

        if (isMonitor) {
            store = await new MonitorState(cfg.stateStoreName, cfg.monitorName).open();
            state = await store.load();
            if (state && cfg.resetState) {
                log.info('"Start over" is enabled: the memory of this monitor is cleared and this run creates a new baseline.');
                await store.reset();
                state = null;
            }
            if (state && state.settingsFingerprint !== settingsFingerprint) {
                log.warning('The filters differ from the previous run of this monitor. This run becomes a new baseline: '
                    + 'current matches are remembered but not alerted, so you are not flooded with old tenders.');
                state = { ...state, settingsFingerprint, cursor: null, baselineFrom: cfg.dateFrom, baselineComplete: false };
            }
            if (!state) {
                state = { monitorName: cfg.monitorName, settingsFingerprint, baselineFrom: cfg.dateFrom, baselineComplete: false, cursor: null, seen: {}, pending: {}, createdAt: startedAt, runs: 0 };
            }
            // The baseline lasts until one full pass over the start period has finished (it may need several runs with a small maxScan).
            isBaseline = state.baselineComplete === false;
            state.pending ??= {};
            state.seen ??= {};
            if (state.cursor) {
                since = new Date(Date.parse(state.cursor) - CURSOR_OVERLAP_MS).toISOString();
                if (cfg.dateFromGiven) log.info('"dateFrom" is only used on the first run of a monitor; this run continues where the previous one stopped.');
            }
            if (cfg.dateTo) log.warning('"dateTo" is ignored in monitor mode.');
            publishedFrom = cfg.onlyNewlyPublished ? state.baselineFrom : null;
            log.info(`Monitor "${cfg.monitorName}": ${isBaseline ? 'first run (baseline)' : `${n(Object.keys(state.seen).length)} tenders remembered`}, checking MTender updates since ${since}.`);
        } else {
            log.info(`Searching MTender (${cfg.feed}) for tenders updated from ${since}${cfg.dateTo ? ` to ${cfg.dateTo}` : ''}…`);
        }

        const matcher = buildMatcher({ ...cfg.filters, publishedFrom, publishedTo: isMonitor ? null : (cfg.onlyNewlyPublished ? cfg.dateTo : null) });
        const alertMode = isMonitor && (!isBaseline || cfg.reportAllOnFirstRun);
        const eventName = isMonitor ? EVENT_ALERT : EVENT_RESULT;
        const outputLimit = isMonitor && !alertMode ? 0 : cfg.maxResults; // 0 = no limit
        const visited = new Set();
        const previewTenders = [];
        const webhookTenders = [];
        let stoppedAtMaxScan = false;
        let stoppedAtMaxResults = false;
        let newCursor = state?.cursor ?? null;
        let cursorSafe = true; // false when the page was not fully processed

        /** Handles the matches of one batch; returns false when the run must stop. */
        const handle = async (results) => {
            const matches = [];
            for (const r of results) {
                stats.tendersScanned++;
                if (r.error) {
                    stats.fetchErrors++;
                    if (isMonitor) state.pending[r.ocid] = (state.pending[r.ocid] ?? 0) + 1;
                    log.debug(`Skipped ${r.ocid}: ${r.error}`);
                    continue;
                }
                if (isMonitor) delete state.pending[r.ocid];
                if (r.notFound) {
                    stats.notFound++;
                    continue;
                }
                const m = matcher(r.tender);
                if (!m.ok) continue;
                stats.matched++;
                if (isMonitor) {
                    if (state.seen[r.ocid]) continue;
                    if (!alertMode) {
                        state.seen[r.ocid] = startedAt;
                        continue;
                    }
                    matches.push(finish(r.tender, { matchedKeywords: m.matchedKeywords, monitorName: cfg.monitorName, isNew: true, detectedAt: startedAt }));
                } else {
                    matches.push(finish(r.tender, { matchedKeywords: m.matchedKeywords }));
                }
            }
            let toEmit = matches;
            if (outputLimit && stats.pushed + toEmit.length >= outputLimit) {
                toEmit = toEmit.slice(0, outputLimit - stats.pushed);
                stoppedAtMaxResults = true;
            }
            const stored = await emit(toEmit, eventName);
            for (const t of toEmit.slice(0, stored)) {
                if (isMonitor) state.seen[t.ocid] = startedAt;
                if (previewTenders.length < cfg.notifyMaxItems) previewTenders.push(t);
                if (webhookTenders.length < cfg.webhookMaxItems) webhookTenders.push(t);
            }
            if (limitReached || stoppedAtMaxResults) {
                // Not everything from this batch was output: process it again next time.
                if (stored < matches.length) cursorSafe = false;
                return false;
            }
            return true;
        };

        // 1) Monitor: retry tenders whose details failed last time.
        const pendingIds = isMonitor ? Object.keys(state.pending).slice(0, 500) : [];
        if (pendingIds.length) {
            log.info(`Retrying ${pendingIds.length} tender(s) that could not be loaded in the previous run.`);
            for (const id of pendingIds) visited.add(id);
            const results = await fetchTenders(pendingIds);
            await handle(results);
            for (const [id, attempts] of Object.entries(state.pending)) {
                if (attempts >= MAX_PENDING_ATTEMPTS) {
                    log.warning(`Giving up on tender ${id} after ${attempts} failed attempts.`);
                    delete state.pending[id];
                }
            }
        }

        // 2) Walk the feed.
        if (!limitReached && !stoppedAtMaxResults) {
            outer:
            for await (const page of client.feed({ feed: cfg.feed, since, until: isMonitor ? null : cfg.dateTo })) {
                stats.pagesRead++;
                let entries = page.entries.filter((e) => !visited.has(e.ocid));
                for (const e of entries) visited.add(e.ocid);
                let pageComplete = true;
                const room = cfg.maxScan - stats.tendersScanned;
                if (entries.length > room) {
                    entries = entries.slice(0, Math.max(0, room));
                    pageComplete = false;
                    stoppedAtMaxScan = true;
                }
                // Process in chunks so a spending limit stops quickly.
                for (let i = 0; i < entries.length; i += 25) {
                    const ok = await handle(await fetchTenders(entries.slice(i, i + 25).map((e) => e.ocid)));
                    if (!ok) {
                        pageComplete = pageComplete && cursorSafe && i + 25 >= entries.length;
                        newCursor = pageComplete ? page.nextOffset ?? newCursor : page.offset;
                        break outer;
                    }
                }
                newCursor = pageComplete ? page.nextOffset ?? newCursor : page.offset;
                if (stoppedAtMaxScan) break;
                if (stats.pagesRead % 5 === 0) log.info(`Checked ${n(stats.tendersScanned)} tenders, ${n(stats.matched)} match so far…`);
            }
        }
        if (!newCursor && isMonitor) newCursor = since; // empty feed: keep the starting point

        if (stoppedAtMaxScan) {
            log.warning(`Stopped after checking ${n(cfg.maxScan)} tenders (maxScan). ${isMonitor
                ? 'The next run continues from here.' : 'Narrow the date range or raise "maxScan" to check more.'}`);
        }
        if (stoppedAtMaxResults) log.info(`Reached maxResults = ${n(cfg.maxResults)}.${isMonitor ? ' Remaining new tenders are reported on the next run.' : ''}`);
        if (limitReached) log.warning(`Stopped after ${n(stats.pushed)} results: the run reached the maximum cost per run you set.${isMonitor ? ' The remaining new tenders will be reported on the next run.' : ''}`);
        if (stats.fetchErrors) log.warning(`${n(stats.fetchErrors)} tender(s) could not be loaded from MTender after retries${isMonitor ? ' and will be retried on the next run' : ''}.`);
        if (stats.tendersScanned === 0 && stats.pagesRead === 0) log.info('MTender returned no tenders for this period.');
        if (stats.tendersScanned > 0 && stats.fetchErrors === stats.tendersScanned) {
            throw new Error(`None of the ${n(stats.tendersScanned)} tenders could be loaded from ${cfg.apiBaseUrl}. MTender may be down; try again later.`);
        }

        let notifications = {};
        if (isMonitor) {
            state.cursor = newCursor;
            if (isBaseline && !stoppedAtMaxScan && !stoppedAtMaxResults && !limitReached) state.baselineComplete = true;
            state.runs = (state.runs ?? 0) + 1;
            state.lastRunAt = startedAt;
            const saved = await store.save(state);
            log.info(`Monitor state saved (${n(Object.keys(saved.seen).length)} tenders remembered, next check from ${saved.cursor}).`);
            const summary = { newTenders: alertMode ? stats.pushed : 0, tendersScanned: stats.tendersScanned, matched: stats.matched };
            if (alertMode && (stats.pushed > 0 || cfg.notifyOnNoChanges)) {
                notifications = await sendNotifications(input, { monitorName: cfg.monitorName, summary, previewTenders, webhookTenders, resultsUrl, costLimitReached: limitReached });
            }
        } else if (hasNotificationTargets(input)) {
            log.warning('Notifications are only sent in monitor mode. Set "monitorName" to get alerts about new tenders.');
        }

        output = {
            mode: cfg.mode,
            monitorName: cfg.monitorName || undefined,
            isBaseline: isMonitor ? isBaseline : undefined,
            ...stats,
            newTenders: isMonitor ? (alertMode ? stats.pushed : 0) : undefined,
            checkedFrom: since,
            checkedTo: isMonitor ? null : cfg.dateTo,
            nextCursor: isMonitor ? newCursor : undefined,
            stoppedAtMaxScan,
            stoppedAtMaxResults,
            notifications: isMonitor ? notifications : undefined,
        };
    }

    output = {
        ...output,
        stoppedAtCostLimit: limitReached,
        apiRequests: client.stats.requests,
        apiRetries: client.stats.retries,
        resultsUrl,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);

    let status;
    if (output.mode === 'details') status = `${n(stats.pushed)} tender(s) loaded${stats.notFound ? `, ${stats.notFound} not found` : ''}${stats.fetchErrors ? `, ${stats.fetchErrors} failed` : ''}.`;
    else if (output.mode === 'monitor' && output.isBaseline && !cfg.reportAllOnFirstRun) status = `Baseline saved: ${n(stats.matched)} matching tenders remembered (${n(stats.tendersScanned)} checked). New tenders will be reported from the next run.`;
    else if (output.mode === 'monitor') status = `${n(stats.pushed)} new tender(s) (${n(stats.tendersScanned)} checked).`;
    else status = `${n(stats.pushed)} matching tender(s) (${n(stats.tendersScanned)} checked).`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';
    log.info(status);
    await Actor.exit({ statusMessage: status });
} catch (err) {
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
