/**
 * Turns a raw Prozorro.Sale procedure (Ukrainian-first language maps, nested periods, family-specific
 * organisation blocks) into one flat, English-keyed record, and evaluates search filters on it.
 */

export const PUBLIC_PAGE = 'https://prozorro.sale/auction/';

export const STATUS_TEXT = {
    active_rectification: 'Published, terms may still be amended (bids not yet accepted)',
    active_tendering: 'Open for bids',
    active_auction: 'Auction in progress',
    active_qualification: 'Auction finished, winner being verified',
    qualification: 'Qualification of bidders',
    active_awarded: 'Winner confirmed, contract pending',
    pending_payment: 'Winner confirmed, awaiting payment',
    pending_admission: 'Awaiting admission',
    complete: 'Completed (sold / leased)',
    unsuccessful: 'Unsuccessful (no bids or no qualified winner)',
    cancelled: 'Cancelled by the organizer',
};

export const OPEN_FOR_BIDS = new Set(['active_rectification', 'active_tendering']);
const MASKED = /^[\s*]+$/;

/** Ukrainian text of a language map (falls back to English); masked personal data becomes "[redacted]". */
export function uk(v) {
    return pickLang(v, 'uk_UA', 'en_US');
}
export function en(v) {
    if (!v || typeof v !== 'object') return null;
    return pickLang({ en_US: v.en_US }, 'en_US');
}
function pickLang(v, first, second) {
    if (v === undefined || v === null) return null;
    let s = typeof v === 'string' ? v : v[first] ?? (second ? v[second] : undefined);
    if (typeof s !== 'string') return null;
    s = s.trim();
    if (!s || s === '-') return null;
    return MASKED.test(s) ? '[redacted]' : s;
}

const num = (m) => (m && typeof m.amount === 'number' ? m.amount : null);

function org(o) {
    if (!o || typeof o !== 'object' || !Object.keys(o).length) return null;
    const id = o.identifier?.id ?? null;
    const out = {
        name: uk(o.name) ?? uk(o.identifier?.legalName),
        edrpou: id && MASKED.test(id) ? '[redacted]' : id,
        region: uk(o.address?.region),
        city: uk(o.address?.locality),
        address: uk(o.address?.streetAddress),
        email: o.contactPoint?.email && !MASKED.test(o.contactPoint.email) ? o.contactPoint.email : null,
        phone: o.contactPoint?.telephone && !MASKED.test(o.contactPoint.telephone) ? o.contactPoint.telephone : null,
        contactName: uk(o.contactPoint?.name),
    };
    return Object.values(out).some((x) => x !== null) ? out : null;
}

/** Who runs the auction: top-level sellingEntity, or relatedOrganizations.sellingEntity on lease procedures. */
export function sellerOf(p) {
    const top = p.sellingEntity && Object.keys(p.sellingEntity).length ? p.sellingEntity : null;
    return top ?? p.relatedOrganizations?.sellingEntity ?? null;
}

function classification(c) {
    if (!c?.id) return null;
    return { code: c.id, scheme: c.scheme ?? null, description: uk(c.description) };
}

function item(it) {
    return {
        id: it.id ?? null,
        description: uk(it.description),
        descriptionEn: en(it.description),
        classification: classification(it.classification),
        additionalClassifications: (it.additionalClassifications ?? []).map(classification).filter(Boolean),
        quantity: typeof it.quantity === 'number' ? it.quantity : null,
        unit: uk(it.unit?.name) ?? it.unit?.code ?? null,
        region: uk(it.address?.region),
        city: uk(it.address?.locality),
        address: uk(it.address?.streetAddress),
        postalCode: it.address?.postalCode ?? null,
        properties: it.itemProps && Object.keys(it.itemProps).length ? it.itemProps : null,
    };
}

function doc(d, of) {
    return {
        title: uk(d.title),
        documentType: d.documentType ?? null,
        documentOf: d.documentOf ?? of,
        format: d.format ?? null,
        url: typeof d.url === 'string' && d.url.startsWith('http') ? d.url : null,
        datePublished: d.datePublished ?? null,
    };
}

const AWARD_WIN = ['active', 'signed', 'pending', 'pending_waiting', 'pending_admission'];

/** Winner and final price, when the auction has reached the award stage. */
function resultOf(p) {
    const awards = p.awards ?? [];
    const contracts = p.contracts ?? [];
    const award = AWARD_WIN.map((s) => awards.find((a) => a.status === s)).find(Boolean) ?? null;
    const contract = contracts.find((c) => c.status === 'active')
        ?? contracts.find((c) => c.status === 'signed')
        ?? contracts.find((c) => c.status === 'pending')
        ?? null;
    const outcome = {
        complete: 'sold',
        unsuccessful: 'no_winner',
        cancelled: 'cancelled',
        active_qualification: 'winner_pending',
        qualification: 'winner_pending',
        active_awarded: 'winner_confirmed',
        pending_payment: 'winner_confirmed',
    }[p.status] ?? 'in_progress';

    const bids = p.bids ?? [];
    const bidValues = bids.map((b) => num(b.value)).filter((v) => v !== null);
    const winnerOrg = org(award?.buyers?.[0] ?? contract?.buyers?.[0]);
    const finalPrice = num(contract?.value) ?? num(award?.value) ?? null;
    const start = num(p.value);
    return {
        outcome,
        bidsCount: bids.length || null,
        highestBid: bidValues.length ? Math.max(...bidValues) : null,
        winnerName: winnerOrg?.name ?? null,
        winnerEdrpou: winnerOrg?.edrpou ?? null,
        finalPrice,
        priceIncreasePercent: finalPrice !== null && start ? Math.round(((finalPrice - start) / start) * 10000) / 100 : null,
        awardStatus: award?.status ?? null,
        contractStatus: contract?.status ?? null,
        contractNumber: contract?.contractNumber ?? null,
        dateSigned: contract?.dateSigned ?? null,
        cancellationReason: uk(p.cancellations?.[0]?.reason),
    };
}

const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined && x !== ''))];

/**
 * Normalized, English-keyed record.
 * @param {object} p raw procedure
 * @param {{ includeItems?: boolean, includeDocuments?: boolean, includeRaw?: boolean }} opts
 */
export function normalizeProcedure(p, opts = {}) {
    const includeItems = opts.includeItems !== false;
    const includeDocuments = opts.includeDocuments !== false;
    const items = (p.items ?? []).map(item);
    const seller = org(sellerOf(p));
    const owner = org(p.relatedOrganizations?.propertyOwner);
    const [family, auctionType] = String(p.sellingMethod ?? '').split(/-(.*)/s);
    const bidding = p.tenderPeriod ?? p.tenderingPeriod ?? p.enquiryPeriod ?? null;
    const regions = uniq(items.map((i) => i.region));
    const cities = uniq(items.map((i) => i.city));

    let documents = null;
    if (includeDocuments) {
        documents = [
            ...(p.documents ?? []).map((d) => doc(d, 'auction')),
            ...(p.awards ?? []).flatMap((a) => (a.documents ?? []).map((d) => doc(d, 'award'))),
            ...(p.contracts ?? []).flatMap((c) => (c.documents ?? []).map((d) => doc(d, 'contract'))),
            ...(p.cancellations ?? []).flatMap((c) => (c.documents ?? []).map((d) => doc(d, 'cancellation'))),
        ];
    }

    const record = {
        auctionId: p.auctionId ?? null,
        procedureId: p._id ?? p.id ?? null,
        url: p.auctionId ? `${PUBLIC_PAGE}${p.auctionId}` : null,
        title: uk(p.title),
        titleEn: en(p.title),
        description: uk(p.description),
        status: p.status ?? null,
        statusText: STATUS_TEXT[p.status] ?? null,
        openForBids: OPEN_FOR_BIDS.has(p.status),
        sellingMethod: p.sellingMethod ?? null,
        procedureType: family || null,
        auctionType: auctionType || null,
        categories: p.metaInfo?.categories ?? null,
        startingPrice: num(p.value),
        currency: p.value?.currency ?? (num(p.value) !== null ? 'UAH' : null),
        vatIncluded: typeof p.value?.valueAddedTaxIncluded === 'boolean' ? p.value.valueAddedTaxIncluded : null,
        minimalStep: num(p.minimalStep),
        guarantee: num(p.guarantee),
        registrationFee: num(p.registrationFee),
        datePublished: p.datePublished ?? null,
        dateModified: p.dateModified ?? null,
        biddingStart: bidding?.startDate ?? null,
        biddingEnd: bidding?.endDate ?? null,
        auctionDate: p.auctionPeriod?.startDate ?? null,
        auctionEndDate: p.auctionPeriod?.endDate ?? null,
        region: regions[0] ?? seller?.region ?? null,
        city: cities[0] ?? seller?.city ?? null,
        regions,
        classificationCodes: uniq(items.map((i) => i.classification?.code)),
        itemsCount: items.length,
        items: includeItems ? items : undefined,
        seller,
        propertyOwner: owner,
        ownershipType: p.relatedOrganizations?.ownershipType ?? null,
        leaseDuration: p.leaseDuration ?? null,
        tenderAttempts: typeof p.tenderAttempts === 'number' ? p.tenderAttempts : null,
        previousAuctionId: p.previousAuctionId ?? null,
        lotId: p.lotId ?? null,
        liveAuctionUrl: p.auctionUrl ?? null,
        documents: documents ?? undefined,
        result: resultOf(p),
    };
    if (opts.includeRaw) record.raw = p;
    return record;
}

/** Lower-cases and strips accents/apostrophe variants so "Київ", "КИЇВ" and "київ" match. */
export function fold(s) {
    return String(s ?? '')
        .toLocaleLowerCase('uk-UA')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[’ʼ'`]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function searchText(p) {
    const parts = [
        p.auctionId, p.lotId,
        p.title?.uk_UA, p.title?.en_US, p.description?.uk_UA, p.description?.en_US,
    ];
    for (const it of p.items ?? []) {
        parts.push(it.description?.uk_UA, it.description?.en_US, it.classification?.description?.uk_UA,
            it.address?.locality?.uk_UA, it.address?.streetAddress?.uk_UA);
    }
    return fold(parts.filter((x) => typeof x === 'string').join(' \n '));
}

const toTime = (s) => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
};

/**
 * Builds a predicate over RAW procedures. All given criteria must match (AND); values inside one list are OR.
 */
export function buildFilter(f) {
    const methods = (f.sellingMethods ?? []).map((m) => m.toLowerCase());
    const statuses = new Set((f.statuses ?? []).map((s) => s.toLowerCase()));
    const regions = (f.regions ?? []).map(fold);
    const codes = (f.classificationCodes ?? []).map((c) => c.trim().toLowerCase());
    const orgCodes = (f.organizerCodes ?? []).map((c) => c.replace(/\D/g, '').padStart(8, '0'));
    const terms = f.keywords ? fold(f.keywords).split(' ').filter(Boolean) : [];
    const pubFrom = f.publishedFrom ? toTime(f.publishedFrom) : null;
    const pubTo = f.publishedTo ? toTime(f.publishedTo) : null;
    const aucFrom = f.auctionDateFrom ? toTime(f.auctionDateFrom) : null;
    const aucTo = f.auctionDateTo ? toTime(f.auctionDateTo) : null;

    return (p) => {
        if (!p || typeof p !== 'object') return false;
        if (methods.length) {
            const sm = String(p.sellingMethod ?? '').toLowerCase();
            if (!methods.some((m) => sm === m || sm.startsWith(`${m}-`))) return false;
        }
        if (statuses.size && !statuses.has(String(p.status ?? '').toLowerCase())) return false;
        if (f.openForBidsOnly && !OPEN_FOR_BIDS.has(p.status)) return false;

        const price = num(p.value);
        if (f.minPrice !== undefined && f.minPrice !== null && (price === null || price < f.minPrice)) return false;
        if (f.maxPrice !== undefined && f.maxPrice !== null && (price === null || price > f.maxPrice)) return false;

        if (pubFrom !== null || pubTo !== null) {
            const t = toTime(p.datePublished);
            if (t === null || (pubFrom !== null && t < pubFrom) || (pubTo !== null && t > pubTo)) return false;
        }
        if (aucFrom !== null || aucTo !== null) {
            const t = toTime(p.auctionPeriod?.startDate);
            if (t === null || (aucFrom !== null && t < aucFrom) || (aucTo !== null && t > aucTo)) return false;
        }
        if (regions.length) {
            // Where the asset is; the organizer's address is used only when no item has an address.
            let places = (p.items ?? []).flatMap((it) => [it.address?.region, it.address?.locality]).map(uk).filter(Boolean);
            if (!places.length) places = [sellerOf(p)?.address?.region, sellerOf(p)?.address?.locality].map(uk).filter(Boolean);
            places = places.map(fold);
            if (!regions.some((r) => places.some((pl) => pl.includes(r)))) return false;
        }
        if (codes.length) {
            const ids = (p.items ?? []).flatMap((it) => [it.classification?.id, ...(it.additionalClassifications ?? []).map((c) => c.id)])
                .filter((x) => typeof x === 'string').map((x) => x.toLowerCase());
            if (!codes.some((c) => ids.some((id) => id.startsWith(c)))) return false;
        }
        if (orgCodes.length) {
            const ids = [sellerOf(p)?.identifier?.id, p.relatedOrganizations?.propertyOwner?.identifier?.id]
                .filter((x) => typeof x === 'string').map((x) => x.replace(/\D/g, '').padStart(8, '0'));
            if (!orgCodes.some((c) => ids.includes(c))) return false;
        }
        if (terms.length) {
            const hay = searchText(p);
            if (!terms.every((t) => hay.includes(t))) return false;
        }
        return true;
    };
}
