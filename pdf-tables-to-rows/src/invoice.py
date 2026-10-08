"""Invoice fields (supplier, number, dates, totals, VAT) and line items, without any AI model.

Fields are found next to their labels ("Invoice No:", "Bill to", "Total due"...) in English, Romanian,
German, French, Dutch, Spanish and Italian. Line items come from the table whose header names a description
and a price or amount column. Every line is checked (quantity x unit price = amount) and the lines are checked
against the subtotal / total.
"""
from __future__ import annotations

import re

from .numbers import clean_number_value, detect_currency, parse_date, parse_number

INVOICE_WORDS = re.compile(
    r'\b(invoice|tax\s+invoice|factur[aăi]|facture|rechnung|fattura|faktura|factuur|bill\s+to|billed\s+to|invoice\s+to)\b', re.I)

# label patterns -> field
LABELS = {
    'invoiceNumber': r'(?:invoice|inv\.?|factur[aăi]|facture|rechnung|fattura|factuur|faktura|bill)\s*(?:no\.?|number|num(?:ber|[aă]r)?\.?|nr\.?|#|n[°ºo]\.?|id|nummer|numéro)\s*[:#.]?|(?:rechnungsnummer|factuurnummer|numéro\s+de\s+facture|n[°º]\s*factur[aăi])\s*[:#.]?',
    'invoiceDate': r'(?:invoice\s*date|date\s*of\s*(?:issue|invoice)|issue(?:d)?\s*(?:date|on)|billing\s*date|data\s*(?:facturii|emiterii|emitere)|rechnungsdatum|factuurdatum|date\s*de\s*(?:la\s*)?facture|fecha(?:\s*de\s*factura)?|data\s*fattura)\s*[:.]?',
    'dueDate': r'(?:due\s*date|payment\s*due(?:\s*date)?|due\s*by|due\s*on|pay\s*by|data\s*scaden[țt]ei|scaden[țt][aă]|f[äa]llig(?:keitsdatum|\s*am)?|vervaldatum|date\s*d.[ée]ch[ée]ance|[ée]ch[ée]ance|vencimiento|scadenza)\s*[:.]?',
    'poNumber': r'(?:p\.?o\.?\s*(?:no\.?|number|#)|purchase\s*order(?:\s*(?:no\.?|number|#))?|order\s*(?:no\.?|number|#)|your\s*order|bestellnummer|comand[aă]\s*nr\.?)\s*[:#.]?',
    'supplierTaxId': r'(?:vat\s*(?:reg(?:istration)?\.?\s*)?(?:no\.?|number|id|#)|tax\s*(?:id|no\.?|number)|tin|ein|abn|gstin|gst\s*(?:no\.?|number)|cui|cif|c\.i\.f\.|idno|cod\s*fiscal|ust-?id(?:nr\.?)?|ust-?idnr\.?|steuernummer|n[°º]\s*tva|btw(?:-?nummer|\s*nr\.?)?|nip|nif|p\.?\s*iva|partita\s*iva)\s*[:#.]?',
    'customerName': r'(?:bill(?:ed)?\s*to|invoice\s*to|sold\s*to|customer|client|buyer|cump[aă]r[aă]tor|beneficiar|kunde|rechnungsempf[äa]nger|factur[ée]\s*[àa]|klant|cliente|destinatario)\s*[:.]?',
    'supplierName': r'(?:from|seller|supplier|vendor|sold\s*by|issued\s*by|bill\s*from|furnizor|v[âa]nz[aă]tor|lieferant|verk[äa]ufer|fournisseur|vendeur|leverancier|proveedor|fornitore)\s*[:.]?',
}
LABEL_RES = {k: re.compile(rf'^(?:{v})\s*', re.I) for k, v in LABELS.items()}
# "a label": the label word followed by ':' / '#' or nothing else ("Client Exemplu SRL" is a name, not a label)
ANY_LABEL = re.compile('|'.join(rf'(?:^(?:{v})\s*(?:$|(?<=[:#])))' for v in LABELS.values()), re.I)
NAME_FIELDS = ('customerName', 'supplierName')

SUBTOTAL_RE = re.compile(r'sub\s*-?\s*total|net\s*(?:amount|total|value)|total\s*(?:excl|net|before|without|w/o|fără|ohne|hors|ht\b|exkl)|amount\s*before\s*tax|zwischensumme|nettobetrag|total\s*ht|base\s*imponible|imponibile|subtotaal', re.I)
TAX_RE = re.compile(r'\b(vat|tax|gst|hst|pst|tva|mwst|ust|iva|btw|igv|sales\s*tax)\b', re.I)
TOTAL_STRONG_RE = re.compile(r'grand\s*total|total\s*(?:amount\s*)?due|amount\s*due|balance\s*due|total\s*(?:incl|including|with|gross|brut|ttc|inkl)|total\s*to\s*pay|total\s*de\s*plat[aă]|de\s*plat[aă]|gesamtbetrag|rechnungsbetrag|endbetrag|montant\s*total|total\s*ttc|te\s*betalen|totale\s*(?:fattura|documento)|amount\s*payable|total\s*payable|invoice\s*total', re.I)
TOTAL_RE = re.compile(r'^\s*(?:total|totaal|totale|gesamt|summe|suma|amount)\b', re.I)
AMOUNT_AT_END = re.compile(r'^(?P<label>.*?[A-Za-zÀ-ž%)\]:])\s*(?P<amt>[-(]?\s*(?:[$€£]|[A-Z]{3})?\s*-?\d[\d.,\s\']*\d(?:\s*(?:[$€£]|[A-Z]{3}))?\)?)\s*$')
IBAN_RE = re.compile(r'\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b')
PAGE_RE = re.compile(r'^\s*(page|pagina|seite|p\.)\s*\d+(\s*(of|/|din|von|de)\s*\d+)?\s*$', re.I)

ROLE_PATTERNS = [
    ('lineNumber', r'^(#|no\.?|nr\.?|n[°º]\.?|pos\.?|position|line|item\s*#|nr\.?\s*crt\.?|ln)$'),
    ('unit', r'^(unit|uom|u\.?\s*m\.?|um|einheit|unité|eenheid|unidad|unità|unit of measure)$'),
    ('discount', r'(discount|disc\.?|rabatt|remise|reducere|korting|descuento|sconto)'),
    ('taxAmount', r'((vat|tax|tva|mwst|gst|btw|iva)\s*(amount|amt|sum|value|valoare|betrag|montant))|^(tax|vat)\s*\$'),
    ('taxRate', r'^((vat|tax|tva|mwst|ust|gst|btw|iva)\s*(%|rate|cota)?|%|cota\s*tva|tax\s*%|vat\s*%)$'),
    ('unitPrice', r'(unit\s*price|price\s*(per|/)\s*unit|unit\s*cost|^price$|^rate$|^cost$|pre[țt](\s*unitar)?|^preis$|einzelpreis|prix(\s*unitaire)?|p\.\s*u\.?|prijs|precio|prezzo|^unit\s*rate$|^price\s*\(|^rate\s*\()'),
    ('quantity', r'(^qty|quantity|^quant|^units$|^hours?$|^hrs$|cant(itate)?|menge|anzahl|qté|quantité|aantal|cantidad|quantità|^pcs$|^count$)'),
    ('sku', r'(sku|item\s*code|^code$|part\s*(no|number|#)|article\s*(no|number|#)|art\.?\s*nr|^ref|cod(\s*produs)?$|artikelnummer|^item\s*(no|#|number)$)'),
    ('lineTotal', r'(amount|total|line\s*total|^net|^sum|value|valoare|betrag|gesamt|montant|importe|importo|bedrag|^subtotal$|^extended)'),
    ('description', r'(description|^item|product|service|details|particulars|article|designation|denumire|descriere|bezeichnung|beschreibung|leistung|libell[ée]|descrizione|omschrijving|descripci[oó]n|^goods|^name$|^activity$)'),
]
ROLE_RES = [(r, re.compile(p, re.I)) for r, p in ROLE_PATTERNS]
NUMERIC_ROLES = ('quantity', 'unitPrice', 'lineTotal', 'taxRate', 'taxAmount', 'discount')


def looks_like_invoice(first_page_text: str) -> bool:
    return bool(INVOICE_WORDS.search(first_page_text or ''))


def map_roles(header: list[str]) -> dict:
    """Map column index -> role from header names."""
    roles = {}
    used = set()
    for k, name in enumerate(header):
        n = (name or '').strip()
        if not n:
            continue
        for role, rx in ROLE_RES:
            if rx.search(n):
                if role == 'lineTotal' and role in used:
                    # the right-most amount column wins (e.g. "Net" then "Gross")
                    old = next(i for i, r in roles.items() if r == 'lineTotal')
                    del roles[old]
                elif role in used:
                    continue
                roles[k] = role
                used.add(role)
                break
    return roles


def _seg_value_after(lines, li, si, label_re):
    """Value for a label found in segment si of line li: rest of the segment, else next segment, else below."""
    ln = lines[li]
    seg = ln.segments[si]
    text = ' '.join(w.text for w in seg)
    m = label_re.match(text)
    rest = text[m.end():].strip(' :#.-') if m else ''
    if rest and not ANY_LABEL.match(rest):
        return rest
    if si + 1 < len(ln.segments):
        nxt = ' '.join(w.text for w in ln.segments[si + 1])
        if not ANY_LABEL.match(nxt):
            return nxt
    # the line below, a segment that starts under the label
    x0, x1 = seg[0].x0, seg[-1].x1
    for below in lines[li + 1: li + 3]:
        if below.top - ln.bottom > 3 * ln.size:
            break
        for s in below.segments:
            if s[0].x0 < x1 + 20 and s[-1].x1 > x0 - 5:
                t = ' '.join(w.text for w in s)
                return None if ANY_LABEL.match(t) else t
    return None


def find_labeled(lines, field):
    rx = LABEL_RES[field]
    for li, ln in enumerate(lines):
        for si, seg in enumerate(ln.segments):
            text = ' '.join(w.text for w in seg)
            # A label may sit inside a longer segment ("Tax ID: 00-0000142  Invoice No: X" is split at gaps,
            # but "Invoice No: X" can follow other words with a single space).
            m = re.search(rf'(?:^|\s)((?:{LABELS[field]}))', text, re.I)
            if not m:
                continue
            if field in NAME_FIELDS and not re.match(rf'(?:{LABELS[field]})\s*(?:$|(?<=[:#]))', text[m.start(1):], re.I):
                continue  # names need "Customer:" / "Bill to" alone, not "Client Exemplu SRL"
            if m.start(1) > 0:
                tail = text[m.start(1):]
                mm = rx.match(tail)
                rest = tail[mm.end():].strip(' :#.-') if mm else ''
                if rest:
                    return rest, li
                continue
            v = _seg_value_after(lines, li, si, rx)
            if v:
                return v, li
    return None, None


def _clean_id(v):
    if not v:
        return None
    v = v.strip().split()[0] if re.match(r'^[A-Z0-9][\w\-/.]*\s', v.strip(), re.I) else v.strip()
    v = v.strip(' .,:;')
    return v if re.search(r'\d', v) and len(v) <= 40 else None


def _supplier_from_layout(lines, page_height):
    """Largest text near the top of page 1 that is not the word 'Invoice', a label or a date."""
    best = None
    for ln in lines:
        if ln.top > page_height * 0.35:
            break
        for seg in ln.segments:
            t = ' '.join(w.text for w in seg).strip()
            size = max(w.size for w in seg)
            if (len(t) < 3 or INVOICE_WORDS.fullmatch(t) or re.fullmatch(r'(?i)(tax\s+)?invoice|factur[aă](\s+fiscal[aă])?|rechnung|facture|receipt|bill|statement|proforma(\s+invoice)?', t)
                    or ANY_LABEL.search(t) or parse_date(t) or PAGE_RE.match(t) or not re.search(r'[A-Za-zÀ-ž]{2}', t)
                    or '@' in t or re.match(r'^(https?://|www\.)', t, re.I)):
                continue
            if best is None or size > best[0] + 0.5:
                best = (size, t)
    return best[1] if best else None


def find_totals(all_lines, decimal_comma):
    """Subtotal, tax amount, tax rate and total from 'label .... amount' lines."""
    found = {'subtotal': None, 'taxAmount': None, 'taxRate': None, 'total': None}
    total_strong = None
    for ln in all_lines:
        text = ' '.join(w.text for w in ln.words)
        m = AMOUNT_AT_END.match(text)
        if not m:
            continue
        label = m.group('label')
        amount = parse_number(m.group('amt').strip(), decimal_comma)
        if amount is None or amount[2]:
            continue
        value = amount[0]
        # A totals label is short and holds no other numbers than a rate ("VAT 21%"); item lines have more.
        if len(label) > 50 or re.search(r'\d', re.sub(r'\(?\d{1,2}(?:[.,]\d{1,3})?\s*%\)?', '', label)):
            continue
        if SUBTOTAL_RE.search(label):
            found['subtotal'] = value
        elif TOTAL_STRONG_RE.search(label):
            total_strong = value
        elif TAX_RE.search(label) and not re.search(r'(?i)\b(id|no\.?|number|reg)\b', label):
            if re.search(r'(?i)total', label) and re.search(r'(?i)incl', label):
                total_strong = value
            else:
                found['taxAmount'] = value if found['taxAmount'] is None else found['taxAmount'] + value
                r = re.search(r'(\d{1,2}(?:[.,]\d{1,2})?)\s*%', label)
                if r:
                    found['taxRate'] = float(r.group(1).replace(',', '.'))
        elif TOTAL_RE.search(label):
            found['total'] = value
    if total_strong is not None:
        found['total'] = total_strong
    return found


def _num(raw, decimal_comma):
    p = parse_number(raw, decimal_comma)
    return (p[0], p[1], p[2]) if p else (None, None, False)


def line_items(tables, decimal_comma):
    """Line items from the tables whose header looks like an invoice item table."""
    items = []
    last_roles = None
    last_ncols = None
    for t in tables:
        roles = map_roles(t.header) if t.header else None
        if roles and 'description' not in roles.values():
            # no description column: the widest text column is the description
            text_cols = [k for k in range(len(t.header)) if k not in roles and
                         sum(1 for r in t.rows if r[k] and parse_number(r[k], decimal_comma) is None) >= len(t.rows) / 2]
            if text_cols:
                roles[max(text_cols, key=lambda k: sum(len(r[k]) for r in t.rows))] = 'description'
        is_items = roles and 'description' in roles.values() and ({'lineTotal', 'unitPrice'} & set(roles.values()))
        if not is_items and not t.header and last_roles and len(t.rows[0]) == last_ncols:
            roles, is_items = last_roles, True  # continuation of the item table on the next page, without header
        if not is_items:
            continue
        last_roles, last_ncols = roles, len(t.header or t.rows[0])
        names = t.header or [f'col_{k + 1}' for k in range(len(t.rows[0]))]
        inv = {r: k for k, r in roles.items()}
        for row in t.rows:
            def get(role, row=row, inv=inv):
                return row[inv[role]] if role in inv and inv[role] < len(row) else ''
            desc = get('description')
            nums = {r: _num(get(r), decimal_comma) for r in NUMERIC_ROLES if r in inv}
            has_numbers = any(v[0] is not None for v in nums.values())
            if not any(c for c in row):
                continue
            if desc and not has_numbers:
                if items and items[-1]['_table'] is t:
                    items[-1]['description'] = f"{items[-1]['description']} {desc}".strip()
                continue
            if re.match(r'(?i)^\s*(sub\s*-?\s*total|total|vat|tax|tva|mwst|balance|amount\s*due|grand\s*total|shipping\s*total)\b', desc or '') \
                    and sum(1 for c in row if c) <= 3:
                continue
            if not has_numbers:
                continue
            item = {'_table': t, 'page': t.page, 'description': desc or None}
            for role in ('lineNumber', 'sku', 'unit'):
                if role in inv:
                    item[role] = get(role) or None
            currency = None
            for role, (v, cur, _pct) in nums.items():
                item[role] = clean_number_value(v) if v is not None else None
                currency = currency or cur
            # a "VAT" column that holds money, not percentages
            if 'taxRate' in nums and nums['taxRate'][0] is not None and not nums['taxRate'][2] and nums['taxRate'][0] > 100:
                item['taxAmount'], item['taxRate'] = item.pop('taxRate'), None
            item['_currency'] = currency
            extra = {names[k]: row[k] for k in range(len(row)) if k not in roles and row[k]}
            if extra:
                item['otherColumns'] = extra
            q, p, a = item.get('quantity'), item.get('unitPrice'), item.get('lineTotal')
            if q is not None and p is not None and a is not None:
                disc = item.get('discount') or 0
                expected = q * p
                ok = any(abs(x - a) <= max(0.011, 0.005 * abs(a)) for x in (expected, expected - abs(disc), expected * (1 - abs(disc) / 100) if disc else expected))
                item['lineCheck'] = 'ok' if ok else 'mismatch'
            elif a is None and q is not None and p is not None:
                item['lineTotal'] = clean_number_value(q * p)
                item['lineCheck'] = 'computed'
            else:
                item['lineCheck'] = None
            items.append(item)
    for k, it in enumerate(items, 1):
        it['lineIndex'] = k
    return items


def extract_invoice(pages, tables, decimal_comma, date_order='auto'):
    """pages: list of dicts {page, lines, height, text}. Returns (invoice_fields, items)."""
    first = pages[0]
    all_lines = [ln for p in pages for ln in p['lines']]
    full_text = '\n'.join(p['text'] for p in pages)
    fields = {}

    v, _ = find_labeled(all_lines, 'invoiceNumber')
    fields['invoiceNumber'] = _clean_id(v)
    for f in ('invoiceDate', 'dueDate'):
        v, _ = find_labeled(all_lines, f)
        fields[f] = parse_date(v, date_order, decimal_comma) if v else None
    if not fields['invoiceDate']:
        for ln in first['lines']:
            t = ' '.join(w.text for w in ln.words)
            if re.search(r'(?i)\bdate\b|\bdata\b|\bdatum\b|\bfecha\b', t) and not LABEL_RES['dueDate'].search(t):
                d = parse_date(t, date_order, decimal_comma)
                if d:
                    fields['invoiceDate'] = d
                    break
    v, _ = find_labeled(all_lines, 'poNumber')
    fields['poNumber'] = _clean_id(v)
    v, _ = find_labeled(first['lines'], 'supplierName')
    fields['supplierName'] = v if v and not ANY_LABEL.match(v) else _supplier_from_layout(first['lines'], first['height'])
    v, _ = find_labeled(all_lines, 'supplierTaxId')
    fields['supplierTaxId'] = (v.split('  ')[0].strip()[:40] if v else None)
    if fields['supplierTaxId'] and not re.search(r'\d', fields['supplierTaxId']):
        fields['supplierTaxId'] = None
    v, _ = find_labeled(first['lines'], 'customerName')
    fields['customerName'] = v

    items = line_items(tables, decimal_comma)
    totals = find_totals(all_lines, decimal_comma)
    fields.update(totals)
    if fields['taxRate'] is None:
        rates = {it.get('taxRate') for it in items if it.get('taxRate') is not None}
        if len(rates) == 1:
            fields['taxRate'] = rates.pop()
    if fields['total'] is None and fields['subtotal'] is not None and fields['taxAmount'] is not None:
        fields['total'] = clean_number_value(fields['subtotal'] + fields['taxAmount'])
    for k in ('subtotal', 'taxAmount', 'total', 'taxRate'):
        if fields[k] is not None:
            fields[k] = clean_number_value(fields[k])

    currency = next((it['_currency'] for it in items if it.get('_currency')), None) or detect_currency(full_text)
    fields['currency'] = currency
    fields['iban'] = None
    labeled = re.search(r'(?i)\bIBAN\b\s*[:.]?\s*([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)', full_text)
    candidates = [labeled.group(1)] if labeled else [m.group(1) for m in IBAN_RE.finditer(full_text)]
    for c in candidates:
        c = c.replace(' ', '')
        if 15 <= len(c) <= 34 and c != (fields['supplierTaxId'] or '').replace(' ', ''):
            fields['iban'] = c
            break

    # Cross-checks
    sums = [it['lineTotal'] for it in items if isinstance(it.get('lineTotal'), (int, float))]
    check = None
    if sums:
        s = sum(sums)
        targets = [x for x in (fields['subtotal'], fields['total']) if x is not None]
        if targets:
            check = 'ok' if any(abs(s - x) <= max(0.02, 0.001 * abs(x)) for x in targets) else 'mismatch'
        fields['linesSum'] = clean_number_value(s)
    if fields['subtotal'] is not None and fields['taxAmount'] is not None and fields['total'] is not None:
        ok2 = abs(fields['subtotal'] + fields['taxAmount'] - fields['total']) <= 0.02
        check = 'ok' if (check in (None, 'ok') and ok2) else 'mismatch'
    fields['totalsCheck'] = check
    return fields, items
