// Builds test/fixtures/tesco.json. The generated JSON is committed; this script documents (and reproduces) its origin.
//
//   git clone https://github.com/jonnyreeves/basketeer /tmp/src/basketeer
//   node test/fixtures/build-fixtures.mjs /tmp/src
//
// Source: the xapi.tesco.com response bodies in basketeer's test suite (tests/client.test.ts SEARCH_BODY,
// SEARCH_CATCH_WEIGHT_BODY, PRODUCT_PACKAGED, PRODUCT_LOOSE; tests/browse.test.ts CATEGORY_BODY), July 2026. They
// follow the response shape basketeer's parsers read from live traffic; some values in them are illustrative (e.g.
// the milk row's "£2.25 Clubcard Price" description next to afterDiscount 1.65), which also exercises our rule that
// the price in the promotion text wins. `priceCut` is our own variant of the search row with a non-Clubcard
// "was/now" promotion (beforeDiscount > actual), to test price cuts — its values are synthetic.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('Usage: node build-fixtures.mjs <dir containing a basketeer clone>');
const read = (f) => readFileSync(path.join(src, 'basketeer/tests', f), 'utf8');

/** Evaluates `const NAME = [ … ];` (a plain JS literal in the TS file). */
function constOf(file, name) {
    const s = read(file);
    const start = s.indexOf(`const ${name} = [`);
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    let depth = 0;
    let i = s.indexOf('[', start);
    const from = i;
    for (; i < s.length; i++) {
        if (s[i] === '[' || s[i] === '{') depth++;
        if (s[i] === ']' || s[i] === '}') depth--;
        if (depth === 0) break;
    }
    // eslint-disable-next-line no-new-func
    return new Function(`return ${s.slice(from, i + 1)};`)();
}

const search = constOf('client.test.ts', 'SEARCH_BODY')[0].data.search.results.map((r) => r.node);
const catchWeight = constOf('client.test.ts', 'SEARCH_CATCH_WEIGHT_BODY')[0].data.search.results.map((r) => r.node);
const category = constOf('browse.test.ts', 'CATEGORY_BODY')[0].data.category.results.map((r) => r.node);
const packaged = constOf('client.test.ts', 'PRODUCT_PACKAGED')[0].data.product;
const loose = constOf('client.test.ts', 'PRODUCT_LOOSE')[0].data.product;

const priceCut = structuredClone(search[0]);
priceCut.tpnc = '299999001';
priceCut.tpnb = '99999001';
priceCut.title = 'Tesco Whole Milk 1.136L, 2 Pints';
priceCut.sellers.results[0].price = { actual: 1.25, unitPrice: 1.1, unitOfMeasure: 'litre' };
priceCut.sellers.results[0].promotions = [{
    description: 'Was £1.45 Now £1.25', startDate: '2026-09-20T00:00:00Z', endDate: '2026-10-10T23:59:59Z', attributes: [],
    price: { afterDiscount: 1.25, beforeDiscount: 1.45 },
}];

writeFileSync(new URL('tesco.json', import.meta.url), `${JSON.stringify({
    source: 'jonnyreeves/basketeer tests (July 2026) + one synthetic price-cut row',
    searchNodes: [...search, ...catchWeight, priceCut],
    categoryNodes: category,
    products: [packaged, loose],
}, null, 1)}\n`);
console.log('Wrote tesco.json');
