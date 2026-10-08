"""One Excel workbook for the whole run: a sheet with all invoice lines, one with the invoices, and one per table."""
from __future__ import annotations

import io
import re

from openpyxl import Workbook

INVOICE_LINE_COLS = ['fileName', 'page', 'lineIndex', 'description', 'sku', 'quantity', 'unit', 'unitPrice', 'discount',
                     'lineTaxRate', 'lineTaxAmount', 'lineTotal', 'lineCheck', 'invoiceNumber', 'invoiceDate', 'dueDate',
                     'supplierName', 'customerName', 'currency', 'total']
INVOICE_COLS = ['fileName', 'invoiceNumber', 'invoiceDate', 'dueDate', 'poNumber', 'supplierName', 'supplierTaxId',
                'customerName', 'currency', 'subtotal', 'taxRate', 'taxAmount', 'total', 'linesSum', 'totalsCheck', 'iban', 'sourceUrl']
MAX_SHEETS = 200


def _safe(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v)
    return "'" + s if s[:1] in ('=', '+', '-', '@') and not re.fullmatch(r'-?\d+(\.\d+)?', s) else s


def build_workbook(rows: list[dict], invoices: list[dict]) -> bytes | None:
    if not rows and not invoices:
        return None
    wb = Workbook(write_only=True)
    lines = [r for r in rows if r.get('rowType') == 'invoice-line']
    if lines:
        ws = wb.create_sheet('Invoice lines')
        ws.append(INVOICE_LINE_COLS)
        for r in lines:
            ws.append([_safe(r.get(c)) for c in INVOICE_LINE_COLS])
    if invoices:
        ws = wb.create_sheet('Invoices')
        ws.append(INVOICE_COLS)
        for inv in invoices:
            ws.append([_safe(inv.get(c)) for c in INVOICE_COLS])
    tables = {}
    for r in rows:
        if r.get('rowType') == 'table-row':
            tables.setdefault((r['fileName'], r['tableIndex']), []).append(r)
    used = set()
    for n, ((fname, ti), trows) in enumerate(tables.items()):
        if n >= MAX_SHEETS:
            break
        base = re.sub(r'[\[\]:*?/\\]', '', re.sub(r'\.pdf$', '', fname, flags=re.I))[:20] or 'table'
        name = f'{base} t{ti}'[:31]
        k = 2
        while name in used:
            name = f'{base[:16]} t{ti}-{k}'[:31]
            k += 1
        used.add(name)
        ws = wb.create_sheet(name)
        first = trows[0]
        if first.get('tableTitle'):
            ws.append([_safe(first['tableTitle'])])
        cols = list(first['data'].keys())
        ws.append(cols if first.get('hasHeader') else [f'(no header) {c}' for c in cols])
        for r in trows:
            ws.append([_safe(r['data'].get(c)) for c in cols])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
