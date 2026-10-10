"""Table detection on one PDF page.

Two methods, used together in 'auto':
- 'lines': tables drawn with ruling lines (cell borders), found by pdfplumber's line-based table finder;
- 'text':  borderless tables, found from aligned columns of words: consecutive lines that have two or more
           widely separated text groups form a block; the block's columns are the x-ranges that the data lines
           cover, separated by empty vertical gutters.
"""
from __future__ import annotations

import bisect
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
    colx: list = field(default_factory=list)  # x-range of each column (for header lines printed above it)


def page_words(page, exclude=()) -> list[Word]:
    page = dedupe(page)  # "fake bold" drawn twice with an offset: "TTooggoo" -> "Togo"
    pad = overlapping_spaces(page)
    if pad:
        page = page.filter(lambda o: o.get('object_type') != 'char' or
                           (round(o['x0'], 2), round(o['top'], 2), o.get('text')) not in pad)
    # Words are not split on a change of font (some PDFs mix two fonts inside one number: "90,559" drawn in
    # Helvetica and Arial), only on a clear change of size (a footnote mark next to a value).
    words = []
    for w in page.extract_words(x_tolerance=2, y_tolerance=2, keep_blank_chars=False, use_text_flow=False,
                                return_chars=True):
        run = []
        for ch in w.get('chars') or []:
            if run and not (0.83 <= ch['size'] / max(run[-1]['size'], 0.1) <= 1.2):
                words.append(_word_from_chars(run))
                run = []
            run.append(ch)
        if run:
            words.append(_word_from_chars(run))
    out = []
    for w in words:
        cx, cy = (w['x0'] + w['x1']) / 2, (w['top'] + w['bottom']) / 2
        if any(b[0] - 1 <= cx <= b[2] + 1 and b[1] - 1 <= cy <= b[3] + 1 for b in exclude):
            continue
        text, x0, x1 = w['text'], w['x0'], w['x1']
        # dot leaders ("total ………… 784,846") and form blanks ("___0.80 Apple Juice"): they would join the
        # label column to the first value column
        core = LEADER_RE.sub('', text)
        if core != text:
            if not core:
                continue
            step = (x1 - x0) / len(text)
            lead = len(text) - len(text.lstrip('.…‥·_ '))
            trail = len(text) - len(text.rstrip('.…‥·_ '))
            if lead >= 3 or (lead and text[:1] == '…'):
                x0 += step * lead
            if trail >= 3 or (trail and text[-1:] == '…'):
                x1 -= step * trail
            text = core
        out.append(Word(x0, x1, w['top'], w['bottom'], text, float(w.get('size') or 10), w['bold']))
    return _split_glued(drop_superscripts(out))


def _word_from_chars(chars: list) -> dict:
    bold = sum(1 for c in chars if 'bold' in str(c.get('fontname', '')).lower() or 'black' in str(c.get('fontname', '')).lower())
    return {'text': ''.join(c['text'] for c in chars), 'x0': min(c['x0'] for c in chars), 'x1': max(c['x1'] for c in chars),
            'top': min(c['top'] for c in chars), 'bottom': max(c['bottom'] for c in chars),
            'size': max(c['size'] for c in chars), 'bold': bold > len(chars) / 2}


LEADER_RE = re.compile(r'(?:[.…‥·_]\s?){3,}$|^(?:[.…‥·_]\s?){3,}|…+$|^…+')
SUPER_RE = re.compile(r'[0-9a-zA-Z,*†‡§¶#]{1,6}|\d{1,2}(?:,\d{1,2}){1,12}')


def drop_superscripts(words: list[Word]) -> list[Word]:
    """Footnote marks printed small and raised next to a word ("766,2961" with a small "1", "Aug.3", "Q2r") are
    not part of the value: left as they are, they glue onto numbers ("1 766,296" read as 1,766,296) or form a line
    of their own that splits the table. A word is a mark when it is short, at most 80% of the size of the word it
    touches, and raised above that word's baseline."""
    if len(words) < 2:
        return words
    by_row = {}
    for i, w in enumerate(words):
        by_row.setdefault(int(w.top // 10), []).append(i)
    drop = set()

    def touching(i):
        w = words[i]
        for b in (int(w.top // 10) - 1, int(w.top // 10), int(w.top // 10) + 1):
            for j in by_row.get(b, ()):
                # touching, or (a mark printed before its value, "¹ 22,650") a short gap to the right
                if j != i and (-1.0 <= w.x0 - words[j].x1 <= 2.5 or -1.0 <= words[j].x0 - w.x1 <= 1.2 * words[j].size):
                    yield j

    for i, w in enumerate(words):
        if not SUPER_RE.fullmatch(w.text):
            continue
        for j in touching(i):
            n = words[j]
            smaller = n.size * 0.82 >= w.size and w.bottom <= n.bottom - 0.15 * n.size and (
                -1.0 <= w.x0 - n.x1 <= 2.5 or -1.0 <= n.x0 - w.x1 <= 1.2 * n.size)
            same_size_raised = n.size >= w.size and w.bottom <= n.bottom - 0.25 * n.size and len(w.text) <= 3
            if w.bottom > n.top and (smaller or (same_size_raised and not SUPER_RE.fullmatch(n.text))):
                drop.add(i)
                break
    # marks in a chain ("18, 19"): a mark touching a dropped mark on the same baseline
    changed = True
    while changed:
        changed = False
        for i, w in enumerate(words):
            if i in drop or not SUPER_RE.fullmatch(w.text):
                continue
            if any(j in drop and abs(words[j].bottom - w.bottom) < 1 and abs(words[j].size - w.size) < 0.5 for j in touching(i)):
                drop.add(i)
                changed = True
    return [w for i, w in enumerate(words) if i not in drop] if drop else words


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
    s = re.sub(r'\s*(?:[.…]\s?){4,}\s*', ' ', str(s or ''))  # dot leaders: "Crude Oil ........ 707.1"
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
    # a row of column numbers or years under the column names ("Zone" / 1 2 3 ... 9, "2024 2025") is a header row
    for i in range(min(len(rows) - 1, MAX_HEADER_ROWS)):
        vals = [c for c in rows[i][1:] if c]
        if not numeric[i]:
            continue
        # column numbers, possibly with a name on the first one ("Canada 1 | 2 | 3")
        ints = [int(re.sub(r'\D', '', c)) for c in vals if re.fullmatch(r'(?:[A-Za-z][A-Za-z .]* )?\(?\d{1,4}\)?', c)]
        first_ok = not rows[i][0] or (i == 0 and not is_numeric_cell(rows[i][0], decimal_comma))  # "Fee Group | 1 2 3 4 5"
        if len(vals) >= 2 and len(ints) == len(vals) and first_ok and \
                (ints == list(range(ints[0], ints[0] + len(ints))) or all(1900 <= v <= 2100 for v in ints)):
            numeric[i] = False
        else:
            break
    if any(numeric):
        first = numeric.index(True)
        value_cols = {k for r, isnum in zip(rows, numeric) if isnum for k, c in enumerate(r) if k and is_numeric_cell(c, decimal_comma)}
        if 0 < first and not any(c for r in rows[:first] for k, c in enumerate(r) if k in value_cols):
            return [], rows  # "FY 2025", "Assets": section labels above the data, not column names
        if 0 < first <= MAX_HEADER_ROWS and all(len(c) <= 60 for r in rows[:first] for c in r):
            head = first
            # a section label right above the data ("Liabilities") stays in the body
            while head > 1 and not any(c for k, c in enumerate(rows[head - 1]) if k in value_cols):
                head -= 1
            return rows[:head], rows[head:]
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


def _column_lines_table(page, t, page_no: int, decimal_comma: bool):
    """A frame with column lines but no row lines: columns from the drawn lines, rows from the text lines."""
    xs = sorted({round(c[0], 1) for c in t.cells} | {round(c[2], 1) for c in t.cells})
    bounds = []
    for x in xs:
        if not bounds or x - bounds[-1] > 3:
            bounds.append(x)
    if len(bounds) < 3:
        return None
    x0, top, x1, bottom = t.bbox
    # the outer frame may be drawn only as horizontal rules (no left/right line): they give the real width
    hz = [e for e in page.edges if e.get('orientation') == 'h' and top - 2 <= e['top'] <= bottom + 2
          and e['x1'] > x0 and e['x0'] < x1]
    if hz:
        left, right = min(e['x0'] for e in hz), max(e['x1'] for e in hz)
        if left < bounds[0] - 3:
            bounds.insert(0, left)
        if right > bounds[-1] + 3:
            bounds.append(right)
        x0, x1 = bounds[0], bounds[-1]
    colx = list(zip(bounds, bounds[1:]))
    words = [w for w in page_words(page) if x0 - 1 <= (w.x0 + w.x1) / 2 <= x1 + 1 and top - 1 <= (w.top + w.bottom) / 2 <= bottom + 1]
    lines = build_lines(words)
    if len(lines) < 3:
        return None

    def cells_of(ln):
        cells = [[] for _ in colx]
        for w in ln.words:
            cx = (w.x0 + w.x1) / 2
            k = next((k for k, (a, b) in enumerate(colx) if a - 0.5 <= cx <= b + 0.5), None)
            if k is None:
                k = min(range(len(colx)), key=lambda k: min(abs(cx - colx[k][0]), abs(cx - colx[k][1])))
            cells[k].append(w.text)
        return [_clean(' '.join(c)) for c in cells]

    first = next((i for i, ln in enumerate(lines) if _data_line(ln, decimal_comma)), None)
    if first is None:
        return None
    rows = [cells_of(ln) for ln in lines]
    # label columns: text in most data rows
    data = rows[first:]
    label_cols = {k for k in range(len(colx)) if sum(1 for r in data if r[k] and not is_numeric_cell(r[k], decimal_comma)) >
                  sum(1 for r in data if r[k] and is_numeric_cell(r[k], decimal_comma))}
    head = first
    while head > 0 and all(not c or k in label_cols for k, c in enumerate(rows[head - 1])) and \
            not any(c for k, c in enumerate(rows[head - 1]) if k not in label_cols):
        # a label line right above the data ("Retail & food services,") belongs to the body
        if sum(1 for c in rows[head - 1] if c) > 1:
            break
        head -= 1
    hl = lines[:head]
    title = []
    # title lines inside the frame: one group of words, either wide or starting at the left edge and running
    # past the first column
    while hl and len(hl[0].segments) == 1 and (hl[0].words[-1].x1 - hl[0].words[0].x0 > 0.5 * (x1 - x0) or
                                               (hl[0].words[0].x0 < x0 + 0.1 * (x1 - x0) and hl[0].words[-1].x1 > colx[0][1] + 2)):
        title.append(hl.pop(0).text)
    title = ' '.join(title)
    vedges = [e for e in page.edges if e.get('orientation') == 'v' and x0 - 2 <= e['x0'] <= x1 + 2]
    header = _header_from_lines(hl, colx, vedges) if hl else None
    header, body = _drop_empty_columns(header, rows[head:])
    if not body:
        return None
    return Table(page=page_no, method='lines', bbox=(x0, top, x1, bottom), rows=body,
                 header=unique_names(header) if header and any(header) else None, colx=colx, title=title)


_DEDUPE_CACHE: dict = {}


def dedupe(page):
    """Characters drawn twice (fake bold: "TTooggoo" for "Togo") removed; once per page."""
    key = (id(page.pdf), page.page_number, round(page.bbox[0], 1), round(page.bbox[1], 1), len(page.chars))
    if key not in _DEDUPE_CACHE:
        if len(_DEDUPE_CACHE) > 16:
            _DEDUPE_CACHE.clear()
        # cheap test first: the same character within 1.5 pt of itself
        seen, dup = set(), 0
        for c in page.chars:
            t = c.get('text', '')
            if not t.strip():
                continue
            gx, gy = int(c['x0']), int(c['top'])
            if any((t, gx + dx, gy + dy) in seen for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                dup += 1
            seen.add((t, gx, gy))
        try:
            _DEDUPE_CACHE[key] = page.dedupe_chars() if dup >= 3 else page
        except Exception:  # noqa: BLE001
            _DEDUPE_CACHE[key] = page
    return _DEDUPE_CACHE[key]


_SPACES_CACHE: dict = {}


def overlapping_spaces(page) -> set:
    """Space characters drawn on top of other characters (some PDFs pad right-aligned numbers this way):
    read in x order they split "1,444" into "1 ,444". Keys: (x0, top, text) rounded."""
    key = (id(page.pdf), page.page_number, round(page.bbox[0], 1), round(page.bbox[1], 1))
    if key in _SPACES_CACHE:
        return _SPACES_CACHE[key]
    chars = page.chars
    out = set()
    if any(c.get('text') == ' ' for c in chars):
        rows = {}
        for c in chars:
            if c.get('text', '').strip():
                rows.setdefault(int(c['top'] // 5), []).append((c['x0'], c['x1'], c['top']))
        for v in rows.values():
            v.sort()
        starts = {b: [x[0] for x in v] for b, v in rows.items()}
        for c in chars:
            if c.get('text') != ' ':
                continue
            w = c['x1'] - c['x0']
            hit = False
            for b in (int(c['top'] // 5) - 1, int(c['top'] // 5), int(c['top'] // 5) + 1):
                v = rows.get(b)
                if not v:
                    continue
                i = bisect.bisect_left(starts[b], c['x0'] - 20)
                while i < len(v) and v[i][0] <= c['x1']:
                    x0, x1, top = v[i]
                    if min(c['x1'], x1) - max(c['x0'], x0) > 0.5 * w and abs(top - c['top']) < 2:
                        hit = True
                        break
                    i += 1
                if hit:
                    out.add((round(c['x0'], 2), round(c['top'], 2), ' '))
                    break
    if len(_SPACES_CACHE) > 64:
        _SPACES_CACHE.clear()
    _SPACES_CACHE[key] = out
    return out


GLUED_RE = re.compile(r'[-−(]?\$?\d{1,3}(?:,\d{3})*\.\d+\)?|[-−(]?\$?\d{1,3}(?:,\d{3})+\)?')


def _split_glued(words: list[Word]) -> list[Word]:
    """Numbers printed so close that they read as one word ("$46.05$50.57$57.32", "-284,333-173,277"): split
    into one word each, with x positions in proportion to their characters. Only when every part is a number
    with a decimal part or thousands groups, so "2025-2026" or "9-16" stay as they are."""
    out = []
    for w in words:
        parts = GLUED_RE.findall(w.text)
        if not (len(parts) >= 2 and ''.join(parts) == w.text):
            # same number of decimals in each part ("10.1510.15" = 10.15 | 10.15)
            for d in (2, 1, 3):
                rx = re.compile(r'[-−(]?\$?\d{1,3}(?:,\d{3})*(?:\d*)\.\d{%d}\)?' % d)
                parts = rx.findall(w.text)
                if len(parts) >= 2 and ''.join(parts) == w.text:
                    break
        if len(parts) >= 2 and ''.join(parts) == w.text:
            step, x = (w.x1 - w.x0) / len(w.text), w.x0
            for p in parts:
                out.append(Word(x, x + step * len(p), w.top, w.bottom, p, w.size, w.bold))
                x += step * len(p)
        else:
            out.append(w)
    return out


def ruled_tables(page, page_no: int, decimal_comma: bool) -> list[Table]:
    out = []
    page = dedupe(page)
    try:
        found = page.find_tables({'vertical_strategy': 'lines', 'horizontal_strategy': 'lines', 'snap_tolerance': 3,
                                  'intersection_tolerance': 3})
    except Exception:  # noqa: BLE001 - malformed drawing operators: just fall back to text tables
        return out
    words = page_words(page) if found else []
    for t in found:
        try:
            raw = t.extract()
        except Exception:  # noqa: BLE001
            continue
        # Cell text from whole words, each placed in the cell under its centre: a number printed across a
        # column line stays whole ("1,843", not "1,84" | "3 558"); footnote marks, padding spaces and doubled
        # characters are already out of the words.
        for i, row in enumerate(t.rows):
            if i >= len(raw):
                break
            for k, c in enumerate(row.cells):
                if c is None or k >= len(raw[i]):
                    continue
                inside = [w for w in words if c[0] - 0.5 <= (w.x0 + w.x1) / 2 <= c[2] + 0.5
                          and c[1] - 0.5 <= (w.top + w.bottom) / 2 <= c[3] + 0.5]
                raw[i][k] = '\n'.join(ln.text for ln in build_lines(inside)) if inside else ''
        # Only the outer frame and the column lines drawn, no row lines: every cell holds a whole column of
        # values ("1.2\n1.4\n1.1"). The text method reads such a table row by row, so it is left to it.
        filled_raw = [c for r in raw if r for c in r if c and c.strip()]
        stacked = [c for c in filled_raw if c.count('\n') >= 2]
        if filled_raw and len(stacked) >= max(2, 0.3 * len(filled_raw)):
            col_table = _column_lines_table(page, t, page_no, decimal_comma)
            if col_table:
                out.append(col_table)
            continue
        ncols = max(len(r) for r in raw if r)
        # column bounds: the narrowest cell seen in each column (merged cells are wider)
        colx = []
        for k in range(ncols):
            xs = [(c[0], c[2]) for row in t.rows for kk, c in enumerate(row.cells) if kk == k and c]
            colx.append(min(xs, key=lambda x: x[1] - x[0]) if xs else (0, 0))
        # merged cells: pdfplumber gives the text once and None for the cells it covers. A cell merged across
        # columns ("This Month" over Gross / Refunds / Receipts) names each column under it.
        raw = [list(r) for r in raw]
        # only in the header rows (above the first row of values); a title cell across the whole frame is a title
        first_data = next((i for i, r in enumerate(raw) if any(c and is_numeric_cell(_clean(c), decimal_comma)
                           and not HEADER_NUM_RE.fullmatch(_clean(c)) for c in r[1:])), len(raw))
        frame_title = ''
        for i, row in enumerate(t.rows):
            if i >= min(len(raw), first_data):
                break
            filled_cells = [c for c in row.cells if c is not None]
            if i == 0 and len(filled_cells) == 1 and filled_cells[0][2] - filled_cells[0][0] > 0.8 * (t.bbox[2] - t.bbox[0]):
                frame_title = _clean(next((c for c in raw[0] if c), ''))
                raw[0] = [''] * len(raw[0])
                continue
            for k, c in enumerate(row.cells):
                if c is not None or k == 0 or k >= len(raw[i]):
                    continue
                j = k - 1
                while j >= 0 and row.cells[j] is None:
                    j -= 1
                if j >= 0 and row.cells[j][2] >= (colx[k][0] + colx[k][1]) / 2:
                    raw[i][k] = raw[i][j]
        rows = [[_clean(c) for c in r] for r in raw if r and any(_clean(c) for c in r)]
        header_only = len(rows) <= 4 and not any(is_numeric_cell(c, decimal_comma) and not HEADER_NUM_RE.fullmatch(c)
                                                 for r in rows for c in r)
        if header_only and len(rows) >= 1 and max(len(r) for r in rows) >= 2:
            # a band of column names drawn as a table of its own: kept for the table right below it
            out.append(Table(page=page_no, method='lines-header', bbox=tuple(t.bbox), rows=rows,
                             header=_header_names(rows, ncols), colx=colx))
            continue
        if len(rows) < 2 or max(len(r) for r in rows) < 2:
            continue
        filled = sum(1 for r in rows for c in r if c)
        if filled < 0.3 * sum(len(r) for r in rows):
            continue
        head_rows, body = _split_header(rows, [], decimal_comma, ruled=True)
        header = _header_names(head_rows, len(rows[0])) if head_rows else None
        prev = out[-1] if out else None
        if (prev is not None and prev.method == 'lines-header' and len(prev.colx) == ncols and 0 <= t.bbox[1] - prev.bbox[3] < 12
                and all(abs(a[0] - b[0]) < 3 and abs(a[1] - b[1]) < 3 for a, b in zip(prev.colx, colx))):
            header = [_clean(f'{a} {b}') for a, b in zip(prev.header, header or [''] * ncols)]
            out.pop()
            bbox = (t.bbox[0], prev.bbox[1], t.bbox[2], t.bbox[3])
        else:
            bbox = tuple(t.bbox)
        width = max(len(r) for r in rows)
        rows_pad = [list(r) + [''] * (width - len(r)) for r in body]
        keep = [k for k in range(width) if any(r[k] for r in rows_pad) or (header and k < len(header) and header[k])]
        header, body = _drop_empty_columns(header, body)
        if not body:
            continue
        cx = [colx[k] for k in keep if k < len(colx)]
        # several small tables in one frame: a row of names (no numbers) between rows of numbers starts the next one
        isnum = [any(is_numeric_cell(c, decimal_comma) for c in r[1:] if c) for r in body]
        cuts = [i for i in range(1, len(body) - 1) if not isnum[i] and isnum[i - 1] and isnum[i + 1]
                and sum(1 for c in body[i] if re.search(r'[A-Za-z]{2}', c)) >= 2
                and not any(c and not re.search(r'[A-Za-z]{2}', c) for c in body[i])]
        start, head = 0, header
        for cut in cuts + [len(body)]:
            part = body[start:cut]
            if part:
                out.append(Table(page=page_no, method='lines', bbox=bbox, rows=part,
                                 header=unique_names(head) if head else None, colx=cx,
                                 title=frame_title if start == 0 else ''))
            if cut < len(body):
                head = body[cut]
            start = cut + 1
    return [t for t in out if t.method != 'lines-header']


HEADER_NUM_RE = re.compile(r'\(?(19|20)\d\d\)?|\(\d{1,2}\)|[1-4]Q|Q[1-4]|\d{1,2}')


def _data_line(ln: Line, decimal_comma: bool) -> bool:
    """A line with values (not only years, column numbers or day numbers, as headers have)."""
    segs = ln.segments[1:] if len(ln.segments) > 2 else ln.segments
    for seg in segs:
        for w in seg:
            if is_numeric_cell(w.text, decimal_comma) and not HEADER_NUM_RE.fullmatch(w.text.strip()):
                return True
    return False


UNIT_RE = re.compile(r'[\[(][^\])]*(?:\$|dollar|million|billion|thousand|percent|%|units?\b|tons?|in )[^\])]*[\])]', re.I)


def is_unit_line(ln: Line) -> bool:
    """"[$ millions]", "(In thousands of dollars)": the unit of the whole table, not a column name."""
    return len(ln.segments) == 1 and bool(UNIT_RE.fullmatch(ln.text.strip()))


def _header_from_lines(hlines: list[Line], cols: list[tuple], vedges: list | None = None) -> list[str]:
    """Column names from header lines printed above the data: a group of words that spans several columns
    ("Week ending", "Not adjusted") is put in front of each column it covers; others go to the nearest column.
    In a frame with column lines (vedges: the vertical lines of the page), a name covers the columns between the
    lines that reach its own height, not only the ones its words sit over ("Not Adjusted" over 8 columns)."""
    names = [[] for _ in cols]
    centres = [(a + b) / 2 for a, b in cols]
    for ln in hlines:
        if is_unit_line(ln):
            continue
        for seg in ln.segments:
            x0, x1 = seg[0].x0, seg[-1].x1
            text = ' '.join(w.text for w in seg)
            covered = [k for k, c in enumerate(centres) if x0 - 2 <= c <= x1 + 2]
            if vedges is not None and len(seg) < 6:
                # in a frame with column lines, a group name spans the columns between the two lines that
                # reach up to its own line ("Not Adjusted" between the frame edge and the line before "Adjusted")
                my = (ln.top + ln.bottom) / 2
                xs = [e['x0'] for e in vedges if e['top'] <= my <= e['bottom']]
                left = max([x for x in xs if x <= x0 + 1], default=cols[0][0] - 1)
                right = min([x for x in xs if x >= x1 - 1], default=cols[-1][1] + 1)
                span = [k for k, c in enumerate(centres) if left < c < right]
                if span:
                    covered = span
            if len(covered) >= max(3, 0.6 * len(cols)) and len(seg) >= 6:
                continue  # a title or a note across the table, not a column name
            if len(covered) >= 2 and len(seg) < 6:
                for k in covered:
                    names[k].append(text)
                continue
            # words one by one (a segment may hold two short column names close together)
            for w in seg:
                cx = (w.x0 + w.x1) / 2
                k = min(range(len(cols)), key=lambda k: 0 if cols[k][0] - 1 <= cx <= cols[k][1] + 1
                        else min(abs(cx - cols[k][0]), abs(cx - cols[k][1])))
                names[k].append(w.text)
    return [_clean(' '.join(n)) for n in names]


def _label_wrap(ln: Line, prev: Line, nxt: Line) -> bool:
    """A row label printed on two lines in a numbered table ("28 LESS: Allowance for credit losses on" /
    "loans and leases 203.1 ..."): the line ends before the first value column and the next line has values."""
    first_val = next((seg[0].x0 for seg in prev.segments[1:] if any(is_numeric_cell(w.text) for w in seg)), None)
    return (first_val is not None and ln.words[-1].x1 < first_val and _data_line(nxt, False)
            and not any(is_numeric_cell(w.text) for w in ln.words[1:]))


def _blocks(lines: list[Line]) -> list[list[Line]]:
    blocks, i, n = [], 0, len(lines)
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
            # a bold line of column names after rows of values starts the next small table
            # ("Business Reply Mail (BRM) | High Volume | Basic" under the "Address Correction Service" rows)
            if (len(ln.segments) >= 2 and all(w.bold for w in ln.words) and not any(is_numeric_cell(w.text) for w in ln.words)
                    and any(_data_line(b, False) for b in block[-3:]) and not all(w.bold for w in prev.words)):
                break
            if len(ln.segments) >= 2:
                block.append(ln)
                j += 1
                continue
            # A one-group line inside a table (wrapped description) when the next line is tabular again.
            nxt = lines[j + 1] if j + 1 < n else None
            if (nxt and len(nxt.segments) >= 2 and nxt.top - ln.bottom <= 1.6 * max(ln.size, nxt.size)
                    and len(prev.segments) >= 2 and (ln.words[-1].x1 < prev.segments[1][0].x0 or
                                                     _label_wrap(ln, prev, nxt))):
                block.append(ln)
                j += 1
                continue
            break
        blocks.append(block)
        i = j
    return blocks


def text_tables(lines: list[Line], page_no: int, decimal_comma: bool, min_rows: int = 2) -> list[Table]:
    """Borderless tables from aligned columns."""
    tables = []
    blocks = _blocks(lines)
    # header lines: blocks without values right above a block with values (a ruled band or a gap between
    # them split the header off), collected upwards while they stay close
    head_of = {}
    for b in range(1, len(blocks)):
        if not any(_data_line(ln, decimal_comma) for ln in blocks[b]):
            continue
        hl, a = [], b - 1
        while a >= 0 and a not in head_of.values() and len(hl) < 8:
            top_ref = (hl[0] if hl else blocks[b][0]).top
            blk = blocks[a]
            if any(_data_line(ln, decimal_comma) for ln in blk) or top_ref - blk[-1].bottom > 3.0 * blk[-1].size or len(blk) > 6:
                break
            hl = blk + hl
            a -= 1
        if hl:
            head_of[b] = a + 1  # first header block index
    absorbed = {k for b, a in head_of.items() for k in range(a, b)}
    for bi, block in enumerate(blocks):
        if bi in absorbed:
            continue
        hlines = [ln for k in range(head_of[bi], bi) for ln in blocks[k]] if bi in head_of else []
        if len(block) < min_rows and not hlines:
            continue
        size = median(ln.size for ln in block)
        numeric = [ln for ln in block if len(ln.segments) >= 2 and _numeric_line(ln, decimal_comma)]
        basis = numeric if len(numeric) >= 2 else [ln for ln in block if len(ln.segments) >= max(2, int(median(len(b.segments) for b in block)))]
        cols = _columns(basis, size)
        if len(cols) < 2:
            continue
        # a section label printed between the column names and the data ("Liabilities") is a body row
        vcol = next((k for k in range(1, len(cols)) if sum(1 for ln in numeric for w in ln.words
                     if cols[k][0] - 1 <= (w.x0 + w.x1) / 2 <= cols[k][1] + 1 and is_numeric_cell(w.text, decimal_comma))
                     > 0.5 * max(1, len(numeric))), 1)
        while hlines and len(hlines[-1].segments) == 1 and hlines[-1].words[-1].x1 < cols[vcol][0] and not is_unit_line(hlines[-1]):
            block = [hlines.pop()] + block
        rows = [_assign(ln, cols) for ln in block]
        bold = [all(w.bold for w in ln.words) for ln in block]
        head_rows, body = _split_header(rows, bold, decimal_comma, ruled=False)
        if len(body) < 1 or (not head_rows and not hlines and len(body) < min_rows):
            continue
        header = None
        if hlines or head_rows:
            above = _header_from_lines(hlines, cols) if hlines else [''] * len(cols)
            inner = _header_names(head_rows, len(cols)) if head_rows else [''] * len(cols)
            header = [_clean(f'{a} {b}') for a, b in zip(above, inner)]
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
        # Title: up to two single-group lines right above the block (and its header lines).
        first = hlines[0] if hlines else block[0]
        title_lines = []
        k = lines.index(first) - 1
        top_ref = first.top
        while k >= 0 and len(title_lines) < 2:
            ln = lines[k]
            if len(ln.segments) != 1 or top_ref - ln.bottom > 1.6 * max(ln.size, size) or len(ln.text) > 120:
                break
            title_lines.insert(0, ln.text)
            top_ref = ln.top
            k -= 1
        x0 = min(w.x0 for ln in block for w in ln.words)
        x1 = max(w.x1 for ln in block for w in ln.words)
        tables.append(Table(page=page_no, method='text', bbox=(x0, first.top, x1, block[-1].bottom), rows=body,
                            header=unique_names(header) if header else None, title=' · '.join(title_lines),
                            bold_rows=bold[len(head_rows):]))
    return tables


def _attach_ruled_headers(tables: list[Table], lines: list[Line], decimal_comma: bool) -> list[Table]:
    """A ruled table whose column names are printed just above its frame (in a band of their own):
    the text lines between the previous table and the frame become its header; a text 'table' made only of
    those lines is dropped."""
    drop = set()
    for t in tables:
        if t.method != 'lines' or t.header or not t.colx or len(t.colx) != len(t.rows[0]):
            continue
        top = t.bbox[1]
        above = [ln for ln in lines if ln.bottom <= top + 1 and ln.words[0].x0 >= t.bbox[0] - 5
                 and ln.words[-1].x1 <= t.bbox[2] + 5]
        above.sort(key=lambda ln: ln.top, reverse=True)
        hl, ref = [], top
        others = [o for o in tables if o is not t and o.method == 'lines' and o.bbox[3] <= top + 1]
        floor = max([o.bbox[3] for o in others] + [0])
        for ln in above:
            if ln.top < floor or ref - ln.bottom > 3.0 * ln.size or _data_line(ln, decimal_comma) or len(hl) >= 8:
                break
            hl.insert(0, ln)
            ref = ln.top
        if not any(len(ln.segments) >= 2 for ln in hl):
            continue
        # leading lines that are titles (one group, wider than a column) stay out of the header
        while hl and len(hl[0].segments) == 1 and (hl[0].words[-1].x1 - hl[0].words[0].x0) > 0.6 * (t.bbox[2] - t.bbox[0]):
            hl.pop(0)
        if not hl:
            continue
        t.header = unique_names(_header_from_lines(hl, t.colx))
        units = [ln.text for ln in hl if is_unit_line(ln)]
        if units:
            t.title = ' · '.join([x for x in [t.title] + units if x])
        t.bbox = (t.bbox[0], hl[0].top, t.bbox[2], t.bbox[3])
        for o in tables:
            if o.method == 'text' and o.bbox[1] >= hl[0].top - 1 and o.bbox[3] <= top + 1 and \
                    not any(is_numeric_cell(c, decimal_comma) and not HEADER_NUM_RE.fullmatch(c) for r in o.rows for c in r):
                drop.add(id(o))
    return [t for t in tables if id(t) not in drop]


def extract_page(page, page_no: int, decimal_comma: bool, strategy: str = 'auto'):
    """Return (tables, lines) for a page. `lines` covers the whole page (used for invoice fields)."""
    tables = []
    if strategy in ('auto', 'lines'):
        tables = ruled_tables(page, page_no, decimal_comma)
    all_lines = build_lines(page_words(page))
    if strategy in ('auto', 'text'):
        rest = build_lines(page_words(page, exclude=[t.bbox for t in tables])) if tables else all_lines
        tables += text_tables(rest, page_no, decimal_comma)
        if any(t.method == 'lines' for t in tables):
            tables = _attach_ruled_headers(tables, rest, decimal_comma)
    for t in tables:
        if t.method == 'lines':
            _ruled_title(t, all_lines, tables)
    tables.sort(key=lambda t: (t.bbox[1], t.bbox[0]))
    return tables, all_lines


def _ruled_title(t: Table, lines: list[Line], tables: list[Table]):
    """Up to two one-group lines right above a ruled table ("Table 4. Receipts of ...", "Commercial Plus")."""
    def inside(ln, o):
        cy = (ln.top + ln.bottom) / 2
        return o.bbox[1] - 1 <= cy <= o.bbox[3] + 1 and o.bbox[0] - 1 <= ln.words[0].x0 <= o.bbox[2] + 1
    above = sorted((ln for ln in lines if ln.bottom <= t.bbox[1] + 1 and ln.words[-1].x1 > t.bbox[0] - 5
                    and ln.words[0].x0 < t.bbox[2] + 5), key=lambda ln: ln.top, reverse=True)
    got, ref = [], t.bbox[1]
    for ln in above:
        # a heading above this table; two tables side by side have two headings on one line: take the one over it
        over = [seg for seg in ln.segments if seg[-1].x1 > t.bbox[0] - 2 and seg[0].x0 < t.bbox[2] + 2]
        text = ' '.join(w.text for w in over[0]) if len(over) == 1 else ''
        if any(inside(ln, o) for o in tables) or ref - ln.bottom > 2.5 * ln.size or not text or len(text) > 150:
            break
        got.insert(0, text)
        ref = ln.top
        if len(got) == 2:
            break
    if got:
        t.title = ' · '.join(got + ([t.title] if t.title else []))
