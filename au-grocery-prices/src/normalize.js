// Turns Coles and Woolworths product objects into one unified record.
//
// Coles field names are verified from real `__NEXT_DATA__` captures (abhinav-pandey29/coles-scraper tests/assets)
// and Javex/hotprices-au (coles.py get_canonical). Woolworths field names are verified from
// 2scraper/woolworths-scraper product_parser.py (measured 2026-09-16) and Javex/hotprices-au (woolies.py).

export const COLES_BASE_URL = 'https://www.coles.com.au';
export const WOOLWORTHS_BASE_URL = 'https://www.woolworths.com.au';
export const COLES_IMAGE_BASE = 'https://productimages.coles.com.au/productimages';

const num = (v) => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const text = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return s && s.toLowerCase() !== 'none' && s.toLowerCase() !== 'null' ? s : null;
};
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Canonical Coles product URL: /product/{brand-name-size}-{id} (e.g. /product/appy-fizz-250ml-8060378). */
export function colesProductUrl(p) {
    const words = [p.brand, p.name, p.size].filter(Boolean).join(' ');
    const slug = slugify(words);
    return `${COLES_BASE_URL}/product/${slug ? `${slug}-` : ''}${p.id}`;
}

/** True for Coles grid entries that are not products (banner/ad tiles). */
export function isColesAdTile(item) {
    return !item || item._type !== 'PRODUCT' || item.id === undefined || item.id === null;
}

/**
 * Coles product (search/browse result or product page object) → unified record.
 * Notes: `name` excludes the brand on Coles ("Cheese Shredded Tasty Light" + brand "Coles"); we prefix it.
 * `pricing` is null for unavailable products. `pricing.was` is 0 when there is no was-price.
 * onlineHeirs: `subCategory` is the TOP level, then `category`, then `aisle` (see hotprices-au comment).
 */
export function normalizeColes(item, ctx = {}) {
    const pricing = item.pricing ?? null;
    const price = num(pricing?.now);
    const wasRaw = num(pricing?.was);
    const wasPrice = wasRaw && price !== null && wasRaw > price ? wasRaw : null;
    const unit = pricing?.unit ?? {};
    const promotionType = pricing?.promotionType ?? null;
    const isOnSpecial = Boolean(wasPrice) || promotionType === 'SPECIAL' || pricing?.onlineSpecial === true
        || Boolean(pricing?.multiBuyPromotion);
    const brand = text(item.brand);
    const baseName = text(item.name) ?? text(item.description);
    const name = brand && baseName && !baseName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${baseName}` : baseName;
    const heir = Array.isArray(item.onlineHeirs) ? item.onlineHeirs[0] : null;
    const category = heir ? [heir.subCategory, heir.category, heir.aisle].map(text).filter(Boolean).join(' > ') || null : null;
    const img = Array.isArray(item.imageUris) && item.imageUris[0]?.uri ? item.imageUris[0].uri : null;
    const promoParts = [
        text(pricing?.multiBuyPromotion?.reward) ?? null,
        text(pricing?.offerDescription),
        text(pricing?.saveStatement),
        text(pricing?.priceDescription),
    ].filter(Boolean);
    const unitMeasure = unit.ofMeasureUnits ? `${unit.ofMeasureQuantity ?? 1}${unit.ofMeasureUnits}` : null;
    return {
        store: 'coles',
        productId: String(item.id),
        name,
        brand,
        size: text(item.size),
        price,
        wasPrice,
        savings: wasPrice ? round2(wasPrice - price) : (num(pricing?.saveAmount) || null),
        unitPrice: num(unit.price),
        unitPriceMeasure: unitMeasure,
        unitPriceText: text(pricing?.comparable),
        isOnSpecial,
        promoType: promotionType,
        promoText: promoParts.length ? [...new Set(promoParts)].join(' · ') : null,
        inStock: pricing !== null && item.availability !== false,
        isSponsored: Boolean(item.adId),
        category,
        barcode: null,
        imageUrl: img ? `${COLES_IMAGE_BASE}${img.startsWith('/') ? '' : '/'}${img}` : null,
        url: colesProductUrl({ ...item, brand, name: text(item.name), size: text(item.size) }),
        currency: 'AUD',
        searchTerm: ctx.searchTerm ?? null,
        categoryUrl: ctx.categoryUrl ?? null,
        scrapedAt: ctx.scrapedAt ?? new Date().toISOString(),
        ...(ctx.includeRaw ? { raw: item } : {}),
    };
}

/** Woolworths search/browse responses wrap products: {Products|Bundles: [{Products: [...]}, ...]}. */
export function flattenWoolworths(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload.filter((p) => p && typeof p === 'object' && 'Stockcode' in p);
    if (payload.Product && typeof payload.Product === 'object') return [payload.Product];
    if ('Stockcode' in payload) return [payload];
    const groups = Array.isArray(payload.Products) ? payload.Products : Array.isArray(payload.Bundles) ? payload.Bundles : [];
    const out = [];
    for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        if (Array.isArray(g.Products)) out.push(...g.Products.filter((p) => p && typeof p === 'object'));
        else if ('Stockcode' in g) out.push(g);
    }
    return out;
}

const attr = (node, key) => text(node?.AdditionalAttributes?.[key]);
const attrList = (node, key) => {
    const v = node?.AdditionalAttributes?.[key];
    if (!v) return [];
    try {
        const arr = JSON.parse(v);
        return Array.isArray(arr) ? arr.map(text).filter(Boolean) : [];
    } catch {
        return [];
    }
};

/**
 * Woolworths product → unified record.
 * `WasPrice` is filled on every row and equals `Price` when there is no discount (measured by 2scraper),
 * so it only counts as a was-price when greater than `Price`.
 */
export function normalizeWoolworths(node, ctx = {}) {
    const price = num(node.Price);
    const wasRaw = num(node.WasPrice);
    const wasPrice = wasRaw !== null && price !== null && wasRaw > price ? wasRaw : null;
    const savings = wasPrice ? round2(wasPrice - price) : null;
    const isHalfPrice = node.IsHalfPrice === true;
    const isOnSpecial = node.IsOnSpecial === true || Boolean(wasPrice) || isHalfPrice;
    const promoParts = [];
    if (isHalfPrice) promoParts.push('Half price');
    const tag = text(node.CentreTag?.TagContent) ?? text(node.HeaderTag?.Content);
    if (tag) promoParts.push(tag);
    if (savings) promoParts.push(`Save $${savings.toFixed(2)}`);
    const pies = [
        attrList(node, 'piesdepartmentnamesjson')[0],
        attrList(node, 'piescategorynamesjson')[0],
        attrList(node, 'piessubcategorynamesjson')[0],
    ].filter(Boolean);
    const sap = [attr(node, 'sapdepartmentname'), attr(node, 'sapcategoryname'), attr(node, 'sapsubcategoryname')].filter(Boolean);
    const slug = text(node.UrlFriendlyName);
    const code = String(node.Stockcode);
    const inStock = node.IsInStock ?? node.IsAvailable;
    return {
        store: 'woolworths',
        productId: code,
        name: text(node.DisplayName) ?? text(node.Name),
        brand: text(node.Brand),
        size: text(node.PackageSize),
        price,
        wasPrice,
        savings,
        unitPrice: num(node.CupPrice),
        unitPriceMeasure: text(node.CupMeasure),
        unitPriceText: text(node.CupString),
        isOnSpecial,
        promoType: isHalfPrice ? 'HALF_PRICE' : isOnSpecial ? 'SPECIAL' : null,
        promoText: promoParts.length ? [...new Set(promoParts)].join(' · ') : null,
        inStock: inStock === undefined || inStock === null ? null : Boolean(inStock),
        isSponsored: node.IsSponsoredAd === true,
        category: (pies.length ? pies : sap).join(' > ') || null,
        barcode: text(node.Barcode),
        imageUrl: text(node.LargeImageFile) ?? text(node.MediumImageFile) ?? text(node.SmallImageFile),
        url: `${WOOLWORTHS_BASE_URL}/shop/productdetails/${code}${slug ? `/${slug}` : ''}`,
        currency: 'AUD',
        searchTerm: ctx.searchTerm ?? null,
        categoryUrl: ctx.categoryUrl ?? null,
        scrapedAt: ctx.scrapedAt ?? new Date().toISOString(),
        ...(ctx.includeRaw ? { raw: node } : {}),
    };
}
