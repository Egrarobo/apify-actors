import { portalUrl } from './api.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : v == null || v === '' ? null : typeof v === 'object' ? null : String(v));
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** Union of arrays of objects by `id`; later arrays override earlier entries field by field. */
function unionById(...lists) {
    const byId = new Map();
    const noId = [];
    for (const list of lists) {
        for (const x of arr(list)) {
            if (!isObj(x)) continue;
            if (x.id === undefined || x.id === null) {
                noId.push(x);
                continue;
            }
            const k = String(x.id);
            byId.set(k, byId.has(k) ? { ...byId.get(k), ...x } : x);
        }
    }
    return [...byId.values(), ...noId];
}

const money = (v) => (isObj(v) && num(v.amount) !== null ? { amount: num(v.amount), currency: str(v.currency) } : null);

/** Registration number (IDNO, 13 digits in Moldova) from "MD-IDNO-1003600012345" or an identifier object. */
export function extractIdno(...candidates) {
    for (const c of candidates) {
        const s = isObj(c) ? `${c.scheme ?? ''}-${c.id ?? ''}` : String(c ?? '');
        const m = s.match(/\d{13}/) ?? s.match(/\d{7,}/);
        if (m) return m[0];
    }
    return null;
}

/** Human-readable place from an OCDS / MTender address (addressDetails holds region & locality). */
function placeText(address) {
    if (!isObj(address)) return null;
    const d = address.addressDetails ?? {};
    const parts = [
        str(address.streetAddress),
        str(d.locality?.description) ?? str(address.locality),
        str(d.region?.description) ?? str(address.region),
        str(d.country?.description) ?? str(address.countryName),
    ].filter(Boolean);
    return parts.length ? [...new Set(parts)].join(', ') : null;
}

const period = (p) => (isObj(p) ? { start: str(p.startDate), end: str(p.endDate) } : { start: null, end: null });

function ocidTimestamp(ocid) {
    const m = String(ocid).match(/-(\d{12,14})$/);
    if (!m) return null;
    const t = Number(m[1]);
    // Plausible range: 2016..2100
    return t > 1.45e12 && t < 4.1e12 ? new Date(t).toISOString() : null;
}

function stageCode(ocid, mainOcid) {
    const rest = String(ocid).slice(mainOcid.length + 1);
    const m = rest.match(/^([A-Z]{2,4})-/);
    return m ? m[1] : null;
}

function mapDocument(d) {
    return {
        id: str(d.id),
        title: str(d.title),
        type: str(d.documentType),
        url: str(d.url),
        datePublished: str(d.datePublished),
        relatedLots: arr(d.relatedLots).map(String),
    };
}

/**
 * Turns MTender's record package for one contracting process into one flat, English-keyed tender.
 *
 * MTender splits a process into several records (see docs): the record whose ocid equals the requested
 * one is the contracting process (title, value, method, CPV, buyer, overall status); stage records
 * ("…-PN-…", "…-EV-…", "…-AC-…") carry lots, items, documents, periods, awards and contracts.
 */
export function normalizeTender(pkg, requestedOcid, { includeRaw = false } = {}) {
    const records = arr(pkg?.records)
        .map((r) => ({ ocid: str(r?.ocid) ?? str(r?.compiledRelease?.ocid), cr: r?.compiledRelease }))
        .filter((r) => isObj(r.cr));
    if (!records.length) return null;

    const main = records.find((r) => r.ocid === requestedOcid)
        ?? records.find((r) => arr(r.cr.tag).includes('compiled') && !String(r.ocid).startsWith(`${requestedOcid}-`))
        ?? records[0];
    const mainOcid = requestedOcid ?? main.ocid;
    let stages = records.filter((r) => r !== main && String(r.ocid).startsWith(`${mainOcid}-`));
    if (!stages.length) {
        // Unknown layout: use any other record that carries tender details.
        stages = records.filter((r) => r !== main && !/-FS-/.test(r.ocid ?? '')
            && (arr(r.cr.tender?.lots).length || arr(r.cr.tender?.items).length || arr(r.cr.awards).length || arr(r.cr.contracts).length));
    }
    stages.sort((a, b) => String(a.cr.date ?? '').localeCompare(String(b.cr.date ?? '')));
    const all = [main, ...stages];
    const mt = main.cr.tender ?? {};
    const latestWith = (fn) => {
        for (let i = stages.length - 1; i >= 0; i--) {
            const v = fn(stages[i].cr);
            if (v !== undefined && v !== null) return v;
        }
        return fn(main.cr) ?? null;
    };
    const firstOf = (fn) => {
        const v = fn(main.cr);
        if (v !== undefined && v !== null && v !== '') return v;
        return latestWith(fn);
    };

    const parties = unionById(...all.map((r) => r.cr.parties));
    const partyWithRole = (...roles) => parties.find((p) => arr(p.roles).some((x) => roles.includes(x)));

    // Buyer / procuring entity
    const peRef = firstOf((cr) => cr.tender?.procuringEntity) ?? firstOf((cr) => cr.buyer);
    const peParty = (peRef?.id && parties.find((p) => p.id === peRef.id)) || partyWithRole('procuringEntity', 'buyer');
    const buyer = {
        name: str(peRef?.name) ?? str(peParty?.name),
        id: str(peRef?.id) ?? str(peParty?.id),
        idno: extractIdno(peParty?.identifier, peRef?.id, peParty?.id),
        address: placeText(peParty?.address),
        contactEmail: str(peParty?.contactPoint?.email),
        contactPhone: str(peParty?.contactPoint?.telephone),
    };

    // Lots, items, documents
    const lotsRaw = unionById(...all.map((r) => r.cr.tender?.lots));
    const itemsRaw = unionById(...all.map((r) => r.cr.tender?.items));
    const docsRaw = unionById(...all.map((r) => r.cr.tender?.documents));

    const items = itemsRaw.map((it) => ({
        id: str(it.id),
        description: str(it.description),
        cpv: str(it.classification?.id),
        cpvDescription: str(it.classification?.description),
        quantity: num(it.quantity),
        unit: str(it.unit?.name) ?? str(it.unit?.id),
        relatedLot: str(it.relatedLot),
        deliveryPlace: placeText(it.deliveryAddress),
    }));

    const lots = lotsRaw.map((l) => {
        const v = money(l.value);
        const cp = period(l.contractPeriod);
        const lotItems = items.filter((i) => i.relatedLot && i.relatedLot === str(l.id));
        return {
            id: str(l.id),
            title: str(l.title),
            description: str(l.description),
            status: str(l.status),
            statusDetails: str(l.statusDetails),
            value: v?.amount ?? null,
            currency: v?.currency ?? null,
            cpv: lotItems.map((i) => i.cpv).filter(Boolean)[0] ?? null,
            contractPeriodStart: cp.start,
            contractPeriodEnd: cp.end,
            placeOfPerformance: placeText(l.placeOfPerformance?.address),
        };
    });

    // Awards & contracts (all records)
    const awards = unionById(...all.map((r) => r.cr.awards)).map((a) => {
        const v = money(a.value);
        return {
            id: str(a.id),
            status: str(a.status),
            statusDetails: str(a.statusDetails),
            date: str(a.date),
            value: v?.amount ?? null,
            currency: v?.currency ?? null,
            suppliers: arr(a.suppliers).map((s) => ({ name: str(s?.name), id: str(s?.id), idno: extractIdno(s?.id, parties.find((p) => p.id === s?.id)?.identifier) })),
            relatedLots: arr(a.relatedLots).map(String),
            description: str(a.description) ?? str(a.title),
        };
    });
    const contracts = unionById(...all.map((r) => r.cr.contracts)).map((c) => {
        const v = money(c.value);
        const p = period(c.period);
        return {
            id: str(c.id),
            awardId: str(c.awardID ?? c.awardId),
            title: str(c.title),
            status: str(c.status),
            statusDetails: str(c.statusDetails),
            value: v?.amount ?? null,
            currency: v?.currency ?? null,
            dateSigned: str(c.dateSigned),
            periodStart: p.start,
            periodEnd: p.end,
        };
    });
    const activeAwards = awards.filter((a) => a.status === 'active');
    const suppliers = [...new Set(activeAwards.flatMap((a) => a.suppliers.map((s) => s.name)).filter(Boolean))];
    const awardCurrencies = [...new Set(activeAwards.filter((a) => a.value !== null).map((a) => a.currency))];
    const awardedValue = activeAwards.some((a) => a.value !== null) && awardCurrencies.length === 1
        ? Math.round(activeAwards.reduce((s, a) => s + (a.value ?? 0), 0) * 100) / 100
        : null;

    // Value: process value, else planned budget, else sum of lots
    let value = money(mt.value) ?? money(main.cr.planning?.budget?.amount) ?? latestWith((cr) => money(cr.tender?.value));
    if (!value && lots.some((l) => l.value !== null)) {
        const cur = [...new Set(lots.map((l) => l.currency).filter(Boolean))];
        if (cur.length <= 1) value = { amount: Math.round(lots.reduce((s, l) => s + (l.value ?? 0), 0) * 100) / 100, currency: cur[0] ?? null };
    }

    const classification = firstOf((cr) => (isObj(cr.tender?.classification) ? cr.tender.classification : null));
    const cpvCodes = [...new Set([str(classification?.id), ...items.map((i) => i.cpv)].filter(Boolean))];

    const tenderPeriod = period(latestWith((cr) => cr.tender?.tenderPeriod));
    const enquiryPeriod = period(latestWith((cr) => cr.tender?.enquiryPeriod));
    const auctionPeriod = period(latestWith((cr) => cr.tender?.auctionPeriod));
    const awardPeriod = period(latestWith((cr) => cr.tender?.awardPeriod));

    const bidDetails = latestWith((cr) => (Array.isArray(cr.bids?.details) ? cr.bids.details : null));
    const dates = all.map((r) => str(r.cr.date)).filter(Boolean).sort();
    const created = ocidTimestamp(mainOcid);

    const tender = {
        ocid: mainOcid,
        url: portalUrl(mainOcid),
        title: str(mt.title) ?? latestWith((cr) => str(cr.tender?.title)),
        description: str(mt.description) ?? latestWith((cr) => str(cr.tender?.description)),
        buyer: buyer.name,
        buyerIdno: buyer.idno,
        buyerId: buyer.id,
        buyerAddress: buyer.address,
        buyerEmail: buyer.contactEmail,
        buyerPhone: buyer.contactPhone,
        status: str(mt.status) ?? latestWith((cr) => str(cr.tender?.status)),
        statusDetails: str(mt.statusDetails) ?? latestWith((cr) => str(cr.tender?.statusDetails)),
        stageStatus: latestWith((cr) => str(cr.tender?.statusDetails)) ?? null,
        method: firstOf((cr) => str(cr.tender?.procurementMethod)),
        methodDetails: firstOf((cr) => str(cr.tender?.procurementMethodDetails)),
        category: firstOf((cr) => str(cr.tender?.mainProcurementCategory)),
        cpv: str(classification?.id),
        cpvDescription: str(classification?.description),
        cpvCodes,
        value: value?.amount ?? null,
        currency: value?.currency ?? null,
        // Publication date: OCDS tender.datePublished if present; for a contract notice the start of the bidding
        // period; for plans (whose tenderPeriod.startDate is a future planned date) the creation time from the OCID.
        datePublished: firstOf((cr) => str(cr.tender?.datePublished))
            ?? (['planning', 'planned'].includes(str(mt.status)) ? created ?? tenderPeriod.start : tenderPeriod.start ?? created),
        dateCreated: created,
        dateModified: dates[dates.length - 1] ?? null,
        tenderPeriodStart: tenderPeriod.start,
        tenderPeriodEnd: tenderPeriod.end,
        enquiryPeriodStart: enquiryPeriod.start,
        enquiryPeriodEnd: enquiryPeriod.end,
        auctionPeriodStart: auctionPeriod.start,
        awardPeriodEnd: awardPeriod.end,
        hasElectronicAuction: arr(latestWith((cr) => cr.tender?.procurementMethodModalities)).includes('electronicAuction') || !!latestWith((cr) => cr.tender?.electronicAuctions),
        lotsCount: lots.length,
        lots,
        items,
        documents: docsRaw.map(mapDocument),
        bidsCount: bidDetails ? bidDetails.length : null,
        awards,
        contracts,
        suppliers,
        awardedValue,
        awardedCurrency: awardedValue !== null ? awardCurrencies[0] : null,
        stages: [...new Set(stages.map((s) => stageCode(s.ocid, mainOcid)).filter(Boolean))],
        apiUrl: null, // filled by caller (depends on the API base URL)
    };
    if (includeRaw) tender.raw = pkg;
    return tender;
}
