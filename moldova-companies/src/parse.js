// Streams rows out of the official XLSX (or CSV) and yields normalized records.
import fs from 'node:fs';
import Papa from 'papaparse';
import { log } from 'apify';
import { detectHeader, normalizeRow, cellText, toIsoDate } from './normalize.js';
import { readXlsxRows } from './xlsx-stream.js';

const HEADER_SCAN_ROWS = 30;

function rowToRecord(cells, header, keepRaw) {
    const fields = {};
    for (const [i, f] of header.fieldByIndex) fields[f] = cells[i];
    let raw;
    if (keepRaw) {
        raw = {};
        for (const [i, h] of header.headerByIndex) {
            const f = header.fieldByIndex.get(i);
            const t = (f === 'registrationDate' || f === 'liquidationDate') ? (toIsoDate(cells[i]) ?? cellText(cells[i])) : cellText(cells[i]);
            if (t) raw[h] = t;
        }
    }
    return normalizeRow(fields, raw);
}

async function* csvRows(filePath) {
    // Papa's Node stream mode emits one array per row and handles back-pressure.
    const rows = fs.createReadStream(filePath, 'utf8').pipe(Papa.parse(Papa.NODE_STREAM_INPUT, { skipEmptyLines: 'greedy' }));
    let rowNo = 0;
    for await (const r of rows) {
        const cells = rowNo === 0 ? r.map((c, i) => (i === 0 ? String(c).replace(/^\uFEFF/, '') : c)) : r;
        rowNo++;
        yield { sheetNo: 1, rowNo, cells };
    }
}

/**
 * Yields normalized company records. Detects the header row by its names (Romanian or Russian),
 * so extra title rows, reordered or renamed columns do not break parsing.
 */
export async function* parseCompanies(filePath, kind, { keepRaw = true } = {}) {
    const gen = kind === 'xlsx' ? readXlsxRows(filePath) : csvRows(filePath);
    const stats = { rows: 0, records: 0, skipped: 0, sheetsWithHeader: 0 };
    let currentSheet = 0;
    let header = null;
    let columnsLogged = false;
    for await (const { sheetNo, rowNo, cells } of gen) {
        if (sheetNo !== currentSheet) { currentSheet = sheetNo; header = null; }
        if (!header) {
            if (rowNo <= HEADER_SCAN_ROWS) {
                header = detectHeader(cells);
                if (header) {
                    stats.sheetsWithHeader++;
                    if (!columnsLogged) {
                        const mapped = [...header.fieldByIndex].map(([i, f]) => `${header.headerByIndex.get(i)} → ${f}`);
                        const unmapped = [...header.headerByIndex].filter(([i]) => !header.fieldByIndex.has(i)).map(([, h]) => h);
                        log.info(`Header found in sheet ${sheetNo}, row ${rowNo}. Columns: ${mapped.join(' | ')}`);
                        if (unmapped.length) log.info(`Columns kept only in "raw": ${unmapped.join(' | ')}`);
                        columnsLogged = true;
                    }
                }
            }
            continue;
        }
        stats.rows++;
        const rec = rowToRecord(cells, header, keepRaw);
        if (rec) { stats.records++; yield rec; } else stats.skipped++;
    }
    if (!stats.sheetsWithHeader) {
        throw new Error('Could not find the header row (expected columns like "IDNO" and "Denumirea") in the source file. The official file format may have changed.');
    }
    log.info(`Parsed ${stats.records} companies (${stats.skipped} rows skipped without a valid 13-digit IDNO or name).`);
}
