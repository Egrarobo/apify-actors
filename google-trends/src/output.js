// Turns parsed widget data into dataset items: per-term items, flat spreadsheet rows, cross-group comparable values.
import { buildPublicExploreUrl, GPROP_NAMES } from './request.js';

const round2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/**
 * With an anchor term in every group, rescales all groups onto the first group's scale using the anchor's
 * total interest (sum over complete points), then rescales so the highest point of all terms is 100.
 * Returns Map(term → comparable values aligned with its timeline) and per-group diagnostics.
 */
export function computeComparable(groups, anchor) {
    const norm = (s) => s.toLowerCase();
    const sumAnchor = (g) => {
        const s = g.series.get(g.terms.find((t) => norm(t) === norm(anchor)));
        return s ? s.filter((p) => !p.isPartial).reduce((acc, p) => acc + (p.value ?? 0), 0) : 0;
    };
    const usable = groups.filter((g) => g.series);
    const ref = usable.find((g) => sumAnchor(g) > 0);
    const diagnostics = [];
    const raw = new Map();
    if (!ref) return { values: raw, diagnostics, scaleMax: null, error: `The anchor "${anchor}" has no search interest in any group, so groups cannot be put on one scale.` };
    const refSum = sumAnchor(ref);
    for (const g of usable) {
        const a = sumAnchor(g);
        const anchorSeries = g.series.get(g.terms.find((t) => norm(t) === norm(anchor)));
        const anchorAvg = anchorSeries ? mean(anchorSeries.filter((p) => !p.isPartial).map((p) => p.value ?? 0)) : null;
        const scale = a > 0 ? refSum / a : null;
        diagnostics.push({ groupId: g.groupId, anchorAverage: anchorAvg !== null ? round2(anchorAvg) : null, scaleFactor: scale !== null ? Math.round(scale * 10000) / 10000 : null });
        if (scale === null) continue;
        for (const t of g.terms) {
            if (norm(t) === norm(anchor) && g !== ref) continue; // the anchor is reported from the reference group
            if (raw.has(t)) continue;
            raw.set(t, g.series.get(t).map((p) => (p.value === null ? null : p.value * scale)));
        }
    }
    let max = 0;
    for (const arr of raw.values()) for (const v of arr) if (v !== null && v > max) max = v;
    const values = new Map();
    for (const [t, arr] of raw) values.set(t, arr.map((v) => (v === null || !max ? null : round2((v * 100) / max))));
    return { values, diagnostics, scaleMax: max };
}

function timelineStats(points) {
    const complete = points.filter((p) => !p.isPartial && p.value !== null);
    const all = points.filter((p) => p.value !== null);
    if (!all.length) return { averageInterest: null, peakValue: null, peakDate: null, latestValue: null, latestDate: null };
    const peak = all.reduce((best, p) => (p.value > best.value ? p : best), all[0]);
    const latest = all[all.length - 1];
    const avg = mean(complete.length ? complete.map((p) => p.value) : all.map((p) => p.value));
    return { averageInterest: round2(avg), peakValue: peak.value, peakDate: peak.date, latestValue: latest.value, latestDate: latest.date };
}

/** One dataset item per term with everything requested. */
export function buildTermItem({ term, cfg, group, groupId, timeline, seriesIdx, slot, comparable, tokenSource, scrapedAt }) {
    const requested = [];
    const got = [];
    const item = {
        type: 'term',
        term,
        isAnchor: !!cfg.anchorTerm && term === cfg.anchorTerm,
        groupId,
        comparedWith: group.filter((t) => t !== term),
        geo: cfg.geo || 'Worldwide',
        timeRange: cfg.time,
        timeRangeResolved: timeline?.timeResolved ?? null,
        resolution: timeline?.resolution ?? null,
        category: cfg.category,
        categoryName: cfg.categoryName,
        gprop: cfg.gprop || 'web',
        gpropName: GPROP_NAMES[cfg.gprop] ?? cfg.gprop,
        language: cfg.language,
        status: 'ok',
        errors: slot.errors.length ? [...new Set(slot.errors)] : undefined,
    };
    if (cfg.interestOverTime) {
        requested.push('interestOverTime');
        const points = timeline ? timeline.series[seriesIdx] : null;
        if (points) {
            got.push('interestOverTime');
            const cmp = comparable?.get(term) ?? null;
            item.timeline = points.map((p, i) => ({ ...p, ...(cmp ? { comparableValue: cmp[i] ?? null } : {}) }));
            Object.assign(item, timelineStats(points));
            if (timeline.averages && Number.isFinite(timeline.averages[seriesIdx])) item.googleAverage = timeline.averages[seriesIdx];
            if (cmp) {
                const vals = cmp.filter((v, i) => v !== null && !points[i].isPartial);
                item.comparableAverage = vals.length ? round2(mean(vals)) : null;
            }
            item.timelinePoints = points.length;
        } else item.timeline = null;
    }
    if (cfg.interestByRegion) {
        requested.push('interestByRegion');
        if (slot.region) {
            got.push('interestByRegion');
            item.regionResolution = slot.region.resolution;
            item.regions = slot.region.regions;
            const top = slot.region.regions.find((r) => r.value !== null && r.hasData);
            item.topRegion = top ? top.geoName : null;
        } else item.regions = null;
    }
    const cut = (list) => (cfg.maxRelatedItems ? list.slice(0, cfg.maxRelatedItems) : list);
    if (cfg.relatedQueries) {
        requested.push('relatedQueries');
        if (slot.queries) {
            got.push('relatedQueries');
            item.relatedQueriesTop = cut(slot.queries.top);
            item.relatedQueriesRising = cut(slot.queries.rising);
        } else {
            item.relatedQueriesTop = null;
            item.relatedQueriesRising = null;
        }
    }
    if (cfg.relatedTopics) {
        requested.push('relatedTopics');
        if (slot.topics) {
            got.push('relatedTopics');
            item.relatedTopicsTop = cut(slot.topics.top);
            item.relatedTopicsRising = cut(slot.topics.rising);
        } else {
            item.relatedTopicsTop = null;
            item.relatedTopicsRising = null;
        }
    }
    item.status = got.length === requested.length ? 'ok' : got.length ? 'partial' : 'failed';
    item.exploreUrl = buildPublicExploreUrl({ terms: group, geo: cfg.geo, time: cfg.time, category: cfg.category, gprop: cfg.gprop, hl: cfg.language });
    item.dataSource = tokenSource ?? null;
    item.scrapedAt = scrapedAt;
    return item;
}

/** Long format for spreadsheets: one "term" row plus one row per timeline point, region and related item. */
export function flattenTermItem(item) {
    const base = { term: item.term, groupId: item.groupId, geo: item.geo, timeRange: item.timeRange };
    const rows = [{
        rowType: 'term', ...base, status: item.status, averageInterest: item.averageInterest ?? null, comparableAverage: item.comparableAverage ?? null,
        peakDate: item.peakDate ?? null, topRegion: item.topRegion ?? null, comparedWith: item.comparedWith.join(', '),
        errors: item.errors?.join(' | ') ?? null, exploreUrl: item.exploreUrl, scrapedAt: item.scrapedAt,
    }];
    for (const p of item.timeline ?? []) {
        rows.push({ rowType: 'timeline', ...base, date: p.date, value: p.value, ...(p.comparableValue !== undefined ? { comparableValue: p.comparableValue } : {}), isPartial: p.isPartial, hasData: p.hasData });
    }
    for (const r of item.regions ?? []) rows.push({ rowType: 'region', ...base, regionCode: r.geoCode, regionName: r.geoName, value: r.value, ...(r.lat !== undefined ? { lat: r.lat, lng: r.lng } : {}) });
    for (const [list, key] of [['top', 'relatedQueriesTop'], ['rising', 'relatedQueriesRising']]) {
        for (const q of item[key] ?? []) rows.push({ rowType: 'relatedQuery', ...base, list, rank: q.rank, query: q.query, value: q.value, formattedValue: q.formattedValue, isBreakout: q.isBreakout ?? false, link: q.link });
    }
    for (const [list, key] of [['top', 'relatedTopicsTop'], ['rising', 'relatedTopicsRising']]) {
        for (const q of item[key] ?? []) rows.push({ rowType: 'relatedTopic', ...base, list, rank: q.rank, topicId: q.topicId, title: q.title, topicType: q.topicType, value: q.value, formattedValue: q.formattedValue, isBreakout: q.isBreakout ?? false, link: q.link });
    }
    return rows;
}

/** One dataset item per Trending Now search. */
export function buildTrendingItem(row, { geo, source, hours, scrapedAt, includeNews }) {
    const news = includeNews ? (row.news ?? []) : [];
    const first = news[0] ?? null;
    const u = new URL('/trends/explore', 'https://trends.google.com');
    u.searchParams.set('q', row.title);
    u.searchParams.set('date', hours && hours <= 4 ? 'now 4-H' : hours && hours <= 24 ? 'now 1-d' : 'now 7-d');
    u.searchParams.set('geo', geo);
    return {
        type: 'trending',
        rank: row.rank,
        title: row.title,
        approxTraffic: row.approxTraffic ?? null,
        approxTrafficMin: row.approxTrafficMin ?? null,
        increasePercent: row.increasePercent ?? null,
        startedAt: row.startedAt ?? null,
        endedAt: row.endedAt ?? null,
        isActive: row.isActive ?? null,
        relatedQueries: row.relatedQueries ?? [],
        categories: row.categories ?? [],
        newsCount: news.length,
        newsTitle: first?.title ?? null,
        newsUrl: first?.url ?? null,
        newsSource: first?.source ?? null,
        news: includeNews ? news : undefined,
        picture: row.picture ?? null,
        pictureSource: row.pictureSource ?? null,
        geo,
        timeWindowHours: source === 'rss' ? null : hours,
        source,
        exploreUrl: u.toString(),
        scrapedAt,
    };
}
