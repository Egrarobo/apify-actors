"""Table detection on one PDF page.

Two methods, used together in 'auto':
- 'lines': tables drawn with ruling lines (cell borders), found by pdfplumber's line-based table finder;
- 'text':  borderless tables, found from aligned columns of words: consecutive lines that have two or more
           widely separated text groups form a block; the block's columns are the x-ranges that the data lines
           cover, separated by empty vertical gutters.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from statistics import median

from .numbers import is_numeric_cell

SEG_GAP_EM = 0.9      # gap (in font sizes) that separates two text groups on a line ("columns")
GUTTER_EM = 0.4       # minimum width of an empty vertical gutter between two columns
MAX_HEADER_ROWS = 5
BULLET_RE = re.compile(r'|\(cid:\d+\)|[•●▪◦■□➢►▶✓✔·*\-–—\uf0a7\uf0b7]')


@dataclass
class Word:
    x0: float
    x1: float
    top: float
    bottom: float
    text: str
    size: float
    bold: bool


@dataclass
class Line:
    top: float
    bottom: float
    size: float
    words: list = field(default_factory=list)
    segments: list = field(default_factory=list)  # list[list[Word]]

    @property
    def text(self) -> str:
        return ' '.join(w.text for w in self.words)

    def seg_text(self, i: int) -> str:
        return ' '.join(w.text for w in self.segments[i])


@dataclass
class Table:
    page: int
    method: str
    bbox: tuple
    rows: list                 # list[list[str]] (body rows)
    header: list | None        # column names (None = no header found)
    title: str = ''
    bold_rows: list = field(default_factory=list)


def page_words(page, exclude=()) -> list[Word]:
    words = page.extract_words(x_tolerance=2, y_tolerance=2, keep_blank_chars=False, use_text_flow=False,
                               extra_attrs=['size', 'fontname'])
    out = []
    for w in words:
        cx, cy = (w['x0'] + w['x1']) / 2, (w['top'] + w['bottom']) / 2
        if any(b[0] - 1 <= cx <= b[2] + 1 and b[1] - 1 <= cy <= b[3] + 1 for b in exclude):
            continue
        out.append(Word(w['x0'], w['x1'], w['top'], w['bottom'], w['text'], float(w.get('size') or 10),
                        'bold' in str(w.get('fontname', '')).lower() or 'black' in str(w.get('fontname', '')).lower()))
    return out


def build_lines(words: list[Word]) -> list[Line]:
    """Group words into visual lines (same baseline), then split each line into segments at wide gaps."""
    lines: list[Line] = []
    for w in sorted(words, key=lambda w: (round(w.bottom, 1), w.x0)):
        cur = lines[-1] if lines else None
        if cur and abs(w.bottom - cur.bottom) <= max(1.5, 0.35 * min(w.size, cur.size)):
            cur.words.append(w)
            cur.top = min(cur.top, w.top)
            cur.size = max(cur.size, w.size)
        else:
            lines.append(Line(top=w.top, bottom=w.bottom, size=w.size, words=[w]))
    for ln in lines:
        ln.words.sort(key=lambda w: w.x0)
        segs = [[ln.words[0]]]
        for prev, w in zip(ln.words, ln.words[1:]):
            if w.x0 - prev.x1 > SEG_GAP_EM * min(prev.size, w.size):
                segs.append([w])
            else:
                segs[-1].append(w)
        ln.segments = segs
    lines.sort(key=lambda ln: ln.top)
    return lines


def _numeric_line(ln: Line, decimal_comma: bool) -> bool:
    # A segment counts as numeric if any of its words is a number (e.g. "61.00 - 94.00", "$24.90").
    for k, seg in enumerate(ln.segments):
        if k == 0 and len(ln.segments) > 2:
            continue  # the first column is usually a label
        if any(is_numeric_cell(w.text, decimal_comma) for w in seg):
            return True
    return False


def _columns(lines: list[Line], size: float) -> list[tuple]:
    """Covered x-ranges of the words in `lines`, merged across small gaps: one range per column."""
    spans = sorted((w.x0, w.x1) for ln in lines for w in ln.words)
    cols = []
    for x0, x1 in spans:
        if cols and x0 - cols[-1][1] < GUTTER_EM * size:
            cols[-1][1] = max(cols[-1][1], x1)
        else:
            cols.append([x0, x1])
    return [tuple(c) for c in cols]


def _assign(ln: Line, cols: list[tuple]) -> list[str]:
    cells = [[] for _ in cols]
    for w in ln.words:
        cx = (w.x0 + w.x1) / 2
        best, best_d = 0, None
        for k, (a, b) in enumerate(cols):
            d = 0 if a - 1 <= cx <= b + 1 else min(abs(cx - a), abs(cx - b))
            if best_d is None or d < best_d:
                best, best_d = k, d
        cells[best].append(w.text)
    return [_clean(' '.join(c)) for c in cells]


def _clean(s) -> str:
    s = re.sub(r'\s*(?:\.\s?){4,}\s*', ' ', str(s or ''))  # dot leaders: "Crude Oil ........ 707.1"
    return re.sub(r'\s+', ' ', s).strip()


def _header_names(header_rows: list[list[str]], ncols: int) -> list[str]:
    names = []
    for k in range(ncols):
        names.append(_clean(' '.join(r[k] for r in header_rows if k < len(r) and r[k])))
    return names


def unique_names(names: list[str]) -> list[str]:
    out, seen = [], {}
    for k, n in enumerate(names):
        n = n or f'col_{k + 1}'
        if n in seen:
            seen[n] += 1
            n = f'{n}_{seen[n]}'
        else:
            seen[n] = 1
        out.append(n)
    return out


def _split_header(rows: list[list[str]], bold: list[bool], decimal_comma: bool, ruled: bool):
    """Leading non-numeric rows followed by a numeric row are the header (up to 5 short rows)."""
    numeric = [any(is_numeric_cell(c, decimal_comma) for c in r[1:] if c) or (len(r) == 1 and is_numeric_cell(r[0], decimal_comma)) for r in rows]
    if any(numeric):
        first = numeric.index(True)
        if 0 < first <= MAX_HEADER_ROWS and all(len(c) <= 40 for r in rows[:first] for c in r):
            return rows[:first], rows[first:]
        if first == 0:
            return [], rows
    if len(rows) >= 2 and (ruled or (bold and bold[0] and not any(bold[1:]))):
        return rows[:1], rows[1:]
    return [], rows


def _drop_empty_columns(header, rows):
    ncols = max([len(r) for r in rows] + [len(header or [])] + [0])
    rows = [list(r) + [''] * (ncols - len(r)) for r in rows]
    keep = [k for k in range(ncols) if any(r[k] for r in rows) or (header and k < len(header) and header[k])]
    rows = [[r[k] for k in keep] for r in rows]
    if header is not None:
        header = [header[k] if k < len(header) else '' for k in keep]
    return header, rows


def ruled_tables(page, page_no: int, decimal_comma: bool) -> list[Table]:
    out = []
    try:
        found = page.find_tables({'vertical_strategy': 'lines', 'horizontal_strategy': 'lines', 'snap_tolerance': 3,
                                  'intersection_tolerance': 3})
    except Exception:  # noqa: BLE001 - malformed drawing operators: just fall back to text tables
        return out
    for t in found:
        try:
            raw = t.extract()
        except Exception:  # noqa: BLE001
            continue
        rows = [[_clean(c) for c in r] for r in raw if r and any(_clean(c) for c in r)]
        if len(rows) < 2 or max(len(r) for r in rows) < 2:
            continue
        filled = sum(1 for r in rows for c in r if c)
        if filled < 0.3 * sum(len(r) for r in rows):
            continue
        head_rows, body = _split_header(rows, [], decimal_comma, ruled=True)
        header = _header_names(head_rows, len(rows[0])) if head_rows else None
        header, body = _drop_empty_columns(header, body)
        if not body:
            continue
        out.append(Table(page=page_no, method='lines', bbox=tuple(t.bbox), rows=body,
                         header=unique_names(header) if header else None))
    return out


def text_tables(lines: list[Line], page_no: int, decimal_comma: bool, min_rows: int = 2) -> list[Table]:
    """Borderless tables from aligned columns."""
    tables = []
    i = 0
    n = len(lines)
    while i < n:
        if len(lines[i].segments) < 2:
            i += 1
            continue
        block = [lines[i]]
        j = i + 1
        while j < n:
            prev, ln = block[-1], lines[j]
            gap = ln.top - prev.bottom
            if gap > 1.6 * max(prev.size, ln.size):
                break
            if len(ln.segments) >= 2:
                block.append(ln)
                j += 1
                continue
            # A one-group line inside a table (wrapped description) when the next line is tabular again.
            nxt = lines[j + 1] if j + 1 < n else None
            if (nxt and len(nxt.segments) >= 2 and nxt.top - ln.bottom <= 1.6 * max(ln.size, nxt.size)
                    and len(prev.segments) >= 2 and ln.words[-1].x1 < prev.segments[1][0].x0):
                block.append(ln)
                j += 1
                continue
            break
        i = j
        if len(block) < min_rows:
            continue
        size = median(ln.size for ln in block)
        numeric = [ln for ln in block if len(ln.segments) >= 2 and _numeric_line(ln, decimal_comma)]
        basis = numeric if len(numeric) >= 2 else [ln for ln in block if len(ln.segments) >= max(2, int(median(len(b.segments) for b in block)))]
        cols = _columns(basis, size)
        if len(cols) < 2:
            continue
        rows = [_assign(ln, cols) for ln in block]
        bold = [all(w.bold for w in ln.words) for ln in block]
        head_rows, body = _split_header(rows, bold, decimal_comma, ruled=False)
        if len(body) < 1 or (not head_rows and len(body) < min_rows):
            continue
        header = _header_names(head_rows, len(cols)) if head_rows else None
        header, body = _drop_empty_columns(header, body)
        # bullet markers are not a column ("•  Health insurance")
        bullets = [k for k in range(len(body[0])) if all(BULLET_RE.fullmatch(r[k]) for r in body)]
        if bullets:
            body = [[c for k, c in enumerate(r) if k not in bullets] for r in body]
            header = [c for k, c in enumerate(header) if k not in bullets] if header else None
        if len(body[0]) < 2:
            continue
        # two-column prose is not a table: no numbers and long cells
        cells = [c for r in body for c in r if c]
        if not any(is_numeric_cell(c, decimal_comma) for c in cells) and sum(map(len, cells)) / max(1, len(cells)) > 25:
            continue
        # Title: up to two single-group lines right above the block.
        title_lines = []
        k = lines.index(block[0]) - 1
        top_ref = block[0].top
        while k >= 0 and len(title_lines) < 2:
            ln = lines[k]
            if len(ln.segments) != 1 or top_ref - ln.bottom > 1.6 * max(ln.size, size) or len(ln.text) > 120:
                break
            title_lines.insert(0, ln.text)
            top_ref = ln.top
            k -= 1
        x0 = min(w.x0 for ln in block for w in ln.words)
        x1 = max(w.x1 for ln in block for w in ln.words)
        tables.append(Table(page=page_no, method='text', bbox=(x0, block[0].top, x1, block[-1].bottom), rows=body,
                            header=unique_names(header) if header else None, title=' · '.join(title_lines),
                            bold_rows=bold[len(head_rows):]))
    return tables


def extract_page(page, page_no: int, decimal_comma: bool, strategy: str = 'auto'):
    """Return (tables, lines) for a page. `lines` covers the whole page (used for invoice fields)."""
    tables = []
    if strategy in ('auto', 'lines'):
        tables = ruled_tables(page, page_no, decimal_comma)
    all_lines = build_lines(page_words(page))
    if strategy in ('auto', 'text'):
        rest = build_lines(page_words(page, exclude=[t.bbox for t in tables])) if tables else all_lines
        tables += text_tables(rest, page_no, decimal_comma)
    tables.sort(key=lambda t: (t.bbox[1], t.bbox[0]))
    return tables, all_lines
