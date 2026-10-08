import { Actor, log } from 'apify';
import { parseInput, InputError } from './input.js';
import { HttpClient } from './http.js';
import { DEFAULT_BASE_URL, parseFeed, searchQueryText, searchFeedUrl, topStoriesFeedUrl, topicFeedUrl, locationFeedUrl } from './feeds.js';
import { decodeOffline, parseArticlePage, batchBody, parseBatchResponse } from './decode.js';
import { parsePublisherHead } from './publisher.js';

const EVENT_ARTICLE = 'article';
const EVENT_DETAILS = 'publisher-details';
const CHUNK = 20; // articles decoded, charged and pushed together
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

await Actor.init();
let exitCode = 0;
try {
    let cfg;
    try {
        cfg = parseInput((await Actor.getInput()) ?? {});
    } catch (err) {
        if (err instanceof InputError) {
            log.error(`Input problem: ${err.message}`);
            await Actor.fail(`Input problem: ${err.message}`);
        }
        throw err;
    }
    const baseUrl = (process.env.GN_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
    const isMock = baseUrl !== DEFAULT_BASE_URL;
    const ed = cfg.edition;

    if (cfg.removedGroups.length) {
        log.warning(`The Apify ${cfg.removedGroups.join(' and ')} proxy group(s) are not available in this Actor (not needed for public Google News feeds). Using the default Apify proxy instead. To use your own IPs, set proxy URLs in the Proxy field.`);
    }
    let proxyConfiguration = null;
    if ((!isMock && cfg.proxy?.useApifyProxy !== false) || cfg.proxy?.proxyUrls?.length) {
        try {
            proxyConfiguration = (await Actor.createProxyConfiguration(cfg.proxy)) ?? null;
        } catch (err) {
            log.warning(`Proxy not available (${err.message.split('\n')[0]}). Continuing without a proxy: fine for small runs.`);
        }
    }

    const http = new HttpClient({ proxyConfiguration, maxRetries: cfg.maxRetries, acceptLanguage: `${ed.hl},${ed.hl.split('-')[0]};q=0.9` });
    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    const canAfford = (event) => (isPpe ? chargingManager.calculateMaxEventChargeCountWithinLimit(event) : Infinity);

    // Feed plan.
    const feeds = [];
    for (const q of cfg.queries) feeds.push({ type: 'search', label: q });
    if (cfg.topStories) feeds.push({ type: 'topStories', label: 'TOP_STORIES' });
    for (const t of cfg.topics) feeds.push({ type: 'topic', label: t });
    for (const l of cfg.locations) feeds.push({ type: 'location', label: l });

    log.info(`${feeds.length} feed(s): ${feeds.map((f) => `${f.type}:"${f.label}"`).join(', ')}; edition hl=${ed.hl} gl=${ed.gl} ceid=${ed.ceid}; `
        + `period=${cfg.timeRange}${cfg.timeRange === 'custom' ? ` ${cfg.dateFrom}→${cfg.dateTo}` : ''}; max ${cfg.maxArticlesPerFeed} article(s) per feed; `
        + `real URLs=${cfg.decodeUrls ? 'yes' : 'no'}, publisher details=${cfg.fetchPublisherDetails ? 'yes' : 'no'}; proxy=${proxyConfiguration ? 'Apify Proxy' : 'none'}.`);
    if (cfg.splitNote) log.info(cfg.splitNote);

    const seen = new Set();
    const stats = { feeds: feeds.length, feedsOk: 0, feedsFailed: 0, rssRequests: 0, articlesFound: 0, duplicatesSkipped: 0, outsidePeriod: 0,
        articlesPushed: 0, articlesCharged: 0, urlsDecoded: 0, urlsNotDecoded: 0, publisherDetailsOk: 0, publisherDetailsCharged: 0 };
    const feedSummaries = [];
    let limitReached = false;
    let decodeFailStreak = 0;
    let decodeDisabled = !cfg.decodeUrls;

    const fetchRss = async (url, label) => {
        stats.rssRequests++;
        const res = await http.request(url, {}, (r) => r.status === 200 && parseFeed(r.text).ok, label);
        return parseFeed(res.text);
    };

    /** Real URLs for a chunk of items: offline first, then article page + one batched POST. */
    const decodeChunk = async (items) => {
        for (const it of items) {
            const off = decodeOffline(it.articleId);
            if (off) it.articleUrl = off;
        }
        if (decodeDisabled) return;
        const todo = items.filter((it) => !it.articleUrl && it.articleId);
        if (!todo.length) return;
        const params = await mapLimit(todo, cfg.maxConcurrency, async (it) => {
            try {
                const url = `${baseUrl}/rss/articles/${encodeURIComponent(it.articleId)}?hl=${encodeURIComponent(ed.hl)}&gl=${ed.gl}&ceid=${encodeURIComponent(ed.ceid)}`;
                const res = await http.request(url, {}, (r) => r.status === 200 && !!parseArticlePage(r.text), 'decode page');
                return { it, ...parseArticlePage(res.text) };
            } catch (err) {
                log.debug(`[decode] page failed for ${it.articleId.slice(0, 30)}…: ${err.message}`);
                return null;
            }
        });
        const ok = params.filter(Boolean);
        for (let i = 0; i < ok.length; i += 10) {
            const batch = ok.slice(i, i + 10);
            try {
                const res = await http.request(`${baseUrl}/_/DotsSplashUi/data/batchexecute`, {
                    method: 'POST',
                    body: batchBody(batch.map((p) => ({ articleId: p.it.articleId, timestamp: p.timestamp, signature: p.signature }))),
                    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                }, (r) => r.status === 200 && parseBatchResponse(r.text).size > 0, 'decode batch');
                const map = parseBatchResponse(res.text);
                batch.forEach((p, j) => { const u = map.get(String(j + 1)); if (u) p.it.articleUrl = u; });
            } catch (err) {
                log.warning(`[decode] batch of ${batch.length} failed: ${err.message}`);
            }
        }
        const decoded = todo.filter((it) => it.articleUrl).length;
        decodeFailStreak = decoded ? 0 : decodeFailStreak + 1;
        if (decodeFailStreak >= 3) {
            decodeDisabled = true;
            log.warning('[decode] 3 chunks in a row without any real URL: stopping URL decoding for the rest of the run. Articles keep their Google News link (it redirects to the article).');
        }
    };

    const publisherDetails = async (items) => {
        await mapLimit(items.filter((it) => it.articleUrl), cfg.maxConcurrency, async (it) => {
            try {
                const res = await http.once(it.articleUrl, { headers: { accept: 'text/html,application/xhtml+xml' } });
                if (res.status !== 200) return;
                const d = parsePublisherHead(res.text);
                if (d.snippet || d.imageUrl || d.author) {
                    it.details = d;
                    if (d.canonicalUrl && /^https?:\/\//.test(d.canonicalUrl)) it.articleUrl = d.canonicalUrl;
                }
            } catch (err) {
                log.debug(`[publisher] ${it.articleUrl}: ${err.message}`);
            }
        });
    };

    const toRow = (f, it, rank, period) => ({
        feedType: f.type,
        feed: f.label,
        rank,
        title: it.title,
        source: it.source,
        sourceUrl: it.sourceUrl,
        publishedAt: it.publishedAt,
        articleUrl: it.articleUrl ?? null,
        urlDecoded: !!it.articleUrl,
        googleNewsUrl: it.googleNewsUrl,
        snippet: it.details?.snippet ?? it.snippet ?? null,
        imageUrl: it.details?.imageUrl ?? null,
        author: it.details?.author ?? null,
        ...(cfg.includeRelatedCoverage ? { relatedCoverage: it.related } : {}),
        language: ed.hl,
        country: ed.gl,
        period,
        articleId: it.articleId,
        scrapedAt: new Date().toISOString(),
    });

    for (const [fi, f] of feeds.entries()) {
        if (limitReached) break;
        const tag = `feed ${fi + 1}/${feeds.length} ${f.type}:"${f.label}"`;
        const windows = f.type === 'search' ? cfg.searchWindows : [{}];
        const collected = [];
        let feedErrors = 0;
        let feedTitle = null;
        for (const w of windows) {
            if (collected.length >= cfg.maxArticlesPerFeed) break;
            let url;
            if (f.type === 'search') url = searchFeedUrl(baseUrl, ed, searchQueryText(f.label, w));
            else if (f.type === 'topStories') url = topStoriesFeedUrl(baseUrl, ed);
            else if (f.type === 'topic') url = topicFeedUrl(baseUrl, ed, f.label);
            else url = locationFeedUrl(baseUrl, ed, f.label);
            const t0 = Date.now();
            try {
                const feed = await fetchRss(url, tag);
                feedTitle ??= feed.title;
                let added = 0;
                for (const it of feed.items) {
                    stats.articlesFound++;
                    const ts = it.publishedAt ? Date.parse(it.publishedAt) : null;
                    if (ts && ((cfg.sinceMs && ts < cfg.sinceMs) || (cfg.untilMs && ts >= cfg.untilMs))) { stats.outsidePeriod++; continue; }
                    const key = it.articleId || it.googleNewsUrl;
                    if (cfg.deduplicate && seen.has(key)) { stats.duplicatesSkipped++; continue; }
                    if (collected.some((c) => (c.articleId || c.googleNewsUrl) === key)) continue;
                    if (cfg.deduplicate) seen.add(key);
                    collected.push(it);
                    added++;
                    if (collected.length >= cfg.maxArticlesPerFeed) break;
                }
                log.info(`[${tag}]${w.day ? ` day ${w.day}` : ''} RSS ${Date.now() - t0}ms: ${feed.items.length} item(s), ${added} new → ${collected.length}/${cfg.maxArticlesPerFeed}`);
            } catch (err) {
                feedErrors++;
                log.warning(`[${tag}]${w.day ? ` day ${w.day}` : ''} RSS failed after ${cfg.maxRetries + 1} attempt(s): ${err.message}`);
            }
            if (windows.length > 1 && cfg.requestDelayMs) await sleep(cfg.requestDelayMs);
        }
        if (feedErrors === windows.length) stats.feedsFailed++;
        else stats.feedsOk++;
        // Newest first; rank = position in the result for this feed.
        collected.sort((a, b) => (Date.parse(b.publishedAt ?? 0) || 0) - (Date.parse(a.publishedAt ?? 0) || 0));
        const period = cfg.timeRange === 'custom' ? `${cfg.dateFrom}..${cfg.dateTo}` : cfg.timeRange;

        let pushed = 0;
        for (let i = 0; i < collected.length && !limitReached; i += CHUNK) {
            let chunk = collected.slice(i, i + CHUNK);
            const affordable = canAfford(EVENT_ARTICLE);
            if (affordable < chunk.length) {
                chunk = chunk.slice(0, Math.max(0, affordable));
                limitReached = true;
                log.warning(`Maximum cost per run reached: ${chunk.length} more article(s) will be saved, then the run stops. Raise "Maximum cost per run" to get more.`);
                if (!chunk.length) break;
            }
            await decodeChunk(chunk);
            if (cfg.fetchPublisherDetails) await publisherDetails(chunk);
            const rows = chunk.map((it, j) => toRow(f, it, i + j + 1, period));
            if (isPpe) {
                const r = await Actor.charge({ eventName: EVENT_ARTICLE, count: rows.length });
                stats.articlesCharged += r.chargedCount ?? rows.length;
                if (r.eventChargeLimitReached) limitReached = true;
                const withDetails = chunk.filter((it) => it.details).length;
                if (withDetails) {
                    const d = await Actor.charge({ eventName: EVENT_DETAILS, count: withDetails });
                    stats.publisherDetailsCharged += d.chargedCount ?? withDetails;
                }
            }
            await Actor.pushData(rows);
            pushed += rows.length;
            stats.articlesPushed += rows.length;
            const dec = rows.filter((r) => r.urlDecoded).length;
            stats.urlsDecoded += dec;
            stats.urlsNotDecoded += rows.length - dec;
            stats.publisherDetailsOk += chunk.filter((it) => it.details).length;
            if (cfg.decodeUrls || cfg.fetchPublisherDetails) log.info(`[${tag}] saved ${pushed}/${collected.length} (real URL for ${dec}/${rows.length} in this batch)`);
        }
        feedSummaries.push({ feedType: f.type, feed: f.label, feedTitle, articles: pushed, rssErrors: feedErrors });
        log.info(`[${tag}] done: ${pushed} article(s) saved${feedErrors ? `, ${feedErrors} RSS request(s) failed` : ''}.`);
        if (fi < feeds.length - 1 && cfg.requestDelayMs) await sleep(cfg.requestDelayMs);
    }

    const output = { ...stats, httpRequests: http.stats.requests, httpRetries: http.stats.retries, blockedAnswers: http.stats.blocked, feedsDetail: feedSummaries, limitReached };
    await Actor.setValue('OUTPUT', output);
    log.info(`Finished: ${stats.articlesPushed} article(s) from ${stats.feedsOk}/${stats.feeds} feed(s); real URL for ${stats.urlsDecoded}, `
        + `${stats.duplicatesSkipped} duplicate(s) skipped, ${stats.outsidePeriod} outside the period; ${http.stats.requests} HTTP request(s), ${http.stats.retries} retr(ies).`);
    if (stats.feedsOk === 0) {
        exitCode = 1;
        await Actor.fail('No Google News feed could be read (every request failed after retries). Try again later or with a different proxy.');
    } else if (!stats.articlesPushed) {
        log.warning('No articles matched. Try a longer period ("timeRange"), fewer words in the query, or another language / country.');
    }
} catch (err) {
    if (!(err instanceof InputError)) {
        log.exception(err, 'Run failed');
        exitCode = 1;
        await Actor.fail(`Run failed: ${err.message}`);
    }
}
await Actor.exit({ exitCode });
