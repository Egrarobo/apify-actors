// Builds the committed test fixtures from REAL captures published in open-source repos.
// The generated JSON files are committed; this script only documents (and reproduces) where they come from.
//
//   git clone https://github.com/abhinav-pandey29/coles-scraper      /tmp/src/coles-scraper
//   git clone https://github.com/2scraper/woolworths-scraper          /tmp/src/woolworths-scraper
//   node test/fixtures/build-fixtures.mjs /tmp/src
//
// Coles:  real `__NEXT_DATA__` of https://www.coles.com.au/browse/dairy-eggs-fridge?page=4 (build 20241022.02_v4.26.0)
//         and of a product page, saved by coles-scraper's test suite (tests/assets/*.html). Products are copied verbatim.
// Woolworths: 2scraper/woolworths-scraper sample_output.json (12 real rows captured 2026-09-16), mapped back to the
//         API field names that repo's product_parser.py reads (Stockcode, DisplayName, Price, WasPrice, CupString, ...).
//         The wrapper shapes ({Products:[{Products:[...]}]}, {Bundles:[...]}) follow product_parser.flatten_products.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('Usage: node build-fixtures.mjs <dir with coles-scraper and woolworths-scraper clones>');
const out = (name, data) => writeFileSync(new URL(name, import.meta.url), `${JSON.stringify(data, null, 1)}\n`);

const nextData = (file) => {
    const html = readFileSync(file, 'utf8');
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    return JSON.parse(m[1]);
};

// ── Coles ──────────────────────────────────────────────────────────────────────
const browse = nextData(path.join(src, 'coles-scraper/tests/assets/coles-browse-dairy-eggs-fridge-page-4.html'));
const sr = browse.props.pageProps.searchResults;
const products = sr.results.filter((r) => r._type === 'PRODUCT');
const tiles = sr.results.filter((r) => r._type !== 'PRODUCT');
const pick = (pred, n) => products.filter(pred).slice(0, n);
const colesProducts = [
    ...pick((p) => p.pricing?.promotionType === 'EVERYDAY', 4),
    ...pick((p) => p.pricing?.promotionType === 'SPECIAL', 4),
    ...pick((p) => p.pricing?.promotionType === 'DOWNDOWN', 2),
    ...pick((p) => p.pricing && !p.pricing.promotionType, 2),
];
// One unavailable product (the site sends pricing: null for those; see hotprices-au get_canonical).
const unavailable = structuredClone(products.find((p) => !colesProducts.includes(p)));
unavailable.pricing = null;
unavailable.availability = false;
colesProducts.push(unavailable);
const product = nextData(path.join(src, 'coles-scraper/tests/assets/coles-appy-fizz-250ml-8060378.html')).props.pageProps.product;
out('coles.json', {
    source: 'https://github.com/abhinav-pandey29/coles-scraper/tree/main/tests/assets (real __NEXT_DATA__, Oct 2024)',
    buildId: browse.buildId,
    runtimeConfigKeys: Object.keys(browse.runtimeConfig ?? {}),
    searchResultsKeys: Object.keys(sr),
    pageSize: sr.pageSize,
    products: colesProducts,
    adTile: tiles[0],
    productDetail: product,
});

// ── Woolworths ─────────────────────────────────────────────────────────────────
const rows = JSON.parse(readFileSync(path.join(src, 'woolworths-scraper/sample_output.json'), 'utf8'));
const slugOf = (url) => url.split('/').pop();
const woolProducts = rows.map((r) => ({
    Stockcode: Number(r.sku),
    Barcode: r.barcode,
    DisplayName: r.title,
    Name: r.title.replace(/\s+\d.*$/, ''),
    Brand: r.brand,
    Description: r.description,
    Variety: r.variety,
    Price: r.price,
    InstorePrice: r.price,
    WasPrice: r.original_price ?? r.price,
    SavingsAmount: r.savings_amount ?? 0,
    CupPrice: r.cup_price,
    CupMeasure: r.cup_measure,
    CupString: r.cup_string,
    PackageSize: r.package_size,
    Unit: r.unit,
    IsOnSpecial: r.is_on_special,
    IsHalfPrice: r.is_half_price,
    IsSponsoredAd: r.is_sponsored,
    AdStatus: r.ad_status,
    IsAvailable: r.is_available,
    IsInStock: r.is_in_stock,
    IsPurchasable: r.is_purchasable,
    SupplyLimit: r.supply_limit,
    LargeImageFile: r.image_url,
    MediumImageFile: r.image_url.replace('/large/', '/medium/'),
    UrlFriendlyName: slugOf(r.url),
    AdditionalAttributes: {
        sapdepartmentname: r.department,
        sapcategoryname: r.category,
        sapsubcategoryname: r.subcategory,
        // pies*namesjson: field names verified from hotprices-au woolies.py; the values are illustrative (not in the capture).
        piesdepartmentnamesjson: JSON.stringify(['Bakery']),
        piescategorynamesjson: JSON.stringify(['Packaged Bread & Bakery']),
        piessubcategorynamesjson: JSON.stringify([]),
        healthstarrating: r.health_star_rating == null ? null : String(r.health_star_rating),
        countryoforigin: null,
    },
}));
out('woolworths.json', {
    source: 'https://github.com/2scraper/woolworths-scraper/blob/main/sample_output.json (real rows, 2026-09-16), mapped to API field names',
    products: woolProducts,
    categories: {
        Categories: [
            { NodeId: '1_DEB537E', Description: 'Bakery', UrlFriendlyName: 'bakery', Children: [
                { NodeId: '1_A6D1FC1', Description: 'Packaged Bread & Bakery', UrlFriendlyName: 'packaged-bread-bakery', Children: [] },
            ] },
            { NodeId: '1-E5BEE36E', Description: 'Fruit & Veg', UrlFriendlyName: 'fruit-veg', Children: [] },
            { NodeId: 'specialsgroup', Description: 'Specials', UrlFriendlyName: 'specials', Children: [] },
        ],
    },
});
console.log(`Coles: ${colesProducts.length} products; Woolworths: ${woolProducts.length} products.`);
