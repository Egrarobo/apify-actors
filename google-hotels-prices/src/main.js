import { Actor, log } from 'apify';
import { parseInput, buildFilter, limitProxy, InputError } from './input.js';
import { GoogleClient, BlockedError } from './google.js';
import { buildHotelUrl, DEFAULT_BASE_URL } from './request.js';

const EVENT_HOTEL = 'hotel';
const EVENT_OFFERS = 'hotel-offers';
const n = (x) => Number(x).toLocaleString('en-US');

await Actor.init();

let client;
try {
    const input = (await Actor.getInput()) ?? {};
    const cfg = parseInput(input);
    const startedAt = new Date().toISOString();

    // ── Proxy ────────────────────────────────────────────────────────────────────────
    let proxyConfiguration = null;
    const isMock = cfg.baseUrl !== DEFAULT_BASE_URL;
    const isLocalTarget = /^https?:\/\/(localhost|127\.|\[::1\])/.test(cfg.baseUrl);
    // A local mock server can't be reached through a proxy.
    let proxyInput = isLocalTarget ? null : (cfg.proxyConfiguration ?? { useApifyProxy: true });
    if (proxyInput) {
        const limited = limitProxy(proxyInput);
        proxyInput = limited.proxy;
        if (limited.removedGroups.includes('RESIDENTIAL')) {
            log.warning('The Apify RESIDENTIAL proxy group is not available in this Actor (it is billed per GB). '
                + 'Using the default Apify proxy instead. To use residential IPs, choose your own proxies (proxy URLs) in the Proxy field.');
        }
        if (limited.removedGroups.includes('GOOGLE_SERP')) {
            log.warning('The Apify GOOGLE_SERP proxy group is not available in this Actor (it is billed per request). '
                + 'Using the default Apify proxy instead. To use other IPs, choose your own proxies (proxy URLs) in the Proxy field.');
        }
    }
    if (proxyInput && (proxyInput.useApifyProxy || proxyInput.proxyUrls?.length)) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } catch (err) {
            log.warning(`Proxy could not be set up (${err.message}). Continuing WITHOUT a proxy; Google may block this IP quickly.`);
        }
    }
    const groups = proxyInput?.apifyProxyGroups ?? [];
    let proxyDesc = 'none';
    if (proxyConfiguration) {
        proxyDesc = proxyInput.proxyUrls?.length ? `custom (${proxyInput.proxyUrls.length} URL(s))` : `Apify Proxy ${groups.length ? groups.join('+') : 'automatic (datacenter)'}${proxyInput.apifyProxyCountry ? ` country=${proxyInput.apifyProxyCountry}` : ''}`;
    }
    if (!proxyConfiguration && !isMock) log.warning('Running without a proxy. Expect captcha / "unusual traffic" pages after a few requests.');

    const filter = buildFilter(cfg.filters);
    const hasFilters = cfg.filters.minPrice !== null || cfg.filters.maxPrice !== null || cfg.filters.minRating !== null || cfg.filters.hotelClass.length > 0;
    log.info(`Stay ${cfg.checkIn} → ${cfg.checkOut} (${cfg.nights} night${cfg.nights > 1 ? 's' : ''}), ${cfg.adults} adult(s)${cfg.children ? `, ${cfg.children} child(ren) aged ${cfg.childrenAges.join('/')}` : ''}, `
        + `currency=${cfg.currency} hl=${cfg.language} gl=${cfg.country}, offers=${cfg.includeOffers ? 'yes' : 'no'}, proxy=${proxyDesc}, browser=${cfg.useBrowser}, searchMethod=${cfg.searchMethod}`
        + `${isMock ? `, baseUrl=${cfg.baseUrl}` : ''}${hasFilters ? `, filters=${JSON.stringify(cfg.filters)}` : ''}.`);
    if (cfg.children && cfg.searchMethod === 'page') log.warning('Children are not encoded in the search page URL ("page" method); list prices may be for adults only. Offers include the children.');

    client = new GoogleClient(cfg, proxyConfiguration);
    const chargingManager = Actor.getChargingManager();
    const isPpe = chargingManager.getPricingInfo().isPayPerEvent;
    // Price the SDK uses for budget math (it uses 1 USD per event outside the platform).
    const priceOf = (event) => (Actor.isAtHome() ? chargingManager.getPricingInfo().perEventPrices[event] ?? 0 : 1);
    /** How many more hotels the budget allows; with offers, each hotel costs a "hotel" + a "hotel-offers" event. */
    const affordableHotels = () => {
        if (!isPpe) return Infinity;
        const maxH = chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_HOTEL);
        if (!cfg.includeOffers || maxH === Infinity) return maxH;
        const pH = priceOf(EVENT_HOTEL);
        const pO = priceOf(EVENT_OFFERS);
        if (!pO) return maxH;
        return Math.floor(Number(((maxH * pH) / (pH + pO)).toFixed(4)));
    };

    const stats = { hotelsPushed: 0, hotelsCharged: 0, offersCharged: 0, hotelsWithoutPrice: 0, filteredOut: 0, offersFailed: 0, pagesRead: 0 };
    const perQuery = [];
    const failures = [];
    let limitReached = false;
    let currencyWarned = false;

    const finalize = (h, ctx) => {
        const offers = h.offers ?? null;
        const lowestOffer = offers?.find((o) => o.price !== null) ?? null;
        const official = offers?.find((o) => o.isOfficialSite) ?? null;
        if (!currencyWarned && h.currency && h.currency !== cfg.currency) {
            currencyWarned = true;
            log.warning(`Google returned prices in ${h.currency}, not ${cfg.currency}. The "currency" field of each item shows the real currency.`);
        }
        return {
            query: ctx.query,
            position: ctx.position ?? null,
            hotelName: h.hotelName,
            entityId: h.entityId,
            url: h.entityId ? buildHotelUrl({ entityId: h.entityId, query: ctx.query, checkIn: cfg.checkIn, checkOut: cfg.checkOut, adults: cfg.adults, currency: cfg.currency, language: cfg.language, country: cfg.country }) : null,
            rating: h.rating,
            reviews: h.reviews,
            hotelClass: h.hotelClass,
            hotelClassText: h.hotelClassText,
            address: h.address,
            lat: h.lat,
            lng: h.lng,
            amenities: h.amenities,
            amenityCodes: h.amenityCodes,
            priceLowest: lowestOffer ? Math.min(lowestOffer.price, h.pricePerNight ?? Infinity) : h.pricePerNight,
            pricePerNight: h.pricePerNight,
            pricePerNightWithTaxes: h.pricePerNightWithTaxes,
            priceTotal: h.priceTotal,
            priceBeforeTaxes: h.priceBeforeTaxes,
            taxes: h.taxes,
            fees: h.fees,
            pricePerNightText: h.pricePerNightText,
            currency: h.currency ?? cfg.currency,
            checkIn: cfg.checkIn,
            checkOut: cfg.checkOut,
            nights: cfg.nights,
            adults: cfg.adults,
            children: cfg.children,
            dealLabel: h.dealLabel,
            offersCount: offers ? offers.length : null,
            cheapestProvider: lowestOffer?.provider ?? null,
            officialSitePrice: official?.price ?? null,
            offers: offers ? (cfg.maxOffersPerHotel ? offers.slice(0, cfg.maxOffersPerHotel) : offers) : undefined,
            offersError: ctx.offersError,
            thumbnail: h.thumbnail,
            photos: h.photos,
            website: h.website,
            phone: h.phone,
            description: h.description,
            checkInTime: h.checkInTime,
            checkOutTime: h.checkOutTime,
            countryCode: h.countryCode,
            googleMapsUrl: h.googleMapsUrl,
            placeId: h.placeId,
            resolvedLocation: ctx.resolvedLocation ?? null,
            matchScore: ctx.matchScore,
            dataSource: ctx.dataSource,
            scrapedAt: startedAt,
        };
    };

    /** Runs fn over items with limited concurrency, keeping order. */
    const pool = async (items, limit, fn) => {
        const out = new Array(items.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i], i);
            }
        }));
        return out;
    };

    /** Adds offers to hotels (when requested and affordable). */
    const addOffers = async (hotels, query) => pool(hotels, cfg.maxConcurrency, async (h) => {
        if (!cfg.includeOffers || !h.entityId) return { h, offersError: cfg.includeOffers ? 'no hotel id' : undefined };
        try {
            const { hotel: d, parserPath } = await client.hotelDetail(h.entityId, query);
            const merged = { ...h };
            for (const [k, v] of Object.entries(d)) {
                if (v !== null && v !== undefined && !(Array.isArray(v) && !v.length && k !== 'offers')) {
                    if (merged[k] === null || merged[k] === undefined || (Array.isArray(merged[k]) && !merged[k].length) || k === 'offers') merged[k] = v;
                }
            }
            return { h: merged, detailPath: parserPath };
        } catch (err) {
            stats.offersFailed++;
            log.warning(`Offers for "${h.hotelName}" could not be loaded: ${err.message}`);
            return { h, offersError: `Offers could not be loaded: ${err.message}` };
        }
    });

    /** Charges and stores items; returns how many were stored. Unpriced hotels are stored for free. */
    const emit = async (items) => {
        if (!items.length || limitReached) return 0;
        const priced = items.filter((i) => i.pricePerNight !== null || i.offersCount);
        const free = items.filter((i) => !(i.pricePerNight !== null || i.offersCount));
        let batch = priced;
        if (isPpe) {
            const allowed = chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_HOTEL);
            if (allowed < batch.length) {
                batch = batch.slice(0, Math.max(0, allowed));
                limitReached = true;
            }
        }
        if (batch.length && isPpe) {
            const r = await Actor.charge({ eventName: EVENT_HOTEL, count: batch.length });
            if (r.chargedCount < batch.length) {
                batch = batch.slice(0, r.chargedCount);
                limitReached = true;
            }
        }
        stats.hotelsCharged += batch.length;
        // Offers are an extra event; hotels whose offers can't be paid for are stored without offers.
        const withOffers = batch.filter((i) => i.offersCount);
        if (withOffers.length) {
            let allowedO = isPpe ? chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_OFFERS) : withOffers.length;
            allowedO = Math.min(allowedO, withOffers.length);
            let charged = 0;
            if (!isPpe) charged = withOffers.length;
            else if (allowedO > 0) charged = (await Actor.charge({ eventName: EVENT_OFFERS, count: allowedO })).chargedCount;
            stats.offersCharged += charged;
            for (const it of withOffers.slice(charged)) {
                it.offers = undefined;
                it.offersCount = null;
                it.cheapestProvider = null;
                it.officialSitePrice = null;
                it.offersError = 'Not loaded: the maximum cost per run was reached.';
                limitReached = true;
            }
        }
        const toPush = [...batch, ...(limitReached ? [] : free)];
        if (toPush.length) await Actor.pushData(toPush);
        stats.hotelsPushed += toPush.length;
        stats.hotelsWithoutPrice += limitReached ? 0 : free.length;
        if (affordableHotels() < 1) limitReached = true;
        return toPush.length;
    };


    // ── 1) Search queries ───────────────────────────────────────────────────────────
    for (const q of cfg.queries) {
        if (limitReached) break;
        const qs = { query: q, pages: 0, hotelsSeen: 0, stored: 0, filteredOut: 0, totalResults: null, resolvedLocation: null, error: null, dataSource: null };
        perQuery.push(qs);
        const seen = new Set();
        let token = null;
        try {
            for (let p = 1; p <= cfg.maxPagesPerQuery && qs.stored < cfg.maxHotelsPerQuery && !limitReached; p++) {
                if (affordableHotels() < 1) {
                    limitReached = true;
                    break;
                }
                const r = await client.searchPage(q, { pageToken: token, pageNo: p });
                qs.pages++;
                stats.pagesRead++;
                qs.dataSource = `${r.method}/${r.transport}`;
                if (p === 1) {
                    qs.totalResults = r.totalResults;
                    qs.resolvedLocation = r.resolvedLocation;
                    if (r.locationRecognized === false && !r.hotels.length && !r.totalResults) {
                        log.warning(`"${q}": Google did not recognize this location${r.resolvedLocation ? ` (it suggested "${r.resolvedLocation}")` : ''}. Try adding the country, e.g. "hotels in Springfield, Illinois".`);
                        qs.error = 'location not recognized';
                        break;
                    }
                    log.info(`"${q}": Google resolved the location to "${r.resolvedLocation ?? '?'}" with ${r.totalResults !== null ? n(r.totalResults) : 'an unknown number of'} hotels (data: ${qs.dataSource}, ${r.parserPath}).`);
                }
                const fresh = r.hotels.filter((h) => {
                    const k = h.entityId ?? h.placeId ?? h.hotelName;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                });
                qs.hotelsSeen += fresh.length;
                const kept = fresh.filter(filter);
                qs.filteredOut += fresh.length - kept.length;
                stats.filteredOut += fresh.length - kept.length;
                let chosen = kept.slice(0, cfg.maxHotelsPerQuery - qs.stored);
                const budget = affordableHotels();
                const hitBudget = chosen.length > budget;
                if (hitBudget) chosen = chosen.slice(0, Math.max(0, budget));
                const enriched = await addOffers(chosen, q);
                const items = enriched.map(({ h, offersError, detailPath }, i) => finalize(h, {
                    query: q, position: qs.hotelsSeen - fresh.length + fresh.indexOf(chosen[i]) + 1, resolvedLocation: qs.resolvedLocation, offersError,
                    dataSource: detailPath ? `${qs.dataSource}+${detailPath}` : qs.dataSource,
                }));
                qs.stored += await emit(items);
                if (hitBudget) limitReached = true;
                log.info(`"${q}" page ${p}: ${fresh.length} new hotels, ${kept.length} match the filters, ${qs.stored}/${cfg.maxHotelsPerQuery} stored so far.`);
                if (!fresh.length) {
                    log.info(`"${q}": page ${p} had no new hotels; stopping.`);
                    break;
                }
                if (!r.nextPageToken || r.nextPageToken === token) {
                    log.info(`"${q}": no more result pages (${qs.hotelsSeen} hotels seen).`);
                    break;
                }
                token = r.nextPageToken;
            }
        } catch (err) {
            if (!(err instanceof BlockedError)) throw err;
            qs.error = err.message;
            failures.push({ query: q, error: err.message });
            log.error(`"${q}": Google could not be read (${err.message}). ${qs.stored} hotel(s) stored for this query.`);
        }
        if (hasFilters && qs.filteredOut) log.info(`"${q}": ${qs.filteredOut} hotel(s) skipped by your filters.`);
    }

    // ── 2) Hotel names ──────────────────────────────────────────────────────────────
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const score = (want, got) => {
        const w = new Set(norm(want).split(' ').filter((t) => t.length > 1 && !['hotel', 'the', 'and', 'by'].includes(t)));
        const g = new Set(norm(got).split(' '));
        if (!w.size) return norm(want) === norm(got) ? 1 : 0;
        return [...w].filter((t) => g.has(t)).length / w.size;
    };
    for (const name of cfg.hotelNames) {
        if (limitReached || affordableHotels() < 1) {
            limitReached = true;
            break;
        }
        const qs = { query: name, pages: 0, hotelsSeen: 0, stored: 0, error: null, dataSource: null };
        perQuery.push(qs);
        try {
            const r = await client.searchPage(name, { pageNo: 1 });
            qs.pages = 1;
            stats.pagesRead++;
            qs.dataSource = `${r.method}/${r.transport}`;
            qs.hotelsSeen = r.hotels.length;
            const ranked = r.hotels.map((h) => ({ h, s: score(name, h.hotelName) })).sort((a, b) => b.s - a.s);
            const best = ranked[0];
            if (!best || best.s < 0.5) {
                qs.error = 'no matching hotel';
                failures.push({ query: name, error: `No hotel matching "${name}"${best ? ` (closest: "${best.h.hotelName}")` : ''}` });
                log.warning(`"${name}": no confident match among ${r.hotels.length} result(s)${best ? `; closest was "${best.h.hotelName}" (score ${best.s.toFixed(2)})` : ''}. Add the city to the name, or use the hotel's Google Hotels link in "hotelUrls".`);
                continue;
            }
            log.info(`"${name}" → "${best.h.hotelName}" (match ${best.s.toFixed(2)}).`);
            const [{ h, offersError, detailPath }] = await addOffers([best.h], name);
            qs.stored += await emit([finalize(h, { query: name, position: 1, matchScore: Math.round(best.s * 100) / 100, resolvedLocation: r.resolvedLocation, offersError, dataSource: detailPath ? `${qs.dataSource}+${detailPath}` : qs.dataSource })]);
        } catch (err) {
            if (!(err instanceof BlockedError)) throw err;
            qs.error = err.message;
            failures.push({ query: name, error: err.message });
            log.error(`"${name}": Google could not be read (${err.message}).`);
        }
    }

    // ── 3) Hotel links (entity ids) ─────────────────────────────────────────────────
    for (const id of cfg.entityIds) {
        if (limitReached || affordableHotels() < 1) {
            limitReached = true;
            break;
        }
        const qs = { query: id, pages: 0, hotelsSeen: 0, stored: 0, error: null, dataSource: null };
        perQuery.push(qs);
        try {
            const { hotel, parserPath } = await client.hotelDetail(id, null);
            qs.dataSource = parserPath;
            qs.hotelsSeen = 1;
            if (!cfg.includeOffers) delete hotel.offers;
            if (!hotel.entityId) hotel.entityId = id;
            qs.stored += await emit([finalize(hotel, { query: id, position: 1, dataSource: parserPath })]);
            log.info(`Hotel ${id.slice(0, 14)}… → "${hotel.hotelName}"${cfg.includeOffers ? ` with ${hotel.offers.length} offer(s)` : ''}.`);
        } catch (err) {
            if (!(err instanceof BlockedError)) throw err;
            qs.error = err.message;
            failures.push({ query: id, error: err.message });
            log.error(`Hotel ${id}: could not be read (${err.message}).`);
        }
    }

    // ── Summary ─────────────────────────────────────────────────────────────────────
    const output = {
        ...stats,
        stoppedAtCostLimit: limitReached,
        queries: perQuery,
        failures,
        requests: client.stats,
        checkIn: cfg.checkIn,
        checkOut: cfg.checkOut,
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);
    const s = client.stats;
    log.info(`Requests: ${s.requests} (ok ${s.ok}, retries ${s.retries}, consent pages ${s.consentPages}, captcha pages ${s.captchaPages}, blocked ${s.blocked}, HTTP errors ${s.httpErrors}, network errors ${s.networkErrors}, no data ${s.noData}, via browser ${s.browserRequests}).`);

    const total = perQuery.length;
    if (total > 0 && stats.hotelsPushed === 0 && failures.length === total) {
        throw new Error(`Google could not be read for any of the ${total} input(s). Last error: ${failures[failures.length - 1].error}. `
            + 'Google blocks datacenter IPs quickly: keep the browser fallback on, run fewer hotels per run, try again later, or add your own proxy URLs.');
    }
    let status = `${n(stats.hotelsPushed)} hotel(s) stored from ${total} input(s)${cfg.includeOffers ? `, ${n(stats.offersCharged)} with provider offers` : ''}.`;
    if (failures.length) status += ` ${failures.length} input(s) failed (see the log / OUTPUT).`;
    if (stats.offersFailed) status += ` Offers failed for ${stats.offersFailed} hotel(s).`;
    if (limitReached) status += ' Stopped at your maximum cost per run.';
    log.info(status);
    await client.close();
    await Actor.exit({ statusMessage: status });
} catch (err) {
    await client?.close().catch(() => {});
    const msg = err instanceof InputError ? `Invalid input: ${err.message}` : err.message;
    log.error(msg);
    await Actor.fail(msg);
}
