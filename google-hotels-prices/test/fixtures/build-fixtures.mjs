// Builds the test fixtures from REAL Google Hotels responses captured by github.com/him229/stays (MIT license),
// pinned to commit 77a7558 (Aug 2026): a batchexecute "AtySUc" search for New York hotels (18 hotels) and a
// hotel-detail response for "The Manhattan at Times Square Hotel" (36 provider offers).
// The ds:0 blob of the server-rendered search page has the same layout as the RPC payload
// (confirmed by github.com/janik4321sdfa/google-hotels-python, which reads keys 397419284/410579159/416343588 from ds:0),
// so the HTML fixtures wrap the same data in AF_initDataCallback exactly like google.com does.
//
// Usage: node test/fixtures/build-fixtures.mjs   (downloads the two source files, writes test/fixtures/*.json)
import { writeFileSync } from 'node:fs';

const COMMIT = '77a7558664a9a237ad4c14f1e684eb154a4b047f';
const RAW = `https://raw.githubusercontent.com/him229/stays/${COMMIT}/tests/fixtures/`;

// The captures were saved with double-encoded UTF-8 ("4:00â¯PM"); repair every string.
const repair = (v) => {
    if (typeof v === 'string') return /[ÃÂâ]/.test(v) ? Buffer.from(v, 'latin1').toString('utf8') : v;
    if (Array.isArray(v)) return v.map(repair);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, repair(x)]));
    return v;
};
// Drop large blobs the parser never reads (room photo galleries, review texts) to keep the fixtures small.
const slim = (v, depth = 0) => {
    if (Array.isArray(v)) return v.map((x) => slim(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slim(x, depth + 1)]));
    if (typeof v === 'string' && v.length > 600) return `${v.slice(0, 600)}`;
    return v;
};

const load = async (name) => repair(JSON.parse(await (await fetch(RAW + name)).text()));
const search = slim(await load('search_response_nyc.json'));
const detail = slim(await load('detail_response_sample.json'));
const out = new URL('./', import.meta.url);
writeFileSync(new URL('search-nyc.json', out), JSON.stringify(search));
writeFileSync(new URL('detail-manhattan.json', out), JSON.stringify(detail));
console.log('Fixtures written.');
