// Turns Tesco xapi GraphQL product nodes into the unified record.
//
// Field names verified from open-source code (anonymous reads of https://xapi.tesco.com/):
//  - jonnyreeves/basketeer src/queries.ts + src/parsers.ts (UK, July 2026): tpnc (the id in product URLs), tpnb, title,
//    brandName, defaultImageUrl, isForSale, productType, averageWeight, bulkBuyLimit; in search/category results the
//    price and promotions are under sellers.results[0] { price { actual unitPrice unitOfMeasure }, promotions
//    [{ description, startDate, endDate, attributes, price { afterDiscount beforeDiscount } }] }; on product(tpnc)
//    they are on the product itself, plus details { packSize [{ value, units }] }. Clubcard Prices are promotions
//    with attributes ["CLUBCARD_PRICING"] and a description like "£2.25 Clubcard Price".
//  - abracadabra50/open-supermarkets src/providers/tesco-hu/api.ts (same xapi, Sep 2026): gtin, superDepartmentName,
//    departmentName, aisleName, shelfName (requested in the "full" field set only; see store.js).

export const SITE_URL = 'https://www.tesco.com';
export const API_URL = 'https://xapi.tesco.com';

const text = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ').trim();
    return s && s.toLowerCase() !== 'null' ? s : null;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null));
const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

/** "£2.25 Clubcard Price" → 2.25; "80p Clubcard Price" → 0.8 */
export function moneyIn(s) {
    const t = text(s);
    if (!t) return null;
    const pounds = t.match(/£\s*(\d+(?:\.\d{1,2})?)/);
    if (pounds) return Number(pounds[1]);
    const pence = t.match(/(?:^|\s)(\d{1,3})p\b/i);
    return pence ? round2(Number(pence[1]) / 100) : null;
}

/** Pack size from the title when the API gives none: "Tesco Semi Skimmed Milk 2.272L, 4 Pints" → "2.272L". */
export function sizeFromTitle(title) {
    const t = text(title);
    if (!t) return null;
    const m = t.match(/(\d+\s*x\s*)?\d+(?:\.\d+)?\s?(?:kg|g|ml|cl|l|litre|litres|ltr)\b(?:\s*,\s*\d+\s*pints?)?/i)
        ?? t.match(/\b\d+\s?(?:pack|pk|pieces|sheets|rolls|capsules|tablets|pods|bags)\b/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

const UOM = { litre: 'litre', l: 'litre', kg: 'kg', each: 'each', ea: 'each', '100g': '100g', '100ml': '100ml', '75cl': '75cl', sht: 'sheet' };

export function sellerOf(node) {
    const s = node?.sellers?.results;
    return Array.isArray(s) && s.length ? s[0] ?? {} : {};
}

export function productUrl(tpnc) {
    return `${SITE_URL}/shop/en-GB/products/${tpnc}`;
}

/**
 * Tesco product node (search / category / product) → unified record.
 * ctx: { searchTerm, categoryUrl, scrapedAt, includeRaw }
 */
export function normalizeTesco(node, ctx = {}) {
    const seller = sellerOf(node);
    const priceObj = node.price ?? seller.price ?? {};
    const promos = (Array.isArray(node.promotions) ? node.promotions : Array.isArray(seller.promotions) ? seller.promotions : []).filter(Boolean);
    const price = num(priceObj.actual);
    const unitPrice = num(priceObj.unitPrice);
    const uom = text(priceObj.unitOfMeasure);

    let loyaltyPrice = null;
    let wasPrice = null;
    const promoTypes = [];
    for (const p of promos) {
        const attrs = (Array.isArray(p.attributes) ? p.attributes : []).map(String);
        const desc = text(p.description) ?? '';
        const after = num(p.price?.afterDiscount);
        const before = num(p.price?.beforeDiscount);
        if (attrs.includes('CLUBCARD_PRICING') || /clubcard price/i.test(desc)) {
            // "Any 3 for £10 Clubcard Price" is a multibuy: £10 is not a per-item price.
            const multi = /\bany\s+\d+|\b\d+\s+for\s+£/i.test(desc);
            promoTypes.push(multi ? 'CLUBCARD_MULTIBUY' : 'CLUBCARD_PRICE');
            const afterOk = after !== null && price !== null && after < price ? after : null;
            const cc = multi ? afterOk : moneyIn(desc) ?? afterOk;
            if (cc !== null && (loyaltyPrice === null || cc < loyaltyPrice)) loyaltyPrice = cc;
            continue;
        }
        const was = before !== null && price !== null && before > price ? before : (() => {
            const m = desc.match(/was\s*£\s*(\d+(?:\.\d{1,2})?)/i);
            return m && price !== null && Number(m[1]) > price ? Number(m[1]) : null;
        })();
        if (was !== null) {
            wasPrice = Math.max(wasPrice ?? 0, was);
            promoTypes.push('PRICE_CUT');
        } else if (/\bany\s+\d|\d+\s+for\s+£|buy\s+\d|\bmeal deal/i.test(desc)) {
            promoTypes.push('MULTIBUY');
        } else {
            promoTypes.push('OFFER');
        }
    }
    const promoText = [...new Set(promos.map((p) => text(p.description)).filter(Boolean))].join(' · ') || null;
    const endDates = promos.map((p) => text(p.endDate)).filter(Boolean).sort();
    const packSize = Array.isArray(node.details?.packSize) ? node.details.packSize[0] : node.details?.packSize;
    const size = packSize?.value && packSize?.units ? `${packSize.value}${String(packSize.units).toLowerCase()}` : sizeFromTitle(node.title);
    const cats = [node.superDepartmentName, node.departmentName, node.aisleName, node.shelfName].map(text).filter(Boolean);
    const tpnc = String(node.tpnc ?? node.id ?? '');
    return {
        store: 'tesco',
        productId: tpnc,
        tpnb: node.tpnb === undefined || node.tpnb === null ? null : String(node.tpnb),
        gtin: text(node.gtin),
        name: text(node.title),
        brand: text(node.brandName),
        size,
        price,
        wasPrice,
        savings: wasPrice !== null && price !== null ? round2(wasPrice - price) : null,
        unitPrice,
        unitPriceMeasure: uom ? (UOM[uom.toLowerCase()] ?? uom) : null,
        unitPriceText: unitPrice !== null && uom ? `£${unitPrice.toFixed(2)}/${UOM[uom.toLowerCase()] ?? uom}` : null,
        loyaltyPrice,
        isOnSpecial: promos.length > 0,
        promoType: promoTypes.length ? [...new Set(promoTypes)].join(',') : null,
        promoText,
        promoEndDate: endDates[0] ?? null,
        inStock: typeof node.isForSale === 'boolean' ? node.isForSale : null,
        category: cats.length ? cats.join(' > ') : null,
        imageUrl: text(node.defaultImageUrl),
        url: productUrl(tpnc),
        currency: 'GBP',
        searchTerm: ctx.searchTerm ?? null,
        categoryUrl: ctx.categoryUrl ?? null,
        scrapedAt: ctx.scrapedAt ?? new Date().toISOString(),
        ...(ctx.includeRaw ? { raw: node } : {}),
    };
}
