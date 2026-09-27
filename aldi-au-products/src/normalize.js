// Turns ALDI Australia product objects (api.aldi.com.au /v3/product-search and /v2/products) into the unified record.
//
// Field names are verified from open-source code for the same ALDI SÜD API platform (ALDI AU belongs to ALDI SÜD):
//  - ByteSizedMarius/aldiscount pkg/product_structs.go (api.aldi-sued.de, Aug 2026): sku, name (WITHOUT brand),
//    brandName, urlSlugText, sellingSize, discontinued, notForSale ("true for most walk-in offers; does not mean
//    unavailable"), onSaleDateDisplay, price {amount, amountRelevant (what is charged; differs for weight-priced
//    goods — prefer it), amountRelevantDisplay, comparison, comparisonDisplay, wasPriceDisplay (set only while
//    discounted), savingsDisplay, currencyCode}, categories [{id, name, urlSlugText}] broadest → narrowest,
//    assets [{url with {width}/{slug} placeholders, maxWidth, assetType "FR01" = front of pack}], badges
//    [{position, items: [{displayText}]}]. Amounts are integer cents.
//  - nicktcode/swissgroceries-mcp tests/fixtures/aldi/search-milch.json: a real captured response (api.aldi-suisse.ch).
// ALDI AU specifics verified on www.aldi.com.au (2026-09-27): product page URL = /product/{urlSlugText}-{sku}
// (e.g. /product/lodge-farms-cage-eggs-700g-000000000000399451 — the slug includes the brand), unit prices shown as
// "$0.71 per 100g", Special Buys badge "While Stocks Last".

export const SITE_URL = 'https://www.aldi.com.au';
export const API_URL = 'https://api.aldi.com.au';

const text = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;| /g, ' ')
        .replace(/\s+/g, ' ').trim();
    return s && s.toLowerCase() !== 'null' ? s : null;
};
const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const cents = (v) => (typeof v === 'number' && Number.isFinite(v) ? round2(v / 100) : null);
/** "$3.99", "AUD 3.99", "3,99 €" → 3.99 */
export const moneyFrom = (s) => {
    const t = text(s);
    if (!t) return null;
    const m = t.replace(/,(\d{2})(?!\d)/, '.$1').match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
};

/** Canonical 18-digit ALDI SKU ("399451" → "000000000000399451"). */
export const padSku = (s) => String(s).replace(/\D/g, '').padStart(18, '0');

export function imageUrlOf(p, width = 600) {
    const assets = Array.isArray(p.assets) ? p.assets : [];
    const a = assets.find((x) => x?.assetType === 'FR01') ?? assets[0];
    if (!a?.url) return null;
    const w = a.maxWidth && width > a.maxWidth ? a.maxWidth : width;
    // aldiscount: "The CDN serves identical bytes with any slug or none."
    return String(a.url).replaceAll('{width}', String(w)).replaceAll('{slug}', '').replace(/\/+$/, '');
}

export function badgesOf(p) {
    const out = [];
    for (const b of Array.isArray(p.badges) ? p.badges : []) {
        for (const it of Array.isArray(b?.items) ? b.items : []) {
            const t = text(it?.displayText);
            if (t && !out.includes(t)) out.push(t);
        }
    }
    return out;
}

const SPECIAL_BADGE = /special buy|super saver|price drop|lower price|save|was |reduced|half price|clearance|limited time/i;
const LIST_PROMO = { 'special-buys': 'SPECIAL_BUY', 'super-savers': 'SUPER_SAVER', 'lower-prices': 'LOWER_PRICE', 'limited-time-only': 'LIMITED_TIME' };

export function productUrl(p) {
    const sku = String(p.sku ?? '');
    const slug = text(p.urlSlugText);
    return `${SITE_URL}/product/${slug ? `${slug}-` : ''}${sku}`;
}

/**
 * ALDI product → unified record.
 * ctx: { searchTerm, categoryUrl, listType ('special-buys' | 'super-savers' | 'lower-prices' | ...), scrapedAt, includeRaw }
 */
export function normalizeAldi(p, ctx = {}) {
    const pr = p.price ?? {};
    const price = cents(pr.amountRelevant ?? pr.amount);
    const wasRaw = moneyFrom(pr.wasPriceDisplay);
    const wasPrice = wasRaw !== null && price !== null && wasRaw > price ? wasRaw : null;
    const badges = badgesOf(p);
    const onSaleFrom = text(p.onSaleDateDisplay);
    const listPromo = LIST_PROMO[ctx.listType] ?? null;
    const badgePromo = badges.some((b) => SPECIAL_BADGE.test(b));
    const promoType = wasPrice ? 'PRICE_DROP' : listPromo ?? (onSaleFrom ? 'SPECIAL_BUY' : badgePromo ? 'PROMOTION' : null);
    const isOnSpecial = promoType !== null && promoType !== 'LIMITED_TIME' ? true : Boolean(wasPrice);
    const promoParts = [
        ...badges,
        text(pr.savingsDisplay) ? `Save ${text(pr.savingsDisplay)}` : null,
        wasPrice ? `Was $${wasPrice.toFixed(2)}` : null,
        onSaleFrom,
    ].filter(Boolean);
    const brand = text(p.brandName);
    const baseName = text(p.name);
    const name = brand && baseName && !baseName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${baseName}` : baseName;
    const unitText = text(pr.comparisonDisplay) ?? text(pr.perUnitDisplay);
    const cats = (Array.isArray(p.categories) ? p.categories : []).map((c) => text(c?.name)).filter(Boolean);
    return {
        store: 'aldi',
        productId: String(p.sku),
        name,
        brand,
        size: text(p.sellingSize),
        price,
        wasPrice,
        savings: wasPrice ? round2(wasPrice - price) : null,
        unitPrice: cents(pr.comparison),
        unitPriceMeasure: unitText?.match(/(?:per|\/)\s*(.+)$/i)?.[1]?.trim() ?? null,
        unitPriceText: unitText,
        loyaltyPrice: null,
        isOnSpecial,
        promoType,
        promoText: promoParts.length ? [...new Set(promoParts)].join(' · ') : null,
        availableFrom: onSaleFrom,
        // Walk-in catalogue: ALDI AU does not sell groceries online, so there is no online stock level. Only
        // discontinued products are marked unavailable ("notForSale" is true for most walk-in offers — aldiscount).
        inStock: p.discontinued === true ? false : true,
        category: cats.length ? cats.join(' > ') : null,
        badges,
        imageUrl: imageUrlOf(p),
        url: productUrl(p),
        currency: text(pr.currencyCode) ?? 'AUD',
        searchTerm: ctx.searchTerm ?? null,
        categoryUrl: ctx.categoryUrl ?? null,
        scrapedAt: ctx.scrapedAt ?? new Date().toISOString(),
        ...(ctx.includeRaw ? { raw: p } : {}),
    };
}
