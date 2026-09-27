import crypto from 'node:crypto';
import { Actor, log } from 'apify';
import { AcaClient, AcaError } from './aca.js';
import { parseInput, dateWindows, InputError } from './input.js';
import { normalizeRecord, buildMatcher } from './normalize.js';
import { MonitorState } from './state.js';
import { sendNotifications, hasNotificationTargets } from './notify.js';

const EV_PERMIT = 'permit';
const EV_DETAILS = 'permit-details';

const n = (x) => Number(x).toLocaleString('en-US');
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('base64url').slice(0, 16);

await Actor.init();

try {
    const input = (await Actor.getInput()) ?? {};
    const cfg = parseInput(input, { hostOverride: process.env.ACCELA_BASE_URL || null });
    const startedAt = new Date().toISOString();
    const datasetId = process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID;
    const resultsUrl = Actor.isAtHome() && datasetId ? `https://console.apify.com/storage/datasets/${datasetId}` : null;
    const isMonitor = !!cfg.monitorName;

    // ── Proxy ────────────────────────────────────────────────────────────────────────────────────
    let proxyConfiguration = null;
    const pc = cfg.proxyConfiguration;
    const apifyProxyUsable = Actor.isAtHome() || !!(process.env.APIFY_PROXY_PASSWORD || process.env.APIFY_TOKEN);
    if (pc?.useApifyProxy && !pc.proxyUrls?.length && !apifyProxyUsable) {
        log.warning('Apify Proxy is not available outside the Apify platform without APIFY_PROXY_PASSWORD/APIFY_TOKEN; running without proxy.');
    } else if (pc && (pc.useApifyProxy || pc.proxyUrls?.length)) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(pc);
        } catch (err) {
            if (Actor.isAtHome()) throw err;
            log.warning(`Proxy is not available outside the Apify platform (${err.message}); continuing without proxy.`);
        }
    }
    const proxyDesc = proxyConfiguration ? (pc.proxyUrls?.length ? 'own proxy URLs' : `Apify Proxy${pc.apifyProxyGroups?.length ? ` (${pc.apifyProxyGroups.join(', ')})` : ' (automatic)'}${pc.apifyProxyCountry ? `, country ${pc.apifyProxyCountry}` : ''}`) : 'no proxy';

    // ── Charging ─────────────────────────────────────────────────────────────────────────────────
    const cm = Actor.getChargingManager();
    const isPpe = cm.getPricingInfo().isPayPerEvent;
    let limitReached = false;
    const priceOf = (ev) => (typeof cm.calculateEventPrice === 'function' ? cm.calculateEventPrice(ev) : null);
    /** How many of `count` records the remaining budget pays for (permit event, plus details event if wanted). */
    const affordable = (count, withDetails) => {
        if (!isPpe) return count;
        const maxP = cm.calculateMaxEventChargeCountWithinLimit(EV_PERMIT);
        if (!withDetails) return Math.min(count, maxP);
        const pP = priceOf(EV_PERMIT);
        const pD = priceOf(EV_DETAILS);
        if (pP === null || pD === null) return Math.min(count, Math.floor(Math.min(maxP, cm.calculateMaxEventChargeCountWithinLimit(EV_DETAILS)) / 2));
        if (!pD) return Math.min(count, maxP);
        const remaining = cm.getMaxTotalChargeUsd() - cm.calculateTotalChargedAmount();
        return Math.min(count, Math.max(0, Math.floor(Number((remaining / ((pP || 0) + pD)).toFixed(4)))));
    };

    log.info(`Accela permits run: ${cfg.agencies.length} agenc${cfg.agencies.length === 1 ? 'y' : 'ies'} `
        + `(${cfg.agencies.map((a) => `${a.code}/${a.module}`).join(', ')}), records opened ${cfg.dateFrom} … ${cfg.dateTo}`
        + `${cfg.permitTypes.length ? `, permit types: ${cfg.permitTypes.join(', ')}` : ''}${cfg.statuses.length ? `, statuses: ${cfg.statuses.join(', ')}` : ''}${cfg.recordTypes.length ? `, portal record types: ${cfg.recordTypes.join(', ')}` : ''}`
        + `, details: ${cfg.includeDetails ? 'yes' : 'no'}, ${proxyDesc}${isPpe ? `, pay-per-event (max ${cm.getMaxTotalChargeUsd() === Infinity ? 'unlimited' : `$${cm.getMaxTotalChargeUsd()}`})` : ''}${isMonitor ? `, monitor "${cfg.monitorName}"` : ''}.`);

    // ── Monitor state ────────────────────────────────────────────────────────────────────────────
    let store = null;
    let state = null;
    const fingerprint = hash({ p: cfg.permitTypes, x: cfg.excludeKeywords, r: cfg.recordTypes, s: cfg.statuses });
    if (isMonitor) {
        store = await new MonitorState(cfg.stateStoreName, cfg.monitorName).open();
        state = await store.load();
        if (state && cfg.resetState) {
            log.info('"Start over" is enabled: this monitor\'s memory is cleared and this run creates a new baseline.');
            await store.reset();
            state = null;
        }
        state ??= { monitorName: cfg.monitorName, settingsFingerprint: fingerprint, agencies: {}, seen: {}, createdAt: startedAt, runs: 0 };
        state.agencies ??= {};
        state.seen ??= {};
        if (state.settingsFingerprint !== fingerprint) {
            log.warning('The permit filters differ from the previous run of this monitor. Every agency gets a new baseline: current matches are '
                + 'remembered but not reported, so you are not flooded with old permits.');
            for (const a of Object.values(state.agencies)) a.baselineDone = false;
            state.settingsFingerprint = fingerprint;
        }
    } else if (hasNotificationTargets(input)) {
        log.warning('Notifications are only sent in monitor mode. Set "monitorName" to get alerts about new permits.');
    }

    const saveDebug = cfg.saveDebugPages ? (key, content, contentType) => Actor.setValue(key, content, { contentType }) : null;
    const matcher = buildMatcher({ permitTypes: cfg.permitTypes, excludeKeywords: cfg.excludeKeywords, statuses: cfg.statuses });
    const agencyStats = [];
    const previewPermits = [];
    const webhookPermits = [];
    let totalPushed = 0;
    let totalDetails = 0;
    let totalChecked = 0;

    for (const agency of cfg.agencies) {
        if (limitReached) {
            agencyStats.push({ agency: agency.code, module: agency.module, status: 'skipped', error: 'maximum cost per run reached' });
            continue;
        }
        const aKey = `${agency.code}|${agency.module}`.toUpperCase();
        const aState = isMonitor ? (state.agencies[aKey] ??= { baselineDone: false, runs: 0 }) : null;
        const isBaseline = isMonitor && !aState.baselineDone;
        const reportNew = !isMonitor || !isBaseline || cfg.reportAllOnFirstRun;
        const portalUrl = `${agency.baseUrl}/Cap/CapHome.aspx?module=${encodeURIComponent(agency.module)}&TabName=${encodeURIComponent(agency.module)}`;
        const st = { agency: agency.code, agencyName: agency.name, module: agency.module, evidence: agency.evidence, status: 'ok', windows: 0, rowsRead: 0, matched: 0, output: 0, details: 0, detailErrors: 0, baseline: isBaseline || undefined };
        const windows = dateWindows(cfg.dateFrom, cfg.dateTo, cfg.searchWindowDays);
        log.info(`[${agency.code}] ${agency.name ? `${agency.name}${agency.state ? `, ${agency.state}` : ''} — ` : ''}module ${agency.module}, ${windows.length} search window(s) of up to ${cfg.searchWindowDays} day(s)`
            + `${isMonitor ? (isBaseline ? `, monitor baseline${cfg.reportAllOnFirstRun ? ' (reported)' : ' (remembered, not reported)'}` : `, monitor: ${n(Object.keys(state.seen).filter((k) => k.startsWith(`${agency.code}|`)).length)} permits remembered`) : ''}`
            + ` [portal ${agency.evidence === 'search-page' || agency.evidence === 'code' ? 'known' : agency.evidence === 'portal-only' ? 'known, search page unconfirmed' : 'user-supplied'}].`);

        const client = new AcaClient({
            agency, module: agency.module, proxyConfiguration, browserFallback: cfg.browserFallback, forceBrowser: cfg.forceBrowser,
            requestDelayMs: cfg.requestDelayMs, maxRetries: cfg.maxRetries, backoffMs: Number(process.env.ACCELA_BACKOFF_MS) || 1500, saveDebug,
        });
        const seenInRun = new Set();
        let agencyDone = false; // output limit reached
        let agencyComplete = true; // every window fully read

        const wantCsv = cfg.exportMode === 'csv' ? !cfg.includeDetails
            : cfg.exportMode === 'auto' && !cfg.includeDetails && !isMonitor && (cfg.maxRecordsPerAgency === 0 || cfg.maxRecordsPerAgency > 100);
        if (cfg.exportMode === 'csv' && cfg.includeDetails) log.info(`[${agency.code}] CSV export has no record links, so with "includeDetails" the grid is read instead.`);

        /** Details (optional), charging and output for records that passed the filters. */
        const emit = async (recs) => {
            let batch = recs;
            if (reportNew && cfg.maxRecordsPerAgency && st.output + batch.length >= cfg.maxRecordsPerAgency) {
                batch = batch.slice(0, cfg.maxRecordsPerAgency - st.output);
                agencyDone = true;
            }
            if (!reportNew) {
                for (const r of batch) state.seen[`${agency.code}|${r.recordNumber}`] = startedAt;
                return;
            }
            const k = affordable(batch.length, cfg.includeDetails);
            if (k < batch.length) {
                batch = batch.slice(0, k);
                limitReached = true;
            }
            if (!batch.length) return;
            if (cfg.includeDetails) {
                for (let i = 0; i < batch.length; i++) {
                    const r = batch[i];
                    if (r._detail || !r.detailUrl) continue;
                    try {
                        const d = await client.fetchDetail(r.detailUrl);
                        batch[i] = { ...normalizeRecord({ row: r._row, detail: d, agency, module: agency.module, includePersonalNames: cfg.includePersonalNames, portalUrl, source: r.source }), _row: r._row, matchedKeywords: r.matchedKeywords };
                        st.details++;
                    } catch (err) {
                        st.detailErrors++;
                        log.warning(`[${agency.code}] Details of ${r.recordNumber} could not be loaded (${err.message}); the permit is saved without them and details are not charged.`);
                        if (err instanceof AcaError && err.kind === 'blocked') throw err;
                    }
                }
            }
            const out = batch.map(({ _row, _detail, ...rest }) => ({ ...rest, ...(isMonitor ? { monitorName: cfg.monitorName, isNew: true, detectedAt: startedAt } : {}), scrapedAt: startedAt }));
            let final = out;
            if (isPpe) {
                const c = await Actor.charge({ eventName: EV_PERMIT, count: out.length });
                if (c.chargedCount < out.length) {
                    final = out.slice(0, c.chargedCount);
                    limitReached = true;
                }
                const withDetails = final.filter((r) => r.detailsFetched && cfg.includeDetails).length;
                if (withDetails) await Actor.charge({ eventName: EV_DETAILS, count: withDetails });
                if (cm.calculateMaxEventChargeCountWithinLimit(EV_PERMIT) < 1) limitReached = true;
            }
            if (!final.length) return;
            await Actor.pushData(final);
            st.output += final.length;
            totalPushed += final.length;
            totalDetails += final.filter((r) => r.detailsFetched && cfg.includeDetails).length;
            for (const r of final) {
                if (isMonitor) state.seen[`${agency.code}|${r.recordNumber}`] = startedAt;
                if (previewPermits.length < cfg.notifyMaxItems) previewPermits.push(r);
                if (webhookPermits.length < cfg.webhookMaxItems) webhookPermits.push(r);
            }
        };

        const onPage = async ({ rows, pageNo, countText, source }) => {
            const fresh = [];
            for (const row of rows) {
                st.rowsRead++;
                totalChecked++;
                const detail = row.detail && cfg.includeDetails ? row.detail : null;
                const rec = normalizeRecord({ row, detail, agency, module: agency.module, includePersonalNames: cfg.includePersonalNames, portalUrl, source });
                if (!rec.recordNumber || seenInRun.has(rec.recordNumber)) continue;
                seenInRun.add(rec.recordNumber);
                const m = matcher(rec);
                if (!m.ok) continue;
                st.matched++;
                if (isMonitor && state.seen[`${agency.code}|${rec.recordNumber}`]) continue;
                fresh.push({ ...rec, ...(cfg.permitTypes.length ? { matchedKeywords: m.matched } : {}), _row: row, _detail: !!detail });
            }
            if (pageNo === 1 || pageNo % 10 === 0) {
                log.info(`[${agency.code}] ${source === 'csv' ? 'CSV export' : `Page ${pageNo}`}: ${rows.length} rows${countText ? ` (${countText})` : ''}; so far ${n(st.rowsRead)} read, ${n(st.matched)} match, ${n(st.output)} saved.`);
            }
            if (fresh.length) await emit(fresh);
            return !(agencyDone || limitReached);
        };

        try {
            // Open the portal first so record types can be resolved against its dropdown.
            await client.withSession('open search page', async () => {});
            let typeOptions = [null];
            if (cfg.recordTypes.length) {
                const opts = client.form.recordTypes;
                const chosen = opts.filter((o) => cfg.recordTypes.some((t) => o.text.toLowerCase().includes(t.toLowerCase()) || o.value.toLowerCase() === t.toLowerCase()));
                if (chosen.length) {
                    typeOptions = chosen;
                    log.info(`[${agency.code}] Searching ${chosen.length} portal record type(s): ${chosen.slice(0, 10).map((o) => o.text).join('; ')}${chosen.length > 10 ? '…' : ''}`);
                } else {
                    log.warning(`[${agency.code}] None of the record types ${cfg.recordTypes.map((t) => `"${t}"`).join(', ')} is in this portal's dropdown`
                        + `${opts.length ? ` (available: ${opts.slice(0, 25).map((o) => o.text).join('; ')}${opts.length > 25 ? '…' : ''})` : ' (the portal has no record-type dropdown)'}. Searching all record types instead.`);
                }
            }
            outer:
            for (const w of windows) {
                for (const t of typeOptions) {
                    st.windows++;
                    const r = await client.searchWindow({ from: w.from, to: w.to, recordType: t, maxPages: cfg.maxPagesPerAgency, exportMode: cfg.exportMode, wantCsv, onPage });
                    if (r.rows === 0) log.info(`[${agency.code}] ${w.from} … ${w.to}${t ? ` [${t.text}]` : ''}: no records.`);
                    if (agencyDone || limitReached) {
                        agencyComplete = false;
                        break outer;
                    }
                }
            }
        } catch (err) {
            agencyComplete = false;
            st.status = 'failed';
            st.error = err.message;
            log.error(`[${agency.code}] FAILED: ${err.message}`);
        } finally {
            Object.assign(st, { strategy: client.stats.strategy, requests: client.stats.requests, retries: client.stats.retries, blocks: client.stats.blocks, sessions: client.stats.sessions, resultPages: client.stats.pages, csvExports: client.stats.csvExports, csvFailures: client.stats.csvFailures });
            await client.close();
        }
        if (isMonitor) {
            aState.runs = (aState.runs ?? 0) + 1;
            aState.lastRunAt = startedAt;
            if (isBaseline && agencyComplete && st.status === 'ok') aState.baselineDone = true;
            if (isBaseline && !cfg.reportAllOnFirstRun && st.status === 'ok') log.info(`[${agency.code}] Baseline: ${n(st.matched)} matching permits remembered; new ones are reported from the next run.`);
        }
        if (st.status === 'ok') {
            log.info(`[${agency.code}] Done: ${n(st.rowsRead)} records read, ${n(st.matched)} match the filters, ${n(st.output)} saved${cfg.includeDetails ? ` (${n(st.details)} with details${st.detailErrors ? `, ${st.detailErrors} detail pages failed` : ''})` : ''}; `
                + `${st.requests} requests, ${st.resultPages} result pages${st.csvExports ? `, ${st.csvExports} CSV export(s)` : ''}, via ${st.strategy}${st.blocks ? `, ${st.blocks} block(s)` : ''}.`);
            if (st.rowsRead === 0) log.warning(`[${agency.code}] The portal returned no records opened between ${cfg.dateFrom} and ${cfg.dateTo}. Try a longer period ("lastNDays") or check the module.`);
        }
        agencyStats.push(st);
    }

    // ── Wrap up ──────────────────────────────────────────────────────────────────────────────────
    const failed = agencyStats.filter((s) => s.status === 'failed');
    let notifications;
    if (isMonitor) {
        state.runs = (state.runs ?? 0) + 1;
        state.lastRunAt = startedAt;
        const saved = await store.save(state);
        log.info(`Monitor state saved (${n(Object.keys(saved.seen).length)} permits remembered).`);
        const anyReported = agencyStats.some((s) => !s.baseline || cfg.reportAllOnFirstRun);
        const summary = { newPermits: totalPushed, checked: totalChecked, agencies: cfg.agencies.map((a) => a.code), failedAgencies: failed.map((s) => s.agency) };
        if (anyReported && (totalPushed > 0 || cfg.notifyOnNoChanges || failed.length)) {
            notifications = await sendNotifications(input, { monitorName: cfg.monitorName, summary, previewPermits, webhookPermits: webhookPermits.map(({ moreDetails, ...r }) => r), resultsUrl, costLimitReached: limitReached });
        }
    }

    const output = {
        mode: isMonitor ? 'monitor' : 'search',
        monitorName: cfg.monitorName || undefined,
        dateFrom: cfg.dateFrom,
        dateTo: cfg.dateTo,
        permitsSaved: totalPushed,
        detailsFetched: totalDetails,
        recordsRead: totalChecked,
        agencies: agencyStats,
        stoppedAtCostLimit: limitReached,
        notifications,
        resultsUrl,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);

    if (failed.length === agencyStats.length && failed.length) {
        throw new AcaError(failed.length === 1 ? `${failed[0].agency}: ${failed[0].error}` : `All ${failed.length} agencies failed. ${failed.map((s) => `${s.agency}: ${s.error}`).join(' | ')}`);
    }
    const baselineOnly = isMonitor && agencyStats.every((s) => s.baseline) && !cfg.reportAllOnFirstRun;
    let status = baselineOnly
        ? `Baseline saved: ${n(agencyStats.reduce((a, s) => a + (s.matched ?? 0), 0))} matching permits remembered. New permits are reported from the next run.`
        : `${n(totalPushed)} ${isMonitor ? 'new ' : ''}permit(s) saved from ${agencyStats.filter((s) => s.status === 'ok').length} agenc${agencyStats.length === 1 ? 'y' : 'ies'} (${n(totalChecked)} records read).`;
    if (failed.length) status += ` Failed: ${failed.map((s) => s.agency).join(', ')} (see log).`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';
    log.info(status);
    await Actor.exit({ statusMessage: status });
} catch (err) {
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
