import { Actor, log } from 'apify';
import { parseInput, InputError } from './input.js';
import { TrendsClient, BlockedError } from './trends.js';
import { DEFAULT_BASE_URL } from './request.js';
import { buildTermItem, flattenTermItem, buildTrendingItem, computeComparable } from './output.js';

const EVENT_TERM = 'term-result';
const EVENT_TRENDING = 'trending-item';

await Actor.init();

let client;
try {
    const input = (await Actor.getInput()) ?? {};
    const cfg = parseInput(input);
    const scrapedAt = new Date().toISOString();

    // ── Proxy ────────────────────────────────────────────────────────────────────────
    let proxyConfiguration = null;
    const isMock = cfg.baseUrl !== DEFAULT_BASE_URL;
    const isLocalTarget = /^https?:\/\/(localhost|127\.|\[::1\])/.test(cfg.baseUrl);
    const proxyInput = isLocalTarget ? null : (cfg.proxyConfiguration ?? { useApifyProxy: true });
    if (proxyInput && (proxyInput.useApifyProxy || proxyInput.proxyUrls?.length)) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } catch (err) {
            log.warning(`Proxy could not be set up (${err.message}). Continuing WITHOUT a proxy; Google Trends rate-limits single IPs quickly.`);
        }
    }
    const groupsSel = proxyInput?.apifyProxyGroups ?? [];
    let proxyDesc = 'none';
    if (proxyConfiguration) {
        proxyDesc = proxyInput.proxyUrls?.length ? `custom (${proxyInput.proxyUrls.length} URL(s))`
            : `Apify Proxy ${groupsSel.length ? groupsSel.join('+') : 'automatic (datacenter)'}${proxyInput.apifyProxyCountry ? ` country=${proxyInput.apifyProxyCountry}` : ''}`;
        if (groupsSel.includes('GOOGLE_SERP')) log.warning('The GOOGLE_SERP proxy group only serves Google Search pages, not trends.google.com. Use RESIDENTIAL or the default datacenter proxy.');
    }
    if (!proxyConfiguration && !isMock) log.warning('Running without a proxy. Google Trends answers "429 Too Many Requests" after a few requests from one IP.');

    const needs = [cfg.interestOverTime && 'interest over time', cfg.interestByRegion && `interest by region (${cfg.regionResolution || 'auto'})`,
        cfg.relatedQueries && 'related queries', cfg.relatedTopics && 'related topics'].filter(Boolean);
    if (cfg.searchTerms.length) {
        log.info(`${cfg.searchTerms.length} term(s) in ${cfg.groups.length} comparison group(s)${cfg.anchorTerm ? ` with anchor "${cfg.anchorTerm}"` : ''}; `
            + `geo=${cfg.geo || 'worldwide'} time="${cfg.time}" category=${cfg.category} (${cfg.categoryName}) property=${cfg.gprop || 'web'} hl=${cfg.language} tz=${cfg.tz}; `
            + `collecting: ${needs.join(', ')}; proxy=${proxyDesc}, browser=${cfg.useBrowser}${isMock ? `, baseUrl=${cfg.baseUrl}` : ''}.`);
        if (cfg.groups.length > 1 && !cfg.anchorTerm && cfg.comparisonMode === 'groups') {
            log.warning('More than 5 terms without an anchor: values are on a 0-100 scale per group and are NOT comparable between groups. Set "anchorTerm" to compare everything on one scale.');
        }
    }
    if (cfg.trendingNow) log.info(`Trending now: geo=${cfg.trendingGeo}, source=${cfg.trendingSource}${cfg.trendingSource === 'trendingPage' ? `, last ${cfg.trendingHours}h` : ''}, max ${cfg.maxTrendingItems} item(s).`);

    client = new TrendsClient(cfg, proxyConfiguration);
    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    const canAfford = (event) => (isPpe ? chargingManager.calculateMaxEventChargeCountWithinLimit(event) : Infinity);

    const stats = { termsRequested: cfg.searchTerms.length, termsOk: 0, termsPartial: 0, termsFailed: 0, termResultsCharged: 0, trendingItemsCharged: 0, trendingItemsPushed: 0, rowsPushed: 0 };
    const termSummaries = [];
    const groupSummaries = [];
    let limitReached = false;
    const charged = new Set();

    /** Charges the complete terms of a group (budget permitting) and pushes their items. Incomplete terms are free. */
    const emitTerms = async (items) => {
        const toCharge = items.filter((it) => it.status === 'ok' && !charged.has(it.term));
        let paid = toCharge.length;
        if (isPpe && paid) {
            const allowed = canAfford(EVENT_TERM);
            if (allowed < paid) {
                paid = Math.max(0, allowed);
                limitReached = true;
            }
            if (paid) {
                const r = await Actor.charge({ eventName: EVENT_TERM, count: paid });
                if (r.chargedCount < paid) {
                    paid = r.chargedCount;
                    limitReached = true;
                }
            }
        }
        const paidSet = new Set(toCharge.slice(0, paid).map((it) => it.term));
        const out = items.filter((it) => it.status !== 'ok' || paidSet.has(it.term));
        for (const it of out) if (paidSet.has(it.term)) charged.add(it.term);
        stats.termResultsCharged += paidSet.size;
        const rows = cfg.flattenTimeline ? out.flatMap(flattenTermItem) : out;
        if (rows.length) await Actor.pushData(rows);
        stats.rowsPushed += rows.length;
        return out;
    };

    // ── 1) Trending now: first, because it is one cheap request that works on almost any IP ──────
    let trending = null;
    if (cfg.trendingNow && !limitReached) {
        trending = { geo: cfg.trendingGeo, source: cfg.trendingSource, items: 0, error: null };
        try {
            let rows;
            let source = cfg.trendingSource;
            if (source === 'trendingPage') {
                try {
                    rows = await client.trendingPage(cfg.trendingGeo, cfg.trendingHours);
                    if (cfg.includeNews && rows.length) {
                        // The trending page rows carry no news; the RSS feed has news for the top searches.
                        try {
                            const rss = await client.trendingRss(cfg.trendingGeo);
                            const byTitle = new Map(rss.map((x) => [x.title?.toLowerCase(), x]));
                            for (const row of rows) {
                                const m = byTitle.get(row.title.toLowerCase());
                                if (m) Object.assign(row, { news: m.news, picture: m.picture, pictureSource: m.pictureSource });
                            }
                        } catch (err) {
                            if (!(err instanceof BlockedError)) throw err;
                            log.warning(`News from the RSS feed could not be loaded (${err.message}); trending items are stored without news.`);
                        }
                    }
                } catch (err) {
                    if (!(err instanceof BlockedError)) throw err;
                    log.warning(`The Trending Now page data failed (${err.message}); falling back to the RSS feed.`);
                    source = 'rss';
                    rows = await client.trendingRss(cfg.trendingGeo);
                }
            } else rows = await client.trendingRss(cfg.trendingGeo);
            trending.source = source;
            let batch = rows.slice(0, cfg.maxTrendingItems);
            if (isPpe && batch.length) {
                const allowed = canAfford(EVENT_TRENDING);
                if (allowed < batch.length) {
                    batch = batch.slice(0, Math.max(0, allowed));
                    limitReached = true;
                }
                if (batch.length) {
                    const r = await Actor.charge({ eventName: EVENT_TRENDING, count: batch.length });
                    if (r.chargedCount < batch.length) {
                        batch = batch.slice(0, r.chargedCount);
                        limitReached = true;
                    }
                }
            }
            const items = batch.map((row) => buildTrendingItem(row, { geo: cfg.trendingGeo, source, hours: cfg.trendingHours, scrapedAt, includeNews: cfg.includeNews }));
            if (items.length) await Actor.pushData(items);
            stats.trendingItemsCharged += isPpe ? items.length : 0;
            stats.trendingItemsPushed += items.length;
            trending.items = items.length;
            trending.available = rows.length;
            log.info(`Trending now (${cfg.trendingGeo}, ${source}): ${rows.length} search(es) found, ${items.length} stored.`);
            if (!rows.length) log.warning('Google returned an empty Trending Now list for this country.');
        } catch (err) {
            if (!(err instanceof BlockedError)) throw err;
            trending.error = err.message;
            log.error(`Trending now could not be loaded: ${err.message}`);
        }
    }
    // ── 2) Search terms, one comparison group at a time ─────────────────────────────────
    const groupResults = [];
    const pool = async (items, limit, fn) => {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                await fn(items[i], i);
            }
        }));
    };

    // With an anchor, all groups must be fetched before comparable values can be computed.
    const deferEmit = !!cfg.anchorTerm && cfg.groups.length > 1 && cfg.interestOverTime;
    const pending = [];

    const finishGroup = async (g, gi, r) => {
        const items = g.map((term, idx) => buildTermItem({
            term, cfg, group: g, groupId: gi + 1, timeline: r.timeline, seriesIdx: idx, slot: r.terms.get(term), comparable: r.comparable, tokenSource: r.tokenSource, scrapedAt,
        }));
        // The anchor is reported once (from the first group that has it).
        const fresh = items.filter((it) => !(it.isAnchor && termSummaries.some((s) => s.term === it.term)));
        for (const it of fresh) termSummaries.push({ term: it.term, groupId: it.groupId, status: it.status, errors: it.errors ?? [], averageInterest: it.averageInterest ?? null, comparableAverage: it.comparableAverage ?? null });
        const stored = await emitTerms(fresh);
        for (const it of fresh) {
            const was = stored.includes(it);
            if (!was) continue;
            if (it.status === 'ok') stats.termsOk++;
            else if (it.status === 'partial') stats.termsPartial++;
            else stats.termsFailed++;
        }
        const skipped = fresh.length - stored.length;
        log.info(`Group ${gi + 1}/${cfg.groups.length} [${g.join(', ')}]: ${fresh.map((it) => `${it.term}=${it.status}${it.averageInterest !== undefined && it.averageInterest !== null ? `(avg ${it.averageInterest})` : ''}`).join(', ')}`
            + `${skipped ? `; ${skipped} not stored (cost limit)` : ''}.`);
    };

    await pool(cfg.groups, cfg.maxConcurrency, async (g, gi) => {
        if (limitReached) return;
        // Budget check before any request: skip terms that can't be paid for (the anchor is paid once).
        let chargeable = g.filter((t) => !charged.has(t) && !(t === cfg.anchorTerm && pending.some((p) => p.g.includes(t))));
        if (isPpe) {
            const affordable = canAfford(EVENT_TERM) - pending.reduce((s, p) => s + p.chargeable, 0);
            if (affordable < 1) {
                limitReached = true;
                return;
            }
            if (affordable < chargeable.length) {
                const keep = new Set(chargeable.slice(0, affordable));
                const trimmed = g.filter((t) => keep.has(t) || !chargeable.includes(t));
                log.warning(`Group ${gi + 1}: the maximum cost per run allows only ${affordable} more term(s); comparing [${trimmed.join(', ')}] instead of [${g.join(', ')}].`);
                g = trimmed;
                chargeable = chargeable.filter((t) => keep.has(t));
                cfg.groups[gi] = g;
                limitReached = true;
            }
        }
        const label = `group ${gi + 1}/${cfg.groups.length}`;
        const r = await client.runGroup(g, label);
        groupSummaries[gi] = { groupId: gi + 1, terms: g, tokenSource: r.tokenSource, error: r.groupError, resolution: r.timeline?.resolution ?? null, points: r.timeline?.series?.[0]?.length ?? null };
        if (deferEmit) {
            pending.push({ g, gi, r, chargeable: chargeable.length });
            groupResults[gi] = { groupId: gi + 1, terms: g, series: r.timeline ? new Map(g.map((t, i) => [t, r.timeline.series[i]])) : null };
            return;
        }
        await finishGroup(g, gi, r);
    });

    let anchorInfo = null;
    if (deferEmit) {
        const cmp = computeComparable(groupResults.filter(Boolean), cfg.anchorTerm);
        anchorInfo = { anchorTerm: cfg.anchorTerm, groups: cmp.diagnostics, error: cmp.error ?? null };
        if (cmp.error) log.warning(cmp.error);
        const weak = cmp.diagnostics.filter((d) => d.anchorAverage !== null && d.anchorAverage < 10);
        if (weak.length) log.warning(`The anchor "${cfg.anchorTerm}" averages below 10 in group(s) ${weak.map((d) => d.groupId).join(', ')}: Google rounds to whole numbers, so comparable values there are imprecise. Pick an anchor about as popular as your terms.`);
        pending.sort((a, b) => a.gi - b.gi);
        for (const p of pending) {
            p.r.comparable = cmp.values;
            await finishGroup(p.g, p.gi, p.r);
        }
    }

    if (!isPpe) stats.termResultsCharged = 0;

    // ── Summary ─────────────────────────────────────────────────────────────────────────
    const s = client.stats;
    const output = {
        ...stats,
        stoppedAtCostLimit: limitReached,
        settings: { geo: cfg.geo || 'Worldwide', timeRange: cfg.time, category: cfg.category, gprop: cfg.gprop || 'web', language: cfg.language, timezoneOffset: cfg.tz, anchorTerm: cfg.anchorTerm, comparisonMode: cfg.comparisonMode, flattenTimeline: cfg.flattenTimeline },
        terms: termSummaries,
        groups: groupSummaries.filter(Boolean),
        anchor: anchorInfo,
        trending,
        requests: s,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);
    log.info(`Requests: ${s.requests} (ok ${s.ok}, retries ${s.retries}, 429 rate limits ${s.rateLimited}, captcha ${s.captchaPages}, consent ${s.consentPages}, HTTP errors ${s.httpErrors}, `
        + `network errors ${s.networkErrors}, bad data ${s.badData}, refused tokens ${s.tokenRefused}, sessions ${s.sessionsCreated}, via browser ${s.browserRequests}, second passes ${s.secondPasses}; tokens from ${s.tokenSource ?? 'n/a'}).`);

    const termsDone = stats.termsOk + stats.termsPartial;
    const trendingFailed = cfg.trendingNow && trending && trending.error;
    const termsAllFailed = cfg.searchTerms.length > 0 && termsDone === 0 && stats.termsFailed > 0;
    if ((termsAllFailed || !cfg.searchTerms.length) && (!cfg.trendingNow || trendingFailed) && !stats.trendingItemsPushed && !limitReached) {
        const why = termSummaries.find((t) => t.errors.length)?.errors[0] ?? trending?.error ?? 'unknown error';
        throw new Error(`Google Trends could not be read (${why}). Google rate-limits shared datacenter IPs: try again later, lower the number of terms, `
            + 'or use the RESIDENTIAL proxy group. The "Trending now" RSS mode works on almost any IP.');
    }
    let status = cfg.searchTerms.length ? `${stats.termsOk} of ${stats.termsRequested} term(s) complete` : '';
    if (stats.termsPartial) status += `, ${stats.termsPartial} partial`;
    if (stats.termsFailed) status += `, ${stats.termsFailed} failed (not charged)`;
    if (cfg.trendingNow) status += `${status ? '; ' : ''}${trending?.error ? 'trending now failed' : `${stats.trendingItemsPushed} trending search(es)`}`;
    if (limitReached) status += '. Stopped at your maximum cost per run';
    status += '.';
    log.info(status);
    await client.close();
    await Actor.exit({ statusMessage: status });
} catch (err) {
    await client?.close().catch(() => {});
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
