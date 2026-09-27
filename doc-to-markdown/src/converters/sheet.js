// XLSX -> one Markdown table per sheet (exceljs); CSV/TSV -> Markdown table (papaparse).
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { mdTable } from '../markdown.js';
import { decodeText } from './html.js';

const MAX_ROWS_PER_SHEET = 100000;

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) {
        const iso = v.toISOString();
        return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
    }
    if (typeof v === 'object') {
        if ('result' in v) return cellText(v.result);            // formula
        if ('formula' in v || 'sharedFormula' in v) return '';     // formula without cached value
        if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
        if ('text' in v) return cellText(v.text);                 // hyperlink
        if ('error' in v) return String(v.error);
        return '';
    }
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10);
    return String(v);
}

/** Trim empty trailing rows/columns and empty leading columns. */
function trimGrid(rows) {
    const nonEmpty = rows.filter((r) => r.some((c) => c !== ''));
    if (!nonEmpty.length) return [];
    let first = Infinity;
    let last = 0;
    for (const r of nonEmpty) {
        r.forEach((c, i) => { if (c !== '') { first = Math.min(first, i); last = Math.max(last, i); } });
    }
    return nonEmpty.map((r) => r.slice(first, last + 1));
}

export async function convertXlsx(buffer, { includeHiddenSheets = false } = {}) {
    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch (err) {
        throw new Error(`Could not read the Excel file (${err.message}). Only .xlsx is supported; save .xls files as .xlsx.`);
    }
    const sections = [];
    const warnings = [];
    let formulasWithoutValue = 0;
    wb.eachSheet((ws) => {
        if (ws.state !== 'visible' && !includeHiddenSheets) return;
        const rows = [];
        ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            if (rowNumber > MAX_ROWS_PER_SHEET) return;
            const vals = [];
            row.eachCell({ includeEmpty: true }, (cell, col) => {
                const v = cell.value;
                if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v) && (v.result === undefined)) formulasWithoutValue++;
                vals[col - 1] = cellText(v).trim();
            });
            rows[rowNumber - 1] = Array.from(vals, (x) => x ?? '');
        });
        if (ws.rowCount > MAX_ROWS_PER_SHEET) warnings.push(`Sheet "${ws.name}": only the first ${MAX_ROWS_PER_SHEET} rows were converted.`);
        const width = Math.max(0, ...rows.filter(Boolean).map((r) => r.length));
        const grid = trimGrid(Array.from(rows, (r) => Array.from({ length: width }, (_, i) => r?.[i] ?? '')));
        if (grid.length) sections.push(`## Sheet: ${ws.name}\n\n${mdTable(grid)}`);
    });
    if (formulasWithoutValue) warnings.push(`${formulasWithoutValue} formula cell(s) had no saved value and are empty. Open and re-save the file in Excel/Sheets to store calculated values.`);
    const title = String(wb.title || '').trim();
    return { title, markdown: sections.join('\n\n'), warnings };
}

export function convertCsv(buffer, { delimiter = '' } = {}) {
    const text = decodeText(buffer);
    const res = Papa.parse(text, { delimiter, skipEmptyLines: 'greedy' });
    const rows = res.data.map((r) => r.map((c) => String(c ?? '').trim()));
    return { title: '', markdown: mdTable(rows), warnings: res.errors.length ? [`CSV: ${res.errors.length} row(s) could not be parsed cleanly.`] : [] };
}
