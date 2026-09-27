import { Actor, log } from 'apify';
import { ProzorroClient, ApiError, isProcedureId } from './api.js';
import { parseInput } from './input.js';
import { buildFilter, normalizeProcedure } from './normalize.js';
import { crawlChangeFeed, crawlByType, expandSellingMethods } from './crawl.js';
import { MonitorState } from './state.js';
import { sendNotifications } from './notify.js';

const EVENT_RESULT = 'auction-result'; // one auction returned by search / details
const EVENT_ALERT = 'new-auction-alert'; // one new auction found by a monitor (output + notifications)
const EVENT_PAGE = 'feed-page'; // optional: one change-feed page (up to 100 auctions) scanned
const PUSH_BATCH = 100;
const MONITOR_OVERLAP_MS = 5 * 60_000; // re-read 5 min before the cursor: late-indexed records are not missed
const idOf = (p) => p?._id ?? p?.id ?? p?.auctionId ?? null;
const n = (x) => Number(x).toLocaleString('en-US');

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const cfg = parseInput(input);
    const client = new ProzorroClient({ baseUrl: cfg.apiBaseUrl, minIntervalMs: cfg.requestIntervalMs });
    const pricing = Actor.getChargingManager().getPricingInfo();
    const isPpe = pricing.isPayPerEvent;
    const chargesPages = isPpe && pricing.perEventPrices?.[EVENT_PAGE] !== undefined;
    let limitReached = false;

    /** Charges `count` events; returns how many may be delivered (all of them when not pay-per-event). */
    const charge = async (eventName, count) => {
        if (!count || limitReached) return 0;
        if (!isPpe) return count;
        // Charge only what fits in the budget: asking for more makes the SDK overcharge by one event so the
        // platform aborts the run, and a monitor could then not save which auctions it already delivered.
        const cm = Actor.getChargingManager();
        const fits = typeof cm.calculateMaxEventChargeCountWithinLimit === 'function' ? cm.calculateMaxEventChargeCountWithinLimit(eventName) : count;
        const want = Math.min(count, fits);
        if (want < count) limitReached = true;
        if (want <= 0) return 0;
        const res = await Actor.charge({ eventName, count: want });
        if (res.chargedCount < want) limitReached = true;
        return Math.min(res.chargedCount, want);
    };
    const onScannedPage = async () => (chargesPages ? (await charge(EVENT_PAGE, 1)) === 1 : !limitReached);

    if (cfg.unknownStatuses.length) log.warning(`Unknown status value(s): ${cfg.unknownStatuses.join(', ')}. They are used as given.`);
    const hasNotifier = ['telegramBotToken', 'slackWebhookUrl', 'webhookUrl', 'emailTo'].some((k) => String(input[k] ?? '').trim());
    if (hasNotifier && (cfg.mode !== 'search' || !cfg.monitorName)) {
        log.warning('Notifications are only sent in monitor mode. Set "monitorName" to get alerts about new auctions.');
    }
    log.info(`Prozorro.Sale API: ${client.baseUrl}. Mode: ${cfg.mode}${cfg.monitorName ? ` (monitor "${cfg.monitorName}")` : ''}.`);

    const normOpts = { includeItems: cfg.includeItems, includeDocuments: cfg.includeDocuments, includeRaw: cfg.includeRaw };
    const scrapedAt = new Date().toISOString();
    const datasetId = process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID;
    const resultsUrl = Actor.isAtHome() && datasetId ? `https://console.apify.com/storage/datasets/${datasetId}` : null;

    /** Charges and pushes records in batches; stops cleanly at the spending limit. Returns how many were pushed. */
    const deliver = async (records, eventName) => {
        let pushed = 0;
        for (let i = 0; i < records.length && !limitReached; i += PUSH_BATCH) {
            const batch = records.slice(i, i + PUSH_BATCH);
            const allowed = await charge(eventName, batch.length);
            if (allowed) await Actor.pushData(batch.slice(0, allowed));
            pushed += allowed;
        }
        return pushed;
    };

    let output;
    let status;

    if (cfg.mode === 'types') {
        // ---------- Reference list of procedure types (free) ----------
        const [names, prefixes] = await Promise.all([client.legalNames(), client.auctionPrefixes().catch(() => ({}))]);
        if (!Array.isArray(names)) throw new Error('Unexpected response from /api/legal_names (expected a list).');
        const rows = names.map((sm) => {
            const [procedureType, auctionType] = sm.split(/-(.*)/s);
            return { sellingMethod: sm, procedureType, auctionType: auctionType || null, auctionIdPrefix: prefixes?.[sm] ?? null };
        }).sort((a, b) => a.sellingMethod.localeCompare(b.sellingMethod));
        await Actor.pushData(rows);
        output = { mode: 'types', count: rows.length };
        status = `${rows.length} selling methods listed.`;
    } else if (cfg.mode === 'details') {
        // ---------- Details for given auction IDs ----------
        const notFound = [];
        const failed = [];
        let delivered = 0;
        for (const id of cfg.auctionIds) {
            if (limitReached) break;
            let p;
            try {
                p = isProcedureId(id) ? await client.procedure(id) : await client.byAuctionId(id.toUpperCase());
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) {
                    notFound.push(id);
                    log.warning(`Auction "${id}" was not found.`);
                } else {
                    failed.push({ id, error: err.message });
                    log.warning(`Could not load auction "${id}": ${err.message}`);
                }
                continue;
            }
            if (!p || typeof p !== 'object' || !idOf(p)) {
                notFound.push(id);
                log.warning(`Auction "${id}" was not found.`);
                continue;
            }
            delivered += await deliver([{ ...normalizeProcedure(p, normOpts), requestedId: id, scrapedAt }], EVENT_RESULT);
        }
        if (failed.length && !delivered && !notFound.length) {
            throw new Error(`Could not load any auction from ${client.baseUrl}: ${failed[0].error}`);
        }
        output = { mode: 'details', requested: cfg.auctionIds.length, returned: delivered, notFound, failed, stoppedAtCostLimit: limitReached };
        status = `${delivered} of ${cfg.auctionIds.length} auctions returned${notFound.length ? `, ${notFound.length} not found` : ''}${failed.length ? `, ${failed.length} failed` : ''}.`;
    } else {
        // ---------- Search (and monitor) ----------
        const predicate = buildFilter(cfg.filters);
        const monitor = !!cfg.monitorName;
        let store = null;
        let state = null;
        if (monitor) {
            store = await new MonitorState(cfg.storeName, cfg.monitorName, cfg.instance).open();
            if (cfg.resetState) {
                log.info('"Start over" is enabled: this monitor\'s memory is cleared.');
                await store.reset();
            } else {
                state = await store.load();
            }
        }
        const firstRun = monitor && !state;

        let strategy = cfg.scanMode;
        const hasWindow = !!(cfg.changedSince || cfg.filters.publishedFrom);
        if (monitor) {
            if (strategy === 'latestByType') log.warning('Monitors always read the change feed (so no auction is missed between runs); "scanMode" is ignored.');
            strategy = 'changeFeed';
        } else if (strategy === 'auto') {
            strategy = cfg.filters.sellingMethods.length && !hasWindow ? 'latestByType' : 'changeFeed';
        }

        const matches = new Map();
        const cap = monitor ? 0 : cfg.maxResults;
        const onPage = async (records) => {
            if (!(await onScannedPage())) return false;
            for (const p of records) {
                const id = idOf(p);
                if (!id) continue;
                if (predicate(p)) matches.set(id, p);
                else matches.delete(id); // a newer revision no longer matches
            }
            return !(cap && matches.size >= cap);
        };

        let scan;
        let since = null;
        if (strategy === 'latestByType') {
            const methods = await expandSellingMethods(client, cfg.filters.sellingMethods);
            log.info(`Reading the latest auctions of ${methods.length} selling method(s): ${methods.join(', ')}.`);
            scan = await crawlByType(client, { sellingMethods: methods, onPage });
        } else {
            since = state?.cursor
                ? new Date(Date.parse(state.cursor) - MONITOR_OVERLAP_MS).toISOString()
                : cfg.changedSince ?? cfg.filters.publishedFrom ?? new Date(Date.now() - cfg.lookbackHours * 3_600_000).toISOString();
            log.info(`Reading all auctions changed since ${since} (up to ${n(cfg.maxPages)} pages of 100)…`);
            scan = await crawlChangeFeed(client, { since, maxPages: cfg.maxPages, onPage });
        }
        scan.note = scanNote(scan, limitReached);
        if (scan.truncationReason === 'maxPages') log.warning(scan.note);
        log.info(`Scanned ${n(scan.recordsScanned)} auctions in ${scan.pages} request(s); ${n(matches.size)} match the filters.`);

        const byNewest = (a, b) => (Date.parse(b.dateModified) || 0) - (Date.parse(a.dateModified) || 0);

        if (!monitor) {
            let found = [...matches.values()].sort(byNewest);
            if (cfg.maxResults && found.length > cfg.maxResults) found = found.slice(0, cfg.maxResults);
            const records = found.map((p) => ({ ...normalizeProcedure(p, normOpts), scrapedAt }));
            const delivered = await deliver(records, EVENT_RESULT);
            output = { mode: 'search', matched: matches.size, returned: delivered, stoppedAtCostLimit: limitReached, scan, filters: cfg.filters };
            status = `${n(delivered)} auctions returned (${n(scan.recordsScanned)} scanned${scan.truncated ? ', partial scan — see OUTPUT' : ''}).`;
        } else {
            const baselineFrom = state?.baselineFrom ?? since;
            const seen = state?.seenMap ?? new Map();
            const report = !firstRun || cfg.reportAllOnFirstRun;
            const candidates = [...matches.values()]
                .filter((p) => !seen.has(idOf(p)))
                .filter((p) => cfg.alertOn === 'newlyMatching' || firstRun || (Date.parse(p.datePublished) || 0) >= Date.parse(baselineFrom))
                .sort((a, b) => (Date.parse(a.datePublished) || 0) - (Date.parse(b.datePublished) || 0));

            let delivered = [];
            if (report && candidates.length) {
                const records = candidates.map((p) => ({ ...normalizeProcedure(p, normOpts), isNew: true, monitorName: cfg.monitorName, detectedAt: scrapedAt }));
                const count = await deliver(records, EVENT_ALERT);
                delivered = records.slice(0, count);
            }
            const remembered = report ? delivered.map((r) => r.procedureId ?? r.auctionId) : candidates.map(idOf);
            for (const id of remembered) if (id) seen.set(id, scrapedAt);

            // Advance the cursor only when every page read was fully processed and paid for.
            const cursor = limitReached ? state?.cursor ?? null : scan.nextCursor ?? state?.cursor ?? null;
            const savedIds = await store.save({
                monitorName: cfg.monitorName,
                instance: cfg.instance,
                baselineFrom,
                cursor,
                runs: (state?.runs ?? 0) + 1,
                filters: cfg.filters,
                seenMap: seen,
            });

            let notifications = {};
            if (report && (delivered.length || cfg.notifyOnNoChanges)) {
                notifications = await sendNotifications(input, {
                    monitorName: cfg.monitorName,
                    newCount: delivered.length,
                    preview: delivered.slice(0, cfg.notifyMaxItems),
                    webhookItems: delivered.slice(0, cfg.webhookMaxItems).map(({ raw, ...r }) => r),
                    resultsUrl,
                    costLimitReached: limitReached,
                    scan,
                });
            }
            output = {
                mode: 'monitor',
                monitorName: cfg.monitorName,
                isBaseline: firstRun && !cfg.reportAllOnFirstRun,
                matched: matches.size,
                newAuctions: delivered.length,
                newNotDeliveredDueToCostLimit: report ? candidates.length - delivered.length : 0,
                alertOn: cfg.alertOn,
                baselineFrom,
                cursor,
                rememberedIds: savedIds,
                stateStore: cfg.storeName,
                stateKey: store.key,
                stoppedAtCostLimit: limitReached,
                notifications,
                scan,
            };
            status = firstRun && !cfg.reportAllOnFirstRun
                ? `Baseline saved: ${n(candidates.length)} matching auctions remembered. New auctions will be reported from the next run.`
                : `${n(delivered.length)} new auctions (${n(scan.recordsScanned)} scanned).`;
        }
    }

    if (limitReached) {
        log.warning('The run reached your maximum cost per run and stopped cleanly. Results collected so far are saved'
            + (cfg.monitorName ? '; auctions not delivered will be reported in the next run.' : '. Raise the limit to get everything.'));
        status += ' Stopped at the maximum cost per run.';
    }
    output = { ...output, api: client.baseUrl, requests: client.stats.requests, retries: client.stats.retries, resultsUrl, finishedAt: new Date().toISOString() };
    await Actor.setValue('OUTPUT', output);
    log.info(status);
    await Actor.exit({ statusMessage: status });
} catch (err) {
    const msg = err instanceof ApiError
        ? `Prozorro.Sale API request failed (${err.path}): ${err.message}. The service may be temporarily unavailable; try again later.`
        : err.message;
    log.error(msg);
    await Actor.fail(msg);
}

function scanNote(scan, limitReached) {
    if (scan.strategy === 'latestByType') {
        const base = `Read the ${scan.recordsScanned} most recently changed auctions of the selected selling method(s).`;
        return scan.methodsAtLimit.length
            ? `${base} ${scan.methodsAtLimit.join(', ')} hit the 100-per-type limit, so older auctions of those types were not checked. Set "publishedFrom" or "changedSince" to scan a full period.`
            : base;
    }
    const range = `${scan.scannedFrom} … ${scan.scannedTo ?? scan.scannedFrom}`;
    if (scan.reachedPresent) return `Checked every auction changed in ${range} (up to now).`;
    if (limitReached) return `Stopped at the maximum cost per run after checking auctions changed in ${range}.`;
    if (scan.truncationReason === 'stopped') return `Stopped at "maxResults" after checking auctions changed in ${range}; more matches may exist.`;
    return `PARTIAL: "maxPages" was reached after checking auctions changed in ${range}; later changes were not checked. Raise "maxPages" or narrow the period.`;
}
