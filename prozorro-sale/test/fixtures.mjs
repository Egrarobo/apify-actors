/**
 * Test fixtures shaped like Prozorro.Sale Procedure API (ЦБД3) records.
 *
 * The live API was not reachable from the build environment, so these are SYNTHETIC records. Their structure
 * follows the field names used by a working third-party client of the production API
 * (github.com/VladyslavMykhailyshyn/prozorro-sale-mcp-server, src/core/types.ts) and the open-data page
 * prozorro.sale/opendata. The first few records reuse real public auction IDs and values seen on prozorro.sale
 * and zakupivli.pro (LLE001-UA-20210820-93432, LRE001-UA-20260916-77195, SPE001-UA-20260920-34951).
 */

const H = 3_600_000;
const hex = (i) => (0x60655e344125bce9ef511a00n + BigInt(i)).toString(16).padStart(24, '0');
// The API writes microsecond timestamps, e.g. 2021-04-01T08:23:26.448000Z
const ts = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const L = (uk, en) => (en ? { uk_UA: uk, en_US: en } : { uk_UA: uk });
const money = (amount, vat = true) => ({ amount, currency: 'UAH', valueAddedTaxIncluded: vat });

const REGIONS = [
    ['Київська область', 'Бровари'], ['Львівська область', 'Львів'], ['Одеська область', 'Одеса'],
    ['Полтавська область', 'Полтава'], ['Чернігівська область', 'Сеньківка'], ['Дніпропетровська область', 'Дніпро'],
];
const METHODS = [
    ['smallPrivatization-english', 'SPE001', '04000000-8', 'Нерухоме майно', 'Нежитлове приміщення'],
    ['smallPrivatization-dutch', 'SPD001', '04000000-8', 'Нерухоме майно', 'Будівля колишньої школи'],
    ['legitimatePropertyLease-english', 'LLE001', '04000000-8', 'Нерухоме майно', 'Оренда нежитлового приміщення'],
    ['landRental-english', 'LRE001', '06000000-2', 'Земельні ділянки', 'Оренда земельної ділянки сільськогосподарського призначення'],
    ['landSell-english', 'LSE001', '06000000-2', 'Земельні ділянки', 'Продаж земельної ділянки'],
    ['bankRuptcy-english', 'BRE001', '34110000-1', 'Легкові автомобілі', 'Автомобіль банкрута'],
    ['basicSell-english', 'BSE001', '31000000-6', 'Електротехнічне обладнання', 'Обладнання'],
    ['timber-english', 'TIE001', '03410000-7', 'Деревина', 'Необроблена деревина'],
];
const STATUS_CYCLE = ['active_tendering', 'active_rectification', 'active_tendering', 'complete', 'unsuccessful', 'active_auction', 'cancelled', 'active_qualification'];

function org(name, edrpou, region, city) {
    return {
        name: L(name),
        identifier: { scheme: 'UA-EDR', id: edrpou, legalName: L(name) },
        address: { region: L(region), locality: L(city), streetAddress: L('вул. Центральна, 1'), postalCode: '01001', countryName: L('Україна', 'Ukraine') },
        contactPoint: { name: L('Іван Петренко'), email: 'office@example.gov.ua', telephone: '+380441234567' },
    };
}

function build(i, now) {
    const [sellingMethod, prefix, cav, cavName, what] = METHODS[i % METHODS.length];
    const [region, city] = REGIONS[i % REGIONS.length];
    const status = STATUS_CYCLE[(i + Math.floor(i / METHODS.length)) % STATUS_CYCLE.length];
    const published = now - (60 - (i % 60)) * H - i * 1000; // up to 60 h ago
    // Records 40..44 share one dateModified to exercise the cursor de-duplication.
    const modified = i >= 40 && i <= 44 ? now - 30 * H : Math.min(now - 60_000, published + (i % 7) * H);
    const date = new Date(published).toISOString().slice(0, 10).replaceAll('-', '');
    const amount = 10_000 + ((i * 7919) % 500) * 1000;
    const p = {
        _id: hex(i),
        auctionId: `${prefix}-UA-${date}-${String(10000 + i * 37).slice(-5)}`,
        lotId: `LOT-${i}`,
        sellingMethod,
        status,
        title: L(`${what} №${i}, ${city}`, i % 3 === 0 ? `Commercial property ${i}, ${city}` : undefined),
        description: L(`${what}. ${cavName}. Детальний опис лоту ${i}.`),
        metaInfo: { directions: [sellingMethod.split('-')[0]], categories: [] },
        value: money(amount, i % 2 === 0),
        minimalStep: money(Math.round(amount * 0.01)),
        guarantee: money(Math.round(amount * 0.2)),
        registrationFee: money(600),
        datePublished: ts(published),
        dateModified: ts(modified),
        tenderPeriod: { startDate: ts(published + H), endDate: ts(published + 14 * 24 * H) },
        auctionPeriod: { startDate: ts(published + 15 * 24 * H) },
        auctionUrl: `https://auction.prozorro.sale/${hex(i)}`,
        sellingEntity: org(`Регіональне відділення ФДМУ ${i % 4}`, String(43173325 + (i % 4)), region, city),
        items: [{
            id: `item-${i}`,
            description: L(`${what}, площа ${(i % 90) + 10} кв. м`),
            classification: { scheme: 'CAV', id: cav, description: L(cavName) },
            additionalClassifications: i % 2 ? [{ scheme: 'CPVS', id: 'PA01-7', description: L('Оренда') }] : [],
            quantity: (i % 90) + 10,
            unit: { code: 'MTK', name: L('метри квадратні') },
            address: { region: L(region), locality: L(city), streetAddress: L(`вул. Дружби, ${i}`), postalCode: '15540', countryName: L('Україна') },
            itemProps: sellingMethod.startsWith('land') ? { landArea: (i % 50) / 10 + 0.5, cadastralNumber: `7425589000:03:000:${String(i).padStart(4, '0')}` } : {},
        }],
        documents: [
            { id: `doc-${i}-1`, title: L('Оголошення'), documentType: 'notice', format: 'application/pdf', url: `https://procedure.prozorro.sale/api/documents/public/${hex(i + 1000)}`, datePublished: ts(published) },
            { id: `doc-${i}-2`, title: L('Фото 1'), documentType: 'illustration', format: 'image/jpeg', url: `https://procedure.prozorro.sale/api/documents/public/${hex(i + 2000)}`, datePublished: ts(published) },
        ],
        tenderAttempts: 1 + (i % 3),
    };
    if (sellingMethod.startsWith('legitimatePropertyLease')) {
        p.relatedOrganizations = {
            ownershipType: 'state',
            propertyOwner: org('Національний університет «Львівська політехніка»', '02071010', 'Львівська область', 'Львів'),
            sellingEntity: p.sellingEntity,
        };
        delete p.sellingEntity;
        p.leaseDuration = 'P5Y';
    }
    if (['complete', 'active_qualification'].includes(status)) {
        const final = Math.round(amount * 1.37);
        p.bids = [
            { id: `bid-${i}-1`, status: 'active', value: money(final), bidders: [{ name: L('***** ***** *****'), identifier: { id: '**********' } }] },
            { id: `bid-${i}-2`, status: 'active', value: money(Math.round(amount * 1.2)), bidders: [{ name: L('ТОВ "Покупець"') }] },
        ];
        p.awards = [{ id: `award-${i}`, status: status === 'complete' ? 'active' : 'pending', value: money(final), buyers: [org('ТОВ "Переможець"', '12345678', region, city)], documents: [{ title: L('Протокол'), documentType: 'auctionProtocol', url: `https://procedure.prozorro.sale/api/documents/public/${hex(i + 3000)}` }] }];
        if (status === 'complete') {
            p.contracts = [{ id: `contract-${i}`, status: 'active', awardId: `award-${i}`, contractNumber: `Д-${i}`, value: money(final), buyers: p.awards[0].buyers, dateSigned: ts(modified), documents: [{ title: L('Договір'), documentType: 'contractSigned', url: `https://procedure.prozorro.sale/api/documents/public/${hex(i + 4000)}` }] }];
        }
    }
    if (status === 'cancelled') p.cancellations = [{ id: `c-${i}`, reason: L('Порушення порядку підготовки до аукціону'), datePublished: ts(modified) }];
    return p;
}

/** Record resembling the real LLE001-UA-20210820-93432 (values from zakupivli.pro). */
function realLease() {
    return {
        _id: '612004fc0e8b0e44fd1a2b3c',
        auctionId: 'LLE001-UA-20210820-93432',
        sellingMethod: 'legitimatePropertyLease-english',
        status: 'cancelled',
        title: L('Продовження терміну дії чинного договору оренди нерухомого майна площею 45.6 кв. м'),
        value: money(861.84, true),
        minimalStep: money(86.18),
        guarantee: money(3447.36),
        registrationFee: money(600),
        datePublished: '2021-08-20T10:00:00.000000Z',
        dateModified: '2021-09-08T12:00:00.000000Z',
        tenderPeriod: { startDate: '2021-08-26T15:00:00.000000Z', endDate: '2021-09-08T17:00:00.000000Z' },
        auctionPeriod: { startDate: '2021-09-09T09:00:00.000000Z' },
        leaseDuration: 'P5Y',
        relatedOrganizations: {
            ownershipType: 'state',
            sellingEntity: org('Регіональне відділення Фонду державного майна України по Київській, Черкаській та Чернігівській областях', '43173325', 'Київська область', 'Київ'),
        },
        items: [{
            description: L('Приміщення кафе «Три сестри», 45.6 кв. м'),
            classification: { scheme: 'CAV', id: '04000000-8', description: L('Нерухоме майно') },
            additionalClassifications: [{ scheme: 'CPVS', id: 'PA01-7', description: L('Оренда') }, { scheme: 'CPVS', id: 'QB29-3', description: L('Нерухомість') }],
            address: { region: L('Чернігівська область'), locality: L('Сеньківка'), streetAddress: L('вул. Дружби, 18') },
            quantity: 45.6,
            unit: { code: 'MTK', name: L('метри квадратні') },
        }],
        cancellations: [{ reason: L('Порушення порядку підготовки до аукціону') }],
        documents: [],
    };
}

export function makeFixtures(now = Date.now(), count = 260) {
    const list = [realLease()];
    for (let i = 0; i < count; i++) list.push(build(i, now));
    // Real IDs seen on prozorro.sale for the first land-rental and privatization records.
    const land = list.find((p) => p.sellingMethod === 'landRental-english');
    land.auctionId = 'LRE001-UA-20260916-77195';
    land.title = L('Право оренди земельної ділянки, лот 6 (3.3845 га)');
    const spe = list.find((p) => p.sellingMethod === 'smallPrivatization-english');
    spe.auctionId = 'SPE001-UA-20260920-34951';
    spe.title = L('Нежитлові будівлі за адресою вул. Довіри, 10, Олександрівське');
    return list;
}

export const LEGAL_NAMES = [...new Set([...METHODS.map((m) => m[0]),
    'smallPrivatization-english', 'legitimatePropertyLease-dutch', 'legitimatePropertyLease-priorityEnglish', 'landRental-english', 'landSell-priorityEnglish',
    'bankRuptcy-dutch', 'bankRuptcy-withoutAuction', 'basicSell-dutch', 'largePrivatization-english', 'nonperformingLoans-english'])];
export const PREFIXES = Object.fromEntries(METHODS.map((m) => [m[0], m[1].slice(0, 3)]));
