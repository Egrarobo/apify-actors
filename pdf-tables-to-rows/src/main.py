"""PDF tables & invoices -> rows. Apify Actor entry point."""
from __future__ import annotations

import asyncio
import re
import time

import httpx
from apify import Actor

from .excel import build_workbook
from .extract import PdfError, process_pdf
from .sources import UA, collect_sources, fetch_source, is_pdf, not_pdf_reason

EVENT_PAGE = 'page-with-data'


def _file_name_from(src: dict) -> str:
    if src.get('key'):
        return src['key']
    name = re.sub(r'[?#].*$', '', src['url']).rstrip('/').rsplit('/', 1)[-1]
    return name or src['url']


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        mode = inp.get('mode') if inp.get('mode') in ('auto', 'invoice', 'tables') else 'auto'
        table_method = inp.get('tableDetection') if inp.get('tableDetection') in ('auto', 'lines', 'text') else 'auto'
        date_order = inp.get('dateOrder') if inp.get('dateOrder') in ('auto', 'DMY', 'MDY') else 'auto'
        parse_numbers = inp.get('parseNumbers', True) is not False
        save_excel = inp.get('saveExcel', True) is not False
        max_pages = max(0, int(inp.get('maxPagesPerDocument') or 0))
        max_docs = max(1, int(inp.get('maxDocuments') or 1000))
        max_bytes = max(1, int(inp.get('maxFileSizeMb') or 50)) * 1_000_000
        password = inp.get('pdfPassword') or None

        sources = await collect_sources(inp)
        if not sources:
            await Actor.fail(status_message='No PDFs to process. Add PDF links to "urls", key-value store file names to '
                                            '"kvStoreFileNames", or a "datasetId" with PDF URLs.')
            return
        if len(sources) > max_docs:
            Actor.log.warning(f'Limiting to the first {max_docs} of {len(sources)} PDFs (maxDocuments).')
            sources = sources[:max_docs]

        cm = Actor.get_charging_manager()
        is_ppe = cm.get_pricing_info().is_pay_per_event
        kvs = await Actor.open_key_value_store()
        summary = {'documentsTotal': len(sources), 'documentsSucceeded': 0, 'documentsWithoutData': 0, 'documentsFailed': 0,
                   'invoices': 0, 'tables': 0, 'rows': 0, 'pagesRead': 0, 'pagesWithData': 0, 'stoppedBySpendingLimit': False,
                   'failures': []}
        all_rows, invoices = [], []
        Actor.log.info(f'Processing {len(sources)} PDF(s): mode={mode}, tableDetection={table_method}.')

        async with httpx.AsyncClient(follow_redirects=True, headers={'user-agent': UA, 'accept': 'application/pdf,*/*'}) as client:
            for i, src in enumerate(sources):
                affordable = cm.calculate_max_event_charge_count_within_limit(EVENT_PAGE) if is_ppe else None
                if affordable is not None and affordable < 1:
                    summary['stoppedBySpendingLimit'] = True
                    Actor.log.warning(f'Stopped before PDF {i + 1}/{len(sources)}: the run reached the spending limit you set.')
                    break
                source_url = src.get('url') or f"kvs://{src.get('storeId') or 'default'}/{src['key']}"
                file_name = _file_name_from(src)
                started = time.time()
                try:
                    dl = await fetch_source(src, client, max_bytes)
                    file_name = dl['fileName']
                    if not dl['data']:
                        raise ValueError('The file is empty.')
                    if not is_pdf(dl['data']):
                        raise ValueError(not_pdf_reason(dl['data'], file_name, dl['contentType']))
                    page_cap = max_pages
                    if affordable is not None and (not page_cap or affordable < page_cap):
                        page_cap = affordable
                    res = await asyncio.to_thread(process_pdf, dl['data'], mode=mode, table_method=table_method,
                                                  max_pages=page_cap, parse_numbers=parse_numbers, date_order=date_order,
                                                  password=password)
                    summary['pagesRead'] += res['pagesRead']
                    for w in res['warnings']:
                        Actor.log.warning(f'{file_name}: {w}')
                    if not res['rows']:
                        reason = ('No text layer: the PDF looks scanned (image only). OCR is not supported.'
                                  if res['scannedPages'] and len(res['scannedPages']) == res['pagesRead']
                                  else 'No tables or invoice fields found in this PDF.')
                        summary['documentsWithoutData'] += 1
                        await Actor.push_data({'sourceUrl': source_url, 'fileName': file_name, 'status': 'no-data',
                                               'error': reason, 'pages': res['totalPages']})
                        Actor.log.info(f'[{i + 1}/{len(sources)}] {file_name}: {reason} (not charged)')
                        continue

                    # Charge per page that produced rows, before output. If the budget covers only part, output that part.
                    pages = res['pagesWithData']
                    rows = res['rows']
                    charged = await Actor.charge(EVENT_PAGE, count=len(pages))
                    if is_ppe and charged.charged_count < len(pages):
                        summary['stoppedBySpendingLimit'] = True
                        if charged.charged_count < 1:
                            Actor.log.warning(f'Skipped "{file_name}": the run reached the spending limit you set.')
                            break
                        keep = set(pages[:charged.charged_count])
                        rows = [r for r in rows if r['page'] in keep]
                        pages = sorted(keep)

                    base = {'sourceUrl': source_url, 'fileName': file_name}
                    items = [{**base, 'documentType': res['documentType'], **r, 'status': 'ok'} for r in rows]
                    await Actor.push_data(items)
                    all_rows.extend(items)
                    if res['invoice']:
                        invoices.append({**base, **res['invoice']})
                        summary['invoices'] += 1
                    summary['tables'] += len({r.get('tableIndex') for r in rows if r.get('rowType') == 'table-row'})
                    summary['documentsSucceeded'] += 1
                    summary['rows'] += len(items)
                    summary['pagesWithData'] += len(pages)
                    if res['invoice']:
                        n_lines = sum(1 for r in rows if r.get('rowType') == 'invoice-line')
                        what = f"invoice {res['invoice'].get('invoiceNumber') or '(no number)'} with {n_lines} line(s)"
                    else:
                        what = f"{len({r.get('tableIndex') for r in rows})} table(s)"
                    Actor.log.info(f'[{i + 1}/{len(sources)}] {file_name}: {what}, {len(items)} row(s), '
                                   f'{len(pages)} of {res["pagesRead"]} page(s) with data, {time.time() - started:.1f}s.')
                except (PdfError, ValueError) as err:
                    summary['documentsFailed'] += 1
                    summary['failures'].append({'sourceUrl': source_url, 'error': str(err)})
                    Actor.log.error(f'[{i + 1}/{len(sources)}] {file_name}: {err}')
                    await Actor.push_data({'sourceUrl': source_url, 'fileName': file_name, 'status': 'failed', 'error': str(err)})
                except Exception as err:  # noqa: BLE001 - one bad file must not stop the run
                    summary['documentsFailed'] += 1
                    msg = f'Unexpected error: {type(err).__name__}: {err}'
                    summary['failures'].append({'sourceUrl': source_url, 'error': msg})
                    Actor.log.exception(f'[{i + 1}/{len(sources)}] {file_name}: {msg}')
                    await Actor.push_data({'sourceUrl': source_url, 'fileName': file_name, 'status': 'failed', 'error': msg})
                if summary['stoppedBySpendingLimit']:
                    Actor.log.warning('Stopping: the run reached the spending limit you set.')
                    break

        if save_excel and (all_rows or invoices):
            data = build_workbook(all_rows, invoices)
            if data:
                await kvs.set_value('OUTPUT.xlsx', data, content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                try:
                    summary['excelUrl'] = await kvs.get_public_url('OUTPUT.xlsx')
                except Exception:  # noqa: BLE001 - local runs have no public URL
                    summary['excelUrl'] = 'OUTPUT.xlsx (key-value store)'
        await kvs.set_value('OUTPUT', summary)
        Actor.log.info(f"Done: {summary['documentsSucceeded']} PDF(s) with data, {summary['documentsWithoutData']} without, "
                       f"{summary['documentsFailed']} failed; {summary['rows']} row(s), {summary['pagesWithData']} page(s) charged.")
        if summary['documentsSucceeded'] == 0 and summary['documentsFailed'] > 0 and summary['documentsWithoutData'] == 0:
            await Actor.fail(status_message=f"All {summary['documentsFailed']} PDF(s) failed. First error: {summary['failures'][0]['error']}")
