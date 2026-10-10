"""One PDF -> rows. Pure function (no Apify calls), so it can be tested directly."""
from __future__ import annotations

import io
import re

import pdfplumber
from pdfminer.pdfdocument import PDFPasswordIncorrect

from .invoice import extract_invoice, looks_like_invoice
from .numbers import clean_number_value, detect_decimal_comma, parse_number
from .tables import extract_page

INVOICE_FIELDS = ['invoiceNumber', 'invoiceDate', 'dueDate', 'poNumber', 'supplierName', 'supplierTaxId', 'customerName',
                  'currency', 'subtotal', 'taxRate', 'taxAmount', 'total', 'linesSum', 'totalsCheck', 'iban']


class PdfError(Exception):
    pass


def _is_password_error(err: BaseException) -> bool:
    # pdfplumber wraps pdfminer's PDFPasswordIncorrect in PdfminerException(PDFPasswordIncorrect())
    seen = 0
    while err is not None and seen < 5:
        if isinstance(err, PDFPasswordIncorrect) or any(isinstance(a, PDFPasswordIncorrect) for a in getattr(err, 'args', ())):
            return True
        err = err.__cause__ or err.__context__
        seen += 1
    return False


# Columns of identifiers stay text even when they look like numbers ("NAICS code" 4411, "SKU" 1200, "ZIP" 02134)
CODE_COL_RE = re.compile(r'\bcode\b|\bid\b|naics|\bzip\b|\bsku\b|part\s*(no|number|#)|item\s*(no|number|#)|phone', re.I)


def _cell_value(raw: str, decimal_comma: bool, parse_numbers: bool, first_column: bool = False, code_column: bool = False):
    if not parse_numbers or raw == '' or code_column:
        return raw
    # keep codes with leading zeros ("00123") as text, and "(18)" in the first column (a line number, not -18)
    if re.fullmatch(r'0\d+', raw) or (first_column and re.fullmatch(r'\(\d+\)', raw)):
        return raw
    p = parse_number(raw, decimal_comma)
    if p is None or p[2]:  # percentages stay as written ("21%")
        return raw
    return clean_number_value(p[0])


def process_pdf(data: bytes, *, mode: str = 'auto', table_method: str = 'auto', max_pages: int = 0,
                parse_numbers: bool = True, date_order: str = 'auto', password: str | None = None) -> dict:
    """Return {
        totalPages, pagesRead, documentType ('invoice'|'tables'|'none'), invoice (fields) | None,
        rows: [ {page, ...} ], pagesWithData: [page numbers], warnings: [...], scannedPages: [...]
    }"""
    warnings = []
    try:
        pdf = pdfplumber.open(io.BytesIO(data), password=password or '')
    except Exception as err:  # noqa: BLE001
        if _is_password_error(err):
            raise PdfError('The PDF is password-protected. Add the password in "pdfPassword" or remove it and try again.'
                           if not password else 'The PDF password in "pdfPassword" is wrong for this file.') from err
        raise PdfError(f'Could not open the PDF ({type(err).__name__}: {err}). The file may be corrupted.') from err

    with pdf:
        try:
            total = len(pdf.pages)
        except PDFPasswordIncorrect as err:
            raise PdfError('The PDF is password-protected. Add the password in "pdfPassword" or remove it and try again.') from err
        n = min(total, max_pages) if max_pages else total
        if n < total:
            warnings.append(f'Only the first {n} of {total} pages were read (maxPagesPerDocument or spending limit).')
        # Pass 1: text only (decimal comma or point is decided for the whole document). Caches are flushed
        # page by page so that long PDFs stay within the Actor's memory.
        texts, scanned = [], []
        for i in range(n):
            page = pdf.pages[i]
            try:
                text = page.extract_text() or ''
            except Exception as err:  # noqa: BLE001
                warnings.append(f'Page {i + 1} could not be read ({type(err).__name__}).')
                text = ''
            if len(text.strip()) < 15 and page.images:
                scanned.append(i + 1)
            texts.append(text)
            page.close()
        decimal_comma = detect_decimal_comma('\n'.join(texts))

        # Pass 2: tables and positioned lines.
        pages, tables = [], []
        for i in range(n):
            page = pdf.pages[i]
            if (i + 1) in scanned:
                t, lines = [], []
            else:
                try:
                    t, lines = extract_page(page, i + 1, decimal_comma, table_method)
                except Exception as err:  # noqa: BLE001
                    warnings.append(f'Page {i + 1}: table detection failed ({type(err).__name__}: {err}).')
                    t, lines = [], []
            # keep positioned lines only where they are needed (invoice fields: first pages and the last one)
            keep_lines = i < 3 or i == n - 1
            pages.append({'page': i + 1, 'lines': lines if keep_lines else [], 'height': float(page.height), 'text': texts[i] if keep_lines else ''})
            tables.extend(t)
            page.close()

    if scanned:
        warnings.append(f'{len(scanned)} page(s) look scanned (image only, no text layer): OCR is not supported, so they were skipped.')

    result = {'totalPages': total, 'pagesRead': n, 'decimalComma': decimal_comma, 'warnings': warnings,
              'scannedPages': scanned, 'invoice': None, 'rows': [], 'pagesWithData': [], 'documentType': 'none',
              'tablesFound': len(tables)}
    if not pages:
        return result

    is_invoice = mode == 'invoice' or (mode == 'auto' and looks_like_invoice(pages[0]['text']))
    if is_invoice:
        fields, items = extract_invoice(pages, tables, decimal_comma, date_order)
        has_fields = any(fields.get(k) for k in ('invoiceNumber', 'total', 'invoiceDate'))
        if items or has_fields:
            result['documentType'] = 'invoice'
            result['invoice'] = {k: fields.get(k) for k in INVOICE_FIELDS}
            head = result['invoice']
            data_pages = set()
            if items:
                for it in items:
                    row = {'rowType': 'invoice-line', 'page': it['page'], 'lineIndex': it['lineIndex'],
                           'description': it.get('description'), 'sku': it.get('sku'), 'quantity': it.get('quantity'),
                           'unit': it.get('unit'), 'unitPrice': it.get('unitPrice'), 'discount': it.get('discount'),
                           'lineTaxRate': it.get('taxRate'), 'lineTaxAmount': it.get('taxAmount'),
                           'lineTotal': it.get('lineTotal'), 'lineCheck': it.get('lineCheck'), **head}
                    if it.get('otherColumns'):
                        row['otherColumns'] = it['otherColumns']
                    result['rows'].append(row)
                    data_pages.add(it['page'])
            if has_fields:
                data_pages.add(1)
            if not items:
                result['rows'].append({'rowType': 'invoice', 'page': 1, 'lineIndex': None, **head})
                warnings.append('Invoice fields found, but no line-item table (needs a header with a description and a price or amount column).')
            result['pagesWithData'] = sorted(data_pages)
            return result
        if mode == 'invoice':
            return result  # asked for invoices, found none: no rows (not charged)
        # 'auto': it mentions an invoice but has no invoice fields or items: fall back to plain tables

    result['documentType'] = 'tables' if tables else 'none'
    data_pages = set()
    for ti, t in enumerate(tables, 1):
        names = t.header or [f'col_{k + 1}' for k in range(len(t.rows[0]))]
        codes = {k for k, h in enumerate(names) if t.header and CODE_COL_RE.search(h or '')}
        for ri, r in enumerate(t.rows, 1):
            data = {names[k]: _cell_value(r[k] if k < len(r) else '', decimal_comma, parse_numbers, k == 0, k in codes)
                    for k in range(len(names))}
            result['rows'].append({'rowType': 'table-row', 'page': t.page, 'tableIndex': ti, 'tableTitle': t.title or None,
                                   'tableMethod': t.method, 'hasHeader': bool(t.header), 'rowIndex': ri, 'data': data})
        data_pages.add(t.page)
    result['pagesWithData'] = sorted(data_pages)
    return result
