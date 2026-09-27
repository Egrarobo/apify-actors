// Builds test/fixtures/aldi.json. The generated JSON is committed; this script documents (and reproduces) its origin.
//
//   git clone https://github.com/nicktcode/swissgroceries-mcp /tmp/src/swissgroceries-mcp
//   node test/fixtures/build-fixtures.mjs /tmp/src
//
// Structure: a REAL captured /v3/product-search response of the same ALDI SÜD API platform
// (swissgroceries-mcp tests/fixtures/aldi/search-milch.json, api.aldi-suisse.ch, captured with
// scripts/capture-aldi-fixtures.sh). `platformSample` keeps its first product verbatim; `meta` keeps its real
// facets/pagination envelope.
// Values: the AU products below were read from live www.aldi.com.au pages on 2026-09-27 (Eggs category,
// Lower Prices, Special Buys 2026-09-26: names, brands, sizes, prices, unit-price texts, SKUs, slugs, badge
// "While Stocks Last", "Available from Sat 26th September"). They are written into copies of the real product
// object, so every key/type is the platform's. Price-drop example (was $3.99 → $3.49): the sample output published
// by the solidcode/aldi-com-au-scraper Actor. The image CDN path for AU is assumed (only placeholders are tested).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('Usage: node build-fixtures.mjs <dir containing a swissgroceries-mcp clone>');
const real = JSON.parse(readFileSync(path.join(src, 'swissgroceries-mcp/tests/fixtures/aldi/search-milch.json'), 'utf8'));
const template = real.data[0];

const EGGS = [{ id: '960000000', name: 'Dairy, Eggs & Fridge', urlSlugText: 'dairy-eggs-fridge' }, { id: '1111111162', name: 'Eggs', urlSlugText: 'dairy-eggs-fridge/eggs' }];
const MEAT = [{ id: '940000000', name: 'Meat & Seafood', urlSlugText: 'meat-seafood' }];
const SNACKS = [{ id: '1588161408332087', name: 'Snacks & Confectionery', urlSlugText: 'snacks-confectionery' }];
const WSL = [{ position: '1', items: [{ url: null, alt: null, displayText: 'While Stocks Last', color: 'red', mimeType: 'text/plain' }] }];

const rows = [
    // sku, brand, name, slug, size, cents, unit cents, unit text, categories, extra
    ['399451', 'LODGE FARMS', 'Cage Eggs 700g', 'lodge-farms-cage-eggs-700g', '700g', 500, 71, '$0.71 per 100g', EGGS],
    ['403353', 'LODGE FARMS', 'Barn Laid Eggs 18 Pack 900g', 'lodge-farms-barn-laid-eggs-18-pack-900g', '900g', 739, 82, '$0.82 per 100g', EGGS],
    ['405616', 'LODGE FARMS', 'Free Range Eggs 600g', 'lodge-farms-free-range-eggs-600g', '600g', 599, 100, '$1.00 per 100g', EGGS],
    ['405617', 'LODGE FARMS', 'Free Range Eggs 700g', 'lodge-farms-free-range-eggs-700g', '700g', 619, 88, '$0.88 per 100g', EGGS],
    ['405620', 'LODGE FARMS', 'Barn Laid Eggs 700g', 'lodge-farms-barn-laid-eggs-700g', '700g', 529, 76, '$0.76 per 100g', EGGS],
    ['398596', 'SPECIALLY SELECTED', 'Pork, Pepper and Oregano Gourmet Sausages 500g', 'specially-selected-pork-pepper-and-oregano-gourmet-sausages-500g', '500g', 749, 1498, '$14.98 per 1 kg', MEAT],
    ['398905', 'JINDURRA STATION', 'Extra Lean Beef Mince 500g', 'jindurra-station-extra-lean-beef-mince-500g', '500g', 899, 1798, '$17.98 per 1 kg', MEAT],
    ['399018', 'BROAD OAK FARMS', 'RSPCA Approved Chicken Drumsticks Bulk Pack 2kg', 'broad-oak-farms-rspca-approved-chicken-drumsticks-bulk-pack-2kg', '2kg', 699, 350, '$3.50 per 1 kg', MEAT],
    ['657233', 'GARDENLINE', 'Solar Spot Light', 'gardenline-solar-spot-light', null, 1299, null, null, [], { badges: WSL, onSaleDateDisplay: 'Available from Sat 26th September' }],
    ['670932', 'CASALUX', 'Triple Head Security Light', 'casalux-triple-head-security-light', null, 2699, null, null, [], { badges: WSL, onSaleDateDisplay: 'Available from Sat 26th September' }],
    ['690123', 'GARDENLIFE', 'Seaweed Concentrate 2L', 'gardenlife-seaweed-concentrate-2l', '2L', 999, null, null, [], { badges: WSL, onSaleDateDisplay: 'Available from Sat 26th September' }],
    ['704511', 'BELMONT', 'Choc Tim Tam Original Biscuits 200g', 'belmont-choc-tim-tam-original-biscuits-200g', '200g', 349, 175, '$1.75 per 100 g', SNACKS, { wasPriceDisplay: '$3.99', savingsDisplay: '$0.50' }],
];

const products = rows.map(([sku, brand, name, slug, size, amount, comparison, compText, categories, extra = {}]) => {
    const p = structuredClone(template);
    p.sku = sku.padStart(18, '0');
    p.abstractSku = `${p.sku}A`;
    p.brandName = brand;
    p.name = name;
    p.urlSlugText = slug;
    p.urlSlugTextAlternatives = { 'en-AU': slug };
    p.sellingSize = size;
    p.notForSale = true;
    p.categories = categories;
    p.badges = extra.badges ?? [];
    p.onSaleDateDisplay = extra.onSaleDateDisplay ?? null;
    p.price = {
        ...p.price,
        amount,
        amountRelevant: amount,
        amountRelevantDisplay: `$${(amount / 100).toFixed(2)}`,
        comparison,
        comparisonDisplay: compText,
        currencyCode: 'AUD',
        currencySymbol: '$',
        wasPriceDisplay: extra.wasPriceDisplay ?? null,
        savingsDisplay: extra.savingsDisplay ?? null,
    };
    p.assets = p.assets.map((a) => ({ ...a, url: a.url.replace('dm.emea.cms.aldi.cx', 'dm.apac.cms.aldi.cx').replace('aldiprodeu', 'aldiprodapac') }));
    return p;
});
const discontinued = structuredClone(products[1]);
discontinued.sku = '000000000000403354';
discontinued.discontinued = true;
products.push(discontinued);

const meta = structuredClone(real.meta);
meta.facets = meta.facets.slice(0, 2);
writeFileSync(new URL('aldi.json', import.meta.url), `${JSON.stringify({ platformSample: template, meta, products }, null, 1)}\n`);
console.log(`Wrote aldi.json with ${products.length} AU products (template: real ${template.sku}).`);
