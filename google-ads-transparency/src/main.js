import { Actor, log } from 'apify';
import { parseInput, limitProxy, InputError } from './input.js';
import { AtcClient, BlockedError } from './atc.js';
import { creativeUrl, advertiserUrl, pickAdvertiser, norm } from './parse.js';

const EVENT_AD = 'ad';
const n = (x) => Number(x).toLocaleString('en-US');
await Actor.init();

let client;
try {
    const cfg = parseInput((await Actor.getInput()) ?? {});
    const startedAt = new Date().toISOString();

    // ── Proxy: default Apify proxy (datacenter), one IP for the whole run ──────────────
    let proxyConfiguration = null;
    const isLocalTarget = /^https?:\/\/(localhost|127\.|\[::1\])/.test(process.env.ATC_BASE_URL ?? '');
    let proxyInput = isLocalTarget ? null : cfg.proxyConfiguration;
    if (proxyInput) {
        const limited = limitProxy(proxyInput);
        proxyInput = limited.proxy;
        for (const g of limited.removedGroups) {
            log.warning(`The Apify ${g} proxy group is not available in this Actor (it is billed per ${g === 'RESIDENTIAL' ? 'GB' : 'request'}). Using the default Apify proxy instead. To use other IPs, add your own proxy URLs.`);
        }
    }
    if (proxyInput && (proxyInput.useApifyProxy || proxyInput.proxyUrls?.length)) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } catch (err) {
            log.warning(`Proxy could not be set up (${err.message}). Continuing without a proxy.`);
        }
    }

    client = new AtcClient({ proxyConfiguration, requestDelayMs: cfg.requestDelayMs, maxBlockWaitSecs: cfg.maxBlockWaitSecs });
    await client.init();
    const datesText = cfg.dates ? `${cfg.dates.from}–${cfg.dates.to}` : 'any time';
    log.info(`${cfg.queries.length} search term(s), region=${cfg.region}, period=${datesText}, format=${cfg.format}, max ${n(cfg.maxAdsPerQuery)} ads each, `
        + `details=${cfg.includeDetails ? 'yes (regions, all variants)' : 'no'}, ${client.describe()}.`);

    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    const affordable = () => (isPpe ? chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_AD) : Infinity);

    const perQuery = [];
    const failures = [];
    let pushed = 0;
    let limitReached = false;
    let detailsFailed = 0;

    /** Charges and stores ads; returns how many were stored. */
    const emit = async (items) => {
        if (!items.length || limitReached) return 0;
        let batch = items;
        if (isPpe) {
            const allowed = affordable();
            if (allowed < batch.length) {
                batch = batch.slice(0, Math.max(0, allowed));
                limitReached = true;
            }
            if (!batch.length) return 0;
            const r = await Actor.charge({ eventName: EVENT_AD, count: batch.length });
            if (r.chargedCount < batch.length) {
                batch = batch.slice(0, r.chargedCount);
                limitReached = true;
            }
        }
        if (batch.length) await Actor.pushData(batch);
        pushed += batch.length;
        if (affordable() < 1) limitReached = true;
        return batch.length;
    };

    for (const q of cfg.queries) {
        if (limitReached) break;
        const qs = { input: q.input, type: q.type, advertiserId: null, advertiserName: null, domain: null, adsReported: null, adsStored: 0, pages: 0, error: null };
        perQuery.push(qs);
        try {
            // 1) Resolve what to search for.
            let advertiserId = null;
            let domain = null;
            if (q.type === 'advertiserId') advertiserId = q.value;
            else if (q.type === 'domain') domain = q.value;
            else {
                const { advertisers } = await client.suggestions(q.value);
                const pick = pickAdvertiser(q.value, advertisers);
                if (!pick.advertiser) {
                    qs.error = 'no advertiser with this name';
                    const near = advertisers.slice(0, 5).map((a) => `${a.name} (${a.id})`).join(', ');
                    failures.push({ input: q.input, error: `No advertiser named "${q.value}"${near ? `; closest: ${near}` : ''}` });
                    log.warning(`"${q.value}": no advertiser with this name${near ? `. Closest: ${near}` : ''}. Use the advertiser ID or the website domain instead.`);
                    continue;
                }
                advertiserId = pick.advertiser.id;
                qs.advertiserName = pick.advertiser.name;
                const others = pick.others.filter((a) => norm(a.name) === norm(q.value) || norm(a.name).startsWith(norm(q.value))).slice(0, 4);
                log.info(`"${q.value}" → advertiser "${pick.advertiser.name}" (${advertiserId}, ${pick.advertiser.country ?? '?'}, ${pick.match})`
                    + `${others.length ? `. Other advertisers with a similar name: ${others.map((a) => `${a.name} ${a.country ?? ''} ${a.id}`).join('; ')}` : ''}.`);
            }
            qs.advertiserId = advertiserId;
            qs.domain = domain;

            // 2) Page through the ads.
            let token = null;
            const seen = new Set();
            while (qs.adsStored < cfg.maxAdsPerQuery && !limitReached) {
                const budget = Math.min(cfg.maxAdsPerQuery - qs.adsStored, affordable());
                if (budget < 1) {
                    limitReached = true;
                    break;
                }
                const page = await client.searchCreatives({
                    advertiserId, domain, geoId: cfg.geoId, formatCode: cfg.formatCode, dates: cfg.dates,
                    pageSize: Math.min(40, Math.max(budget, 10)), pageToken: token,
                });
                qs.pages++;
                if (qs.pages === 1) {
                    qs.adsReported = page.totalMin !== null ? { min: page.totalMin, max: page.totalMax } : null;
                    log.info(`"${q.input}": Google reports ${page.totalMin !== null ? `${n(page.totalMin)}–${n(page.totalMax)}` : 'no'} ads for these filters.`);
                }
                const fresh = page.ads.filter((a) => !seen.has(a.adId) && seen.add(a.adId)).slice(0, budget);
                const items = [];
                let blockedMidPage = null;
                for (const a of fresh) {
                    let detail = null;
                    if (cfg.includeDetails) {
                        try {
                            detail = await client.creativeDetail(a.advertiserId, a.adId);
                        } catch (err) {
                            if (err instanceof BlockedError) {
                                blockedMidPage = err;
                                break;
                            }
                            detailsFailed++;
                            log.warning(`Details of ad ${a.adId} could not be read: ${err.message}`);
                        }
                    }
                    if (!qs.advertiserName && a.advertiserName) qs.advertiserName = a.advertiserName;
                    const regionParam = cfg.region === 'anywhere' ? 'anywhere' : cfg.region;
                    const variants = detail?.variants?.length ? detail.variants : [{ imageUrl: a.imageUrl, previewUrl: a.previewUrl }];
                    const youtubeId = detail?.youtubeId ?? a.youtubeId;
                    items.push({
                        searchTerm: q.input,
                        advertiserName: a.advertiserName ?? detail?.advertiserName ?? null,
                        advertiserId: a.advertiserId,
                        adId: a.adId,
                        format: a.format,
                        firstShown: a.firstShown,
                        lastShown: detail?.lastShown ?? a.lastShown,
                        regions: detail ? detail.regions.map((r) => r.code ?? String(r.geoId)) : null,
                        regionNames: detail ? detail.regions.map((r) => r.name ?? String(r.geoId)) : null,
                        regionCount: detail ? detail.regions.length : null,
                        imageUrl: variants.find((v) => v.imageUrl)?.imageUrl ?? a.imageUrl ?? null,
                        previewUrl: variants.find((v) => v.previewUrl)?.previewUrl ?? a.previewUrl ?? null,
                        videoUrl: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null,
                        variantCount: detail ? variants.length : null,
                        variants: detail ? variants : null,
                        adUrl: creativeUrl(a.advertiserId, a.adId, regionParam),
                        advertiserUrl: advertiserUrl(a.advertiserId, regionParam),
                        searchedDomain: domain,
                        filterRegion: cfg.region,
                        filterPeriod: cfg.dates ? { from: String(cfg.dates.from), to: String(cfg.dates.to) } : null,
                        filterFormat: cfg.format,
                        detailsError: cfg.includeDetails && !detail ? 'details could not be read' : null,
                        scrapedAt: startedAt,
                    });
                }
                qs.adsStored += await emit(items);
                if (blockedMidPage) throw blockedMidPage; // ads read before the block are kept (and charged)
                log.info(`"${q.input}" page ${qs.pages}: ${fresh.length} ads, ${qs.adsStored}/${n(cfg.maxAdsPerQuery)} stored.`);
                if (!page.ads.length || !page.nextPageToken || page.nextPageToken === token) break;
                token = page.nextPageToken;
            }
            if (!qs.adsStored && !qs.error) log.warning(`"${q.input}": no ads found for these filters (region ${cfg.region}, ${datesText}, ${cfg.format}).`);
        } catch (err) {
            qs.error = err.message;
            failures.push({ input: q.input, error: err.message });
            log.error(`"${q.input}": ${err.message} (${qs.adsStored} ad(s) stored for it).`);
            if (err instanceof BlockedError) break; // same IP for the whole run: no point in going on.
        }
    }

    const output = { adsStored: pushed, detailsFailed, stoppedAtCostLimit: limitReached, queries: perQuery, failures, requests: client.stats, finishedAt: new Date().toISOString() };
    await Actor.setValue('OUTPUT', output);
    const s = client.stats;
    log.info(`Requests: ${s.requests} (ok ${s.ok}, rate-limit answers ${s.blockedAnswers}, waited ${s.waitedSecs} s, HTTP errors ${s.httpErrors}, network errors ${s.networkErrors}).`);

    if (pushed === 0 && failures.length === perQuery.length && perQuery.length) {
        throw new Error(`No ads could be read for any of the ${perQuery.length} search term(s). Last error: ${failures[failures.length - 1].error}`);
    }
    let status = `${n(pushed)} ad(s) stored from ${perQuery.length} search term(s).`;
    if (failures.length) status += ` ${failures.length} failed (see the log / OUTPUT).`;
    if (detailsFailed) status += ` Details missing for ${detailsFailed} ad(s).`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';
    log.info(status);
    await Actor.exit({ statusMessage: status });
} catch (err) {
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
