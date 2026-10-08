"""Numbers, money, percentages and dates as they appear in invoices and price tables."""
from __future__ import annotations

import re
from datetime import date

CURRENCY_SYMBOLS = {'$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₽': 'RUB', '₴': 'UAH', '₺': 'TRY', 'zł': 'PLN', 'lei': 'RON', 'kr': 'SEK', 'Kč': 'CZK', 'Fr.': 'CHF'}
CURRENCY_CODES = ('USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'INR', 'RON', 'MDL', 'PLN', 'CZK', 'HUF', 'SEK', 'NOK', 'DKK',
                  'UAH', 'RUB', 'TRY', 'BGN', 'KZT', 'ZAR', 'BRL', 'MXN', 'SGD', 'HKD', 'AED', 'ILS')
_CODES_RE = '|'.join(CURRENCY_CODES)
_SYMBOLS_RE = r'[$€£¥₹₽₴₺]'

# A number as printed: optional sign/parentheses, currency before or after, grouping with , . space or '.
NUMBER_RE = re.compile(
    rf"""^\s*(?P<neg1>[-−–(])?\s*(?:(?P<cur1>{_SYMBOLS_RE}|(?:{_CODES_RE})\b)\s*)?(?P<neg2>[-−–])?\s*
    (?P<num>\d{{1,3}}(?:[ ,.'  ]\d{{3}})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?|[.,]\d+)
    \s*(?P<cur2>{_SYMBOLS_RE}|(?:{_CODES_RE})\b|zł|lei|kr|Kč)?\s*(?P<pct>%)?\s*(?P<neg3>[)-])?\s*$""",
    re.X | re.I,
)


def detect_decimal_comma(text: str) -> bool:
    """True when the document writes decimals with a comma (1.234,56 / 12,50), False for 1,234.56 / 12.50."""
    comma = len(re.findall(r'(?<![\d.,])\d+,\d{1,2}(?![\d,.])', text)) + 2 * len(re.findall(r'\d\.\d{3},\d', text))
    dot = (len(re.findall(r'(?<![\d.,])\d+\.\d{1,2}(?![\d,.])', text)) + 2 * len(re.findall(r'\d,\d{3}\.\d', text))
           + len(re.findall(r'(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d,.])', text)))
    return comma > dot


def parse_number(raw, decimal_comma: bool = False):
    """Parse '1,234.50', '1.234,50', '$12', '(15.00)', '21%', 'EUR 3.800,90'. Returns (value, currency, is_percent) or None."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw), None, False
    s = str(raw).strip()
    if not s or len(s) > 40:
        return None
    m = NUMBER_RE.match(s)
    if not m:
        return None
    num = m.group('num')
    seps = [c for c in num if not c.isdigit()]
    if not seps:
        value = float(num)
    else:
        last = seps[-1]
        groups = re.split(r"[ ,.'  ]", num)
        if len(set(seps)) > 1:
            dec = last  # '1,234.56' or '1.234,56': the last separator is the decimal one
        elif last in " '  ":
            dec = None
        elif len(seps) > 1:
            dec = None  # '1,234,567' or '1.234.567'
        elif len(groups[-1]) == 3 and groups[0] not in ('', '0'):
            # '1,234' or '1.234': thousands unless the document uses that sign as decimal separator.
            dec = last if (last == ',') == decimal_comma else None
        else:
            dec = last
        intpart, frac = (num.rsplit(dec, 1) if dec else (num, ''))
        intpart = re.sub(r"[^\d]", '', intpart) or '0'
        value = float(f'{intpart}.{frac}' if frac else intpart)
    if m.group('neg1') or m.group('neg2') or m.group('neg3'):
        if m.group('neg1') == '(' and m.group('neg3') != ')':
            return None
        if m.group('neg1') != '(' and m.group('neg3') == ')':
            return None
        value = -value
    cur = m.group('cur1') or m.group('cur2')
    currency = None
    if cur:
        currency = CURRENCY_SYMBOLS.get(cur, cur.upper() if cur.upper() in CURRENCY_CODES else None)
    return value, currency, bool(m.group('pct'))


def to_number(raw, decimal_comma: bool = False):
    p = parse_number(raw, decimal_comma)
    return None if p is None else p[0]


def is_numeric_cell(raw, decimal_comma: bool = False) -> bool:
    return parse_number(raw, decimal_comma) is not None


def clean_number_value(v: float):
    """Return an int when the value has no fraction (12.0 -> 12), else round to 6 decimals."""
    if v is None:
        return None
    r = round(v, 6)
    return int(r) if r == int(r) and abs(r) < 1e15 else r


MONTHS = {m: i + 1 for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}
MONTHS.update({'ian': 1, 'mai': 5, 'iun': 6, 'iul': 7, 'noi': 11, 'dez': 12, 'mär': 3, 'mrz': 3, 'okt': 10, 'sept': 9, 'janv': 1, 'févr': 2, 'avr': 4, 'juin': 6, 'juil': 7, 'août': 8, 'déc': 12})
_MONTH_RE = r'(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|ian|iun|iul|noi|dez|mär|mrz|okt|janv|févr|avr|juin|juil|août|déc)[a-zăâîșțéû]*\.?'

DATE_RE = re.compile(
    rf"""(?P<iso>\b(?P<y1>\d{{4}})[-./](?P<m1>\d{{1,2}})[-./](?P<d1>\d{{1,2}})\b)
    |(?P<num>\b(?P<a>\d{{1,2}})[-./](?P<b>\d{{1,2}})[-./](?P<y2>\d{{4}}|\d{{2}})\b)
    |(?P<dmy>\b(?P<d3>\d{{1,2}})(?:st|nd|rd|th)?\.?\s+(?P<mon3>{_MONTH_RE})\s*,?\s*(?P<y3>\d{{4}})\b)
    |(?P<mdy>\b(?P<mon4>{_MONTH_RE})\s+(?P<d4>\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(?P<y4>\d{{4}})\b)""",
    re.X | re.I,
)


def _month(name: str):
    n = name.lower().rstrip('.')
    for k in sorted(MONTHS, key=len, reverse=True):
        if n.startswith(k):
            return MONTHS[k]
    return None


def _mk(y, m, d):
    try:
        return date(int(y), int(m), int(d)).isoformat()
    except (TypeError, ValueError):
        return None


def parse_date(text: str, prefer: str = 'auto', decimal_comma: bool = False):
    """Find the first date in text and return ISO 'YYYY-MM-DD' (or None).

    prefer: 'DMY', 'MDY' or 'auto' for ambiguous 03/04/2026 (auto = DMY when the document uses decimal commas
    or dots between date parts, MDY for US-style slashes otherwise)."""
    if not text:
        return None
    m = DATE_RE.search(str(text))
    if not m:
        return None
    if m.group('iso'):
        return _mk(m.group('y1'), m.group('m1'), m.group('d1'))
    if m.group('num'):
        a, b, y = int(m.group('a')), int(m.group('b')), m.group('y2')
        y = int(y) + 2000 if len(y) == 2 else int(y)
        sep = re.search(r'[-./]', m.group('num')).group(0)
        if a > 12 and b <= 12:
            return _mk(y, b, a)
        if b > 12 and a <= 12:
            return _mk(y, a, b)
        order = prefer if prefer in ('DMY', 'MDY') else ('DMY' if (decimal_comma or sep in '.-') else 'MDY')
        return _mk(y, b, a) if order == 'DMY' else _mk(y, a, b)
    if m.group('dmy'):
        return _mk(m.group('y3'), _month(m.group('mon3')), m.group('d3'))
    if m.group('mdy'):
        return _mk(m.group('y4'), _month(m.group('mon4')), m.group('d4'))
    return None


def detect_currency(text: str):
    """Most frequent currency in the text (codes and symbols)."""
    counts = {}
    for code in re.findall(rf'\b({_CODES_RE})\b', text):
        counts[code] = counts.get(code, 0) + 1
    for sym, code in CURRENCY_SYMBOLS.items():
        if len(sym) == 1:
            n = text.count(sym)
            if n:
                counts[code] = counts.get(code, 0) + n
    return max(counts, key=counts.get) if counts else None
