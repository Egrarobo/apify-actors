// Builds the MTender fixtures used by the mock API server.
//
// The shapes follow MTender's own documentation (MTender-Documentation "Data Standard": a contracting process is a
// record package whose `records[]` hold one compiledRelease per stage — the process record "cnParent" with the same
// ocid, and stage records such as "…-PN-…" / "…-EV-…" / "…-AC-…" with lots, items, documents, awards and contracts)
// and the field usage of two independent open-source MTender clients (mtender-mcp-server, @pipeworx/mcp-moldova-tenders).
// Values are invented. Run: node test/fixtures/build-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const dir = new URL('./tenders/', import.meta.url);
mkdirSync(dir, { recursive: true });

const ts = (iso) => Date.parse(iso);
const ocidAt = (iso, bump = 0) => `ocds-b3wdp1-MD-${ts(iso) + bump}`;
const publisher = { name: 'M-Tender', uri: 'https://www.mtender.gov.md' };

function party(id, name, roles, extra = {}) {
    return {
        id,
        name,
        identifier: { scheme: 'MD-IDNO', id: id.replace(/^MD-IDNO-/, ''), legalName: name },
        address: {
            streetAddress: extra.street ?? 'str. Exemplu 1',
            postalCode: 'MD-2001',
            addressDetails: {
                country: { scheme: 'iso-alpha2', id: 'MD', description: 'Moldova, Republica' },
                region: { scheme: 'CUATM', id: '0101000', description: extra.region ?? 'mun.Chişinău' },
                locality: { scheme: 'CUATM', id: '0101000', description: extra.locality ?? 'mun.Chişinău' },
            },
        },
        contactPoint: { name: 'Persoana de contact', email: extra.email ?? 'achizitii@example.md', telephone: '+37322000000' },
        roles,
    };
}

function pkg(ocid, records) {
    return {
        uri: `https://public.mtender.gov.md/tenders/${ocid}`,
        version: '1.1',
        extensions: [],
        publisher,
        license: 'http://opendefinition.org/licenses/',
        publicationPolicy: 'http://opendefinition.org/licenses/',
        publishedDate: records[records.length - 1].date,
        packages: records.map((r) => `http://public.mtender.gov.md/tenders/${ocid}/${r.ocid}`),
        records: records.map((r) => ({ ocid: r.ocid, compiledRelease: r })),
        actualReleases: records.map((r) => ({ ocid: r.ocid, uri: `http://public.mtender.gov.md/tenders/${ocid}/${r.ocid}` })),
    };
}

function ms(ocid, date, tender, extra = {}) {
    return {
        ocid,
        id: `${ocid}-${ts(date)}`,
        date,
        tag: ['compiled'],
        initiationType: 'tender',
        planning: extra.planning ?? { budget: { description: 'Buget', amount: tender.value, isEuropeanUnionFunded: false } },
        tender,
        parties: extra.parties ?? [],
        relatedProcesses: extra.relatedProcesses ?? [],
    };
}

function stage(ocid, code, stageTs, date, body) {
    const sOcid = `${ocid}-${code}-${stageTs}`;
    return { ocid: sOcid, id: `${sOcid}-${ts(date)}`, date, tag: ['tender'], initiationType: 'tender', ...body };
}

const docs = (prefix, list) => list.map(([title, type, lots], i) => ({
    id: `${prefix}-${i + 1}-1757000000000`,
    documentType: type,
    title,
    url: `https://storage.mtender.gov.md/get/${prefix}-${i + 1}-1757000000000`,
    datePublished: '2026-09-10T08:05:00Z',
    relatedLots: lots,
}));

const tenders = [];

// T1 — medicines, active, 2 lots, Romanian diacritics (comma-below ș/ț)
{
    const created = '2026-09-10T08:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1003600012345', 'IMSP Spitalul Clinic Republican „Timofei Moșneaga”', ['buyer', 'procuringEntity'], { email: 'achizitii@scr.md' });
    const main = ms(ocid, '2026-09-12T10:00:00Z', {
        id: 'b7c1f3a2-0001', title: 'Achiziționarea medicamentelor pentru anul 2027',
        description: 'Medicamente și consumabile medicale pentru secțiile spitalului',
        classification: { scheme: 'CPV', id: '33600000-6', description: 'Produse farmaceutice' },
        status: 'active', statusDetails: 'evaluation',
        value: { amount: 1250000, currency: 'MDL' },
        procurementMethod: 'open', procurementMethodDetails: 'openTender', mainProcurementCategory: 'goods',
        procuringEntity: { id: buyer.id, name: buyer.name }, legalBasis: 'NATIONAL_PROCUREMENT_LAW',
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-12T10:00:00Z', {
        tender: {
            id: 'b7c1f3a2-0002', title: 'Achiziționarea medicamentelor pentru anul 2027', description: 'Lot 1 antibiotice, lot 2 analgezice',
            status: 'active', statusDetails: 'clarification',
            enquiryPeriod: { startDate: '2026-09-10T08:00:00Z', endDate: '2026-09-20T08:00:00Z' },
            tenderPeriod: { startDate: '2026-09-10T08:00:00Z', endDate: '2026-09-30T08:00:00Z' },
            auctionPeriod: { startDate: '2026-10-01T09:00:00Z' },
            procurementMethodModalities: ['electronicAuction'],
            lots: [
                { id: 'lot-1', title: 'Antibiotice', description: 'Amoxicilină, ceftriaxonă', status: 'active', statusDetails: 'empty', value: { amount: 750000, currency: 'MDL' },
                    contractPeriod: { startDate: '2027-01-01T00:00:00Z', endDate: '2027-12-31T00:00:00Z' },
                    placeOfPerformance: { address: { streetAddress: 'str. Nicolae Testemițanu 29', addressDetails: { country: { description: 'Moldova, Republica' }, region: { description: 'mun.Chişinău' }, locality: { description: 'mun.Chişinău' } } } } },
                { id: 'lot-2', title: 'Analgezice', description: 'Paracetamol', status: 'active', value: { amount: 500000, currency: 'MDL' } },
            ],
            items: [
                { id: 'item-1', description: 'Amoxicilină 500 mg', classification: { scheme: 'CPV', id: '33651100-9', description: 'Antibacteriene de uz sistemic' }, quantity: 10000, unit: { id: '120', name: 'Bucată' }, relatedLot: 'lot-1' },
                { id: 'item-2', description: 'Paracetamol 500 mg', classification: { scheme: 'CPV', id: '33661000-5', description: 'Medicamente pentru sistemul nervos' }, quantity: 20000, unit: { id: '120', name: 'Bucată' }, relatedLot: 'lot-2' },
            ],
            documents: docs('t1', [['Caiet de sarcini.pdf', 'biddingDocuments', []], ['Specificații lot 1.pdf', 'technicalSpecifications', ['lot-1']]]),
        },
        parties: [buyer],
    });
    tenders.push({ ocid, feedDate: '2026-09-12T10:00:00Z', pkg: pkg(ocid, [main, ev]) });
}

// T2 — road works, complete, awarded with contract
{
    const created = '2026-09-10T09:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1007601004785', 'Primăria municipiului Chișinău', ['buyer', 'procuringEntity']);
    const supplier = party('MD-IDNO-1002600055555', 'Drumuri-Construct SRL', ['supplier', 'tenderer'], { email: 'office@drumuri.md' });
    const other = party('MD-IDNO-1002600066666', 'Asfalt Grup SA', ['tenderer']);
    const main = ms(ocid, '2026-09-14T12:00:00Z', {
        id: 'r1', title: 'Reparația capitală a drumului str. Ștefan cel Mare',
        description: 'Lucrări de reparație capitală a carosabilului',
        classification: { scheme: 'CPV', id: '45233140-2', description: 'Lucrări de drumuri' },
        status: 'complete', statusDetails: 'complete',
        value: { amount: 8500000, currency: 'MDL' },
        procurementMethod: 'open', procurementMethodDetails: 'openTender', mainProcurementCategory: 'works',
        procuringEntity: { id: buyer.id, name: buyer.name },
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-13T12:00:00Z', {
        tag: ['award'],
        tender: {
            id: 'r2', status: 'complete', statusDetails: 'complete',
            tenderPeriod: { startDate: '2026-09-10T09:00:00Z', endDate: '2026-09-11T09:00:00Z' },
            awardPeriod: { startDate: '2026-09-11T09:00:00Z', endDate: '2026-09-13T12:00:00Z' },
            lots: [{ id: 'lot-1', title: 'Str. Ștefan cel Mare', status: 'complete', value: { amount: 8500000, currency: 'MDL' } }],
            items: [{ id: 'i1', description: 'Asfaltare 10.000 m2', classification: { scheme: 'CPV', id: '45233140-2', description: 'Lucrări de drumuri' }, quantity: 10000, unit: { name: 'Metru pătrat' }, relatedLot: 'lot-1' }],
            documents: docs('t2', [['Anunț de participare.pdf', 'contractNotice', []]]),
        },
        awards: [
            { id: 'aw-1', status: 'active', statusDetails: 'active', date: '2026-09-13T12:00:00Z', value: { amount: 7950000, currency: 'MDL' }, suppliers: [{ id: supplier.id, name: supplier.name }], relatedLots: ['lot-1'] },
            { id: 'aw-0', status: 'unsuccessful', statusDetails: 'unsuccessful', date: '2026-09-12T12:00:00Z', value: { amount: 7800000, currency: 'MDL' }, suppliers: [{ id: other.id, name: other.name }], relatedLots: ['lot-1'], description: 'Oferta nu corespunde cerințelor' },
        ],
        bids: { details: [{ id: 'b1', status: 'valid' }, { id: 'b2', status: 'disqualified' }, { id: 'b3', status: 'valid' }] },
        parties: [buyer, supplier, other],
    });
    const ac = stage(ocid, 'AC', ts(created) + 2000, '2026-09-14T12:00:00Z', {
        tag: ['contract'],
        contracts: [{ id: 'c-1', awardID: 'aw-1', title: 'Contract nr. 12/2026', status: 'active', statusDetails: 'signed', value: { amount: 7950000, currency: 'MDL' }, dateSigned: '2026-09-14T11:00:00Z', period: { startDate: '2026-09-15T00:00:00Z', endDate: '2026-12-31T00:00:00Z' } }],
        parties: [buyer, supplier],
    });
    tenders.push({ ocid, feedDate: '2026-09-14T12:00:00Z', pkg: pkg(ocid, [main, ev, ac]) });
}

// T3 — Russian title, cancelled, computers
{
    const created = '2026-09-11T08:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1012600034567', 'Ministerul Educației și Cercetării', ['buyer', 'procuringEntity']);
    const main = ms(ocid, '2026-09-13T08:00:00Z', {
        id: 'c1', title: 'Закупка компьютерной техники для школ', description: 'Ноутбуки и принтеры',
        classification: { scheme: 'CPV', id: '30213000-5', description: 'Computere personale' },
        status: 'cancelled', statusDetails: 'cancelled', value: { amount: 90000, currency: 'MDL' },
        procurementMethod: 'selective', procurementMethodDetails: 'smallValue', mainProcurementCategory: 'goods',
        procuringEntity: { id: buyer.id, name: buyer.name },
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-13T08:00:00Z', {
        tender: { id: 'c2', status: 'cancelled', tenderPeriod: { startDate: '2026-09-11T08:00:00Z', endDate: '2026-09-18T08:00:00Z' },
            lots: [{ id: 'l1', title: 'Ноутбуки', status: 'cancelled', value: { amount: 90000, currency: 'MDL' } }],
            items: [{ id: 'i1', description: 'Ноутбук 15"', classification: { scheme: 'CPV', id: '30213100-6', description: 'Computere portabile' }, quantity: 30, unit: { name: 'Bucată' }, relatedLot: 'l1' }] },
    });
    tenders.push({ ocid, feedDate: '2026-09-13T08:00:00Z', pkg: pkg(ocid, [main, ev]) });
}

// T4 — IT services in EUR, unsuccessful
{
    const created = '2026-09-11T10:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1006601000001', 'Agenția de Guvernare Electronică', ['buyer', 'procuringEntity']);
    const main = ms(ocid, '2026-09-13T09:00:00Z', {
        id: 's1', title: 'Servicii de consultanță IT pentru platforma MPass', description: 'Consultanță tehnică',
        classification: { scheme: 'CPV', id: '72220000-3', description: 'Servicii de consultanță în sisteme și consultanță tehnică' },
        status: 'unsuccessful', statusDetails: 'unsuccessful', value: { amount: 20000, currency: 'EUR' },
        procurementMethod: 'open', procurementMethodDetails: 'openTender', mainProcurementCategory: 'services',
        procuringEntity: { id: buyer.id, name: buyer.name },
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-13T09:00:00Z', {
        tender: { id: 's2', status: 'unsuccessful', tenderPeriod: { startDate: '2026-09-11T10:00:00Z', endDate: '2026-09-12T10:00:00Z' }, lots: [{ id: 'l1', title: 'Consultanță', status: 'unsuccessful', value: { amount: 20000, currency: 'EUR' } }] },
    });
    tenders.push({ ocid, feedDate: '2026-09-13T09:00:00Z', pkg: pkg(ocid, [main, ev]) });
}

// T5 — old tender (2025) whose award was updated in the period
{
    const created = '2025-11-01T08:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1007601004785', 'Primăria municipiului Chișinău', ['buyer', 'procuringEntity']);
    const main = ms(ocid, '2026-09-12T15:00:00Z', {
        id: 'o1', title: 'Medicamente pentru centrele de sănătate (2025)', classification: { scheme: 'CPV', id: '33600000-6', description: 'Produse farmaceutice' },
        status: 'complete', value: { amount: 300000, currency: 'MDL' }, procurementMethod: 'open', procurementMethodDetails: 'openTender', mainProcurementCategory: 'goods',
        procuringEntity: { id: buyer.id, name: buyer.name },
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-12T15:00:00Z', {
        tender: { id: 'o2', status: 'complete', tenderPeriod: { startDate: '2025-11-01T08:00:00Z', endDate: '2025-11-20T08:00:00Z' } },
        awards: [{ id: 'a1', status: 'active', date: '2026-09-12T15:00:00Z', value: { amount: 280000, currency: 'MDL' }, suppliers: [{ id: 'MD-IDNO-1003600099999', name: 'Farmacia Familiei SRL' }], relatedLots: [] }],
    });
    tenders.push({ ocid, feedDate: '2026-09-12T15:00:00Z', pkg: pkg(ocid, [main, ev]) });
}

// T6 — no value published, planning stage (PN only)
{
    const created = '2026-09-12T08:00:00Z';
    const ocid = ocidAt(created);
    const main = ms(ocid, '2026-09-12T08:30:00Z', {
        id: 'p1', title: 'Servicii de curățenie a clădirilor', classification: { scheme: 'CPV', id: '90910000-9', description: 'Servicii de curățenie' },
        status: 'planning', statusDetails: 'planning', procurementMethod: 'open', procurementMethodDetails: 'openTender', mainProcurementCategory: 'services',
        procuringEntity: { id: 'MD-IDNO-1003600077777', name: 'Casa Națională de Asigurări Sociale' },
    }, { planning: { budget: { description: 'Buget de stat' } }, parties: [party('MD-IDNO-1003600077777', 'Casa Națională de Asigurări Sociale', ['buyer', 'procuringEntity'])] });
    const pn = stage(ocid, 'PN', ts(created) + 1000, '2026-09-12T08:30:00Z', {
        tag: ['planning'],
        tender: { id: 'p2', status: 'planning', tenderPeriod: { startDate: '2026-10-15T00:00:00Z' }, lots: [{ id: 'l1', title: 'Curățenie sediu central', status: 'planning' }] },
    });
    tenders.push({ ocid, feedDate: '2026-09-12T08:30:00Z', pkg: pkg(ocid, [main, pn]) });
}

// T7 — flaky tender: the mock answers 500, then 429 (Retry-After), then 200 {"name":"Error"}, then the data.
{
    const created = '2026-09-12T11:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1003600012345', 'IMSP Spitalul Clinic Republican „Timofei Moșneaga”', ['buyer', 'procuringEntity']);
    const main = ms(ocid, '2026-09-12T11:30:00Z', {
        id: 'f1', title: 'Reactivi de laborator', classification: { scheme: 'CPV', id: '33696500-0', description: 'Reactivi de laborator' },
        status: 'active', value: { amount: 45000.5, currency: 'MDL' }, procurementMethod: 'selective', procurementMethodDetails: 'smallValue', mainProcurementCategory: 'goods',
        procuringEntity: { id: buyer.id, name: buyer.name },
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-12T11:30:00Z', { tender: { id: 'f2', status: 'active', statusDetails: 'tendering', tenderPeriod: { startDate: '2026-09-12T11:00:00Z', endDate: '2026-09-19T11:00:00Z' } } });
    tenders.push({ ocid, feedDate: '2026-09-12T11:30:00Z', flaky: true, pkg: pkg(ocid, [main, ev]) });
}

// T8 — listed in the feed but deleted (404)
tenders.push({ ocid: ocidAt('2026-09-12T12:00:00Z'), feedDate: '2026-09-12T12:05:00Z', missing: true, pkg: null });

// T9 — added during the monitor test (published after the first run)
{
    const created = '2026-09-20T08:00:00Z';
    const ocid = ocidAt(created);
    const buyer = party('MD-IDNO-1003600012345', 'IMSP Spitalul Clinic Republican „Timofei Moșneaga”', ['buyer', 'procuringEntity']);
    const main = ms(ocid, '2026-09-20T08:10:00Z', {
        id: 'n1', title: 'Medicamente oncologice', description: 'Preparate citostatice',
        classification: { scheme: 'CPV', id: '33652000-5', description: 'Agenți antineoplazici' },
        status: 'active', value: { amount: 2100000, currency: 'MDL' }, procurementMethod: 'open', procurementMethodDetails: 'openTender', mainProcurementCategory: 'goods',
        procuringEntity: { id: buyer.id, name: buyer.name },
    }, { parties: [buyer] });
    const ev = stage(ocid, 'EV', ts(created) + 1000, '2026-09-20T08:10:00Z', { tender: { id: 'n2', status: 'active', statusDetails: 'clarification', tenderPeriod: { startDate: '2026-09-20T08:00:00Z', endDate: '2026-10-10T08:00:00Z' }, enquiryPeriod: { startDate: '2026-09-20T08:00:00Z', endDate: '2026-10-01T08:00:00Z' } } });
    tenders.push({ ocid, feedDate: '2026-09-20T08:10:00Z', later: true, pkg: pkg(ocid, [main, ev]) });
}

const index = [];
for (const t of tenders) {
    if (t.pkg) {
        writeFileSync(new URL(`${t.ocid}.json`, dir), `${JSON.stringify(t.pkg, null, 2)}\n`);
    }
    index.push({ ocid: t.ocid, date: t.feedDate, missing: !!t.missing, flaky: !!t.flaky, later: !!t.later });
}
writeFileSync(new URL('./feed-index.json', import.meta.url), `${JSON.stringify(index, null, 2)}\n`);
console.log(`Wrote ${tenders.filter((t) => t.pkg).length} record packages and a feed index of ${index.length} entries.`);
