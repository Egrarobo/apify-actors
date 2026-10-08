"""Input collection (URLs, key-value store files, dataset of URLs), share-link normalisation and download.

Same rules as the Document to Markdown Actor (doc-to-markdown/src/sources.js), ported to Python.
"""
from __future__ import annotations

import base64
import re
from urllib.parse import parse_qs, unquote, urlencode, urlparse, urlunparse

import httpx
from apify import Actor

UA = 'Mozilla/5.0 (compatible; ApifyPdfTablesToRows/1.0; +https://apify.com)'


def to_direct_url(raw: str) -> str:
    """Convert share links (Google Drive, Dropbox, OneDrive/SharePoint, GitHub, Box) to direct downloads."""
    s = str(raw).strip()
    try:
        u = urlparse(s)
    except ValueError:
        return s
    if not u.scheme or not u.netloc:
        return s
    h = u.hostname.removeprefix('www.') if u.hostname else ''
    q = parse_qs(u.query)
    if h == 'drive.google.com':
        m = re.search(r'/file/d/([\w-]+)', u.path)
        fid = m.group(1) if m else (q.get('id') or [None])[0]
        if fid:
            return f'https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t'
    if h == 'docs.google.com':
        m = re.search(r'/(document|spreadsheets|presentation)/d/([\w-]+)', u.path)
        if m:
            return f'https://docs.google.com/{m.group(1)}/d/{m.group(2)}/export?format=pdf'
    if h == 'dropbox.com':
        q['dl'] = ['1']
        return urlunparse(u._replace(query=urlencode({k: v[0] for k, v in q.items()})))
    if h in ('1drv.ms', 'onedrive.live.com'):
        b64 = base64.b64encode(s.encode()).decode().rstrip('=').replace('/', '_').replace('+', '-')
        return f'https://api.onedrive.com/v1.0/shares/u!{b64}/root/content'
    if h.endswith('.sharepoint.com') and 'download' not in q:
        q['download'] = ['1']
        return urlunparse(u._replace(query=urlencode({k: v[0] for k, v in q.items()})))
    if h == 'github.com':
        m = re.match(r'^/([^/]+)/([^/]+)/blob/(.+)$', u.path)
        if m:
            return f'https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}'
    if h == 'app.box.com' and u.path.startswith('/s/'):
        return f'https://app.box.com/shared/static/{u.path.split("/")[2]}'
    return s


async def collect_sources(inp: dict) -> list[dict]:
    sources, seen = [], set()

    def add(s: dict) -> None:
        key = s.get('url') or f"kvs:{s.get('storeId') or ''}/{s['key']}"
        if key not in seen:
            seen.add(key)
            sources.append(s)

    for u in inp.get('urls') or []:
        url = u if isinstance(u, str) else (u or {}).get('url')
        if url and str(url).strip():
            add({'url': str(url).strip()})
    store_id = inp.get('kvStoreId') or None
    for k in inp.get('kvStoreFileNames') or []:
        key = k if isinstance(k, str) else (k or {}).get('key')
        if not key:
            continue
        m = re.match(r'^([\w~.-]{5,})/(.+)$', str(key))
        add({'storeId': m.group(1), 'key': m.group(2)} if (m and not store_id) else {'storeId': store_id, 'key': str(key)})
    if inp.get('datasetId'):
        field = inp.get('datasetUrlField') or 'url'
        ds = await _open_dataset(inp['datasetId'])
        n = 0
        async for it in ds.iterate_items(limit=100000):
            url = (it or {}).get(field)
            if isinstance(url, str) and re.match(r'^https?://', url.strip(), re.I):
                add({'url': url.strip()})
                n += 1
        if not n:
            Actor.log.warning(f'Dataset {inp["datasetId"]}: no items with a URL in the "{field}" field.')
    return sources


async def _open_dataset(id_or_name: str):
    cloud = Actor.is_at_home()
    try:
        return await Actor.open_dataset(id=id_or_name, force_cloud=cloud)
    except Exception:  # noqa: BLE001 - not an ID: try it as a name
        return await Actor.open_dataset(name=id_or_name, force_cloud=cloud)


async def _open_store(id_or_name: str | None):
    if not id_or_name:
        return await Actor.open_key_value_store()
    cloud = Actor.is_at_home()
    try:
        return await Actor.open_key_value_store(id=id_or_name, force_cloud=cloud)
    except Exception:  # noqa: BLE001
        return await Actor.open_key_value_store(name=id_or_name, force_cloud=cloud)


def _file_name(resp: httpx.Response | None, url: str) -> str:
    cd = resp.headers.get('content-disposition', '') if resp is not None else ''
    m = re.search(r"filename\*\s*=\s*(?:UTF-8'')?([^;]+)", cd, re.I)
    name = unquote(m.group(1).strip('"')) if m else None
    if not name:
        m = re.search(r'filename\s*=\s*"?([^";]+)"?', cd, re.I)
        name = m.group(1) if m else None
    if not name:
        name = unquote(urlparse(url).path.rsplit('/', 1)[-1])
    return (name or 'document.pdf').strip()


async def fetch_source(src: dict, client: httpx.AsyncClient, max_bytes: int, timeout_s: int = 120) -> dict:
    """Return {data: bytes, fileName, contentType}."""
    if src.get('key'):
        store = await _open_store(src.get('storeId'))
        value = await store.get_value(src['key'])
        if value is None:
            where = f" in store {src['storeId']}" if src.get('storeId') else ''
            raise ValueError(f'Key-value store record "{src["key"]}" not found{where}.')
        data = value if isinstance(value, (bytes, bytearray)) else str(value).encode()
        if len(data) > max_bytes:
            raise ValueError(f'File is larger than the {max_bytes // 1_000_000} MB limit (maxFileSizeMb).')
        return {'data': bytes(data), 'fileName': src['key'], 'contentType': ''}

    url = to_direct_url(src['url'])
    if not re.match(r'^https?://', url, re.I):
        raise ValueError(f'Invalid URL: "{src["url"]}". Use a full http(s) link.')
    try:
        async with client.stream('GET', url, timeout=timeout_s) as resp:
            if resp.status_code >= 400:
                hint = ' The file is private: share it as "Anyone with the link can view".' if resp.status_code in (401, 403) else ''
                raise ValueError(f'Download failed: HTTP {resp.status_code}.{hint}')
            length = int(resp.headers.get('content-length') or 0)
            if length > max_bytes:
                raise ValueError(f'File is {length // 1_000_000} MB, larger than the {max_bytes // 1_000_000} MB limit (maxFileSizeMb).')
            chunks, total = [], 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(f'File is larger than the {max_bytes // 1_000_000} MB limit (maxFileSizeMb).')
                chunks.append(chunk)
            data = b''.join(chunks)
            ctype = resp.headers.get('content-type', '')
            if 'google.com' in (resp.url.host or '') and 'text/html' in ctype and re.search(rb'accounts\.google\.com|ServiceLogin|Virus scan', data[:50000]):
                raise ValueError('Google returned a login or warning page instead of the file. Share it as "Anyone with the link can view".')
            return {'data': data, 'fileName': _file_name(resp, str(resp.url)), 'contentType': ctype}
    except httpx.TimeoutException as err:
        raise ValueError(f'Download failed: timed out after {timeout_s}s.') from err
    except httpx.HTTPError as err:
        raise ValueError(f'Download failed: {type(err).__name__} {err}.') from err


def is_pdf(data: bytes) -> bool:
    return b'%PDF-' in data[:1024]


def not_pdf_reason(data: bytes, file_name: str, content_type: str) -> str:
    ext = file_name.lower().rsplit('.', 1)[-1] if '.' in file_name else ''
    if data[:2] == b'PK':
        return f'This is an Office/ZIP file (.{ext or "zip"}), not a PDF. Save it as PDF, or use the "Document to Markdown" Actor for Word/Excel/PowerPoint.'
    if 'html' in content_type or data.lstrip()[:15].lower().startswith((b'<!doctype html', b'<html')):
        return 'The link returned a web page, not a PDF file. Use the direct link to the PDF (it usually ends with .pdf).'
    if data[:3] == b'\xff\xd8\xff' or data[:4] == b'\x89PNG':
        return 'This is an image, not a PDF. Scanned images need OCR, which this Actor does not do.'
    return 'This file is not a PDF.'
