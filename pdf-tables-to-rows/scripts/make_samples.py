"""Generate the fictional sample invoices in samples/ (CC0, no real people or companies).

Run with any Python that has reportlab:  python3 scripts/make_samples.py
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / 'samples'
NOTE = 'Sample invoice for testing. All names, numbers and addresses are fictional. Public domain (CC0).'


def ruled_invoice(path: Path) -> None:
    """US-style invoice, USD, table with grid lines, 1 page."""
    c = canvas.Canvas(str(path), pagesize=LETTER)
    w, h = LETTER
    c.setTitle('Invoice INV-2026-0142')
    c.setFont('Helvetica-Bold', 20)
    c.drawString(50, h - 60, 'Larkspur Sample Supply Co.')
    c.setFont('Helvetica', 9)
    for i, line in enumerate(['400 Example Avenue, Springfield, ST 00000', 'Tax ID: 00-0000142', 'billing@larkspur.example']):
        c.drawString(50, h - 78 - i * 12, line)
    c.setFont('Helvetica-Bold', 26)
    c.drawRightString(w - 50, h - 60, 'INVOICE')
    c.setFont('Helvetica', 10)
    meta = [('Invoice No:', 'INV-2026-0142'), ('Invoice Date:', 'September 15, 2026'), ('Due Date:', 'October 15, 2026'), ('PO Number:', 'PO-7781')]
    for i, (k, v) in enumerate(meta):
        c.drawRightString(w - 150, h - 90 - i * 14, k)
        c.drawRightString(w - 50, h - 90 - i * 14, v)
    c.setFont('Helvetica-Bold', 10)
    c.drawString(50, h - 160, 'Bill To:')
    c.setFont('Helvetica', 10)
    for i, line in enumerate(['Bluebird Sample Bakery LLC', '17 Sample Road', 'Riverton, ST 00001']):
        c.drawString(50, h - 174 - i * 13, line)

    cols = [50, 80, 300, 370, 420, 490, w - 50]
    heads = ['#', 'Description', 'SKU', 'Qty', 'Unit Price', 'Amount']
    rows = [
        ['1', 'Copy paper A4, 80 g, box of 5 reams', 'PAP-A4-80', '12', '$24.90', '$298.80'],
        ['2', 'Ballpoint pens, blue (pack of 50)', 'PEN-BL-50', '4', '$11.25', '$45.00'],
        ['3', 'Desk organizer, bamboo', 'ORG-BAM-1', '6', '$18.40', '$110.40'],
        ['4', 'Laser toner cartridge, black', 'TON-BK-26', '3', '$64.99', '$194.97'],
        ['5', 'Delivery and handling', 'SHIP', '1', '$15.00', '$15.00'],
    ]
    top = h - 240
    rh = 20
    n = len(rows) + 1
    c.setFillColor(colors.HexColor('#e8eef6'))
    c.rect(cols[0], top - rh, cols[-1] - cols[0], rh, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setLineWidth(0.6)
    for r in range(n + 1):
        c.line(cols[0], top - r * rh, cols[-1], top - r * rh)
    for x in cols:
        c.line(x, top, x, top - n * rh)
    for r, row in enumerate([heads] + rows):
        c.setFont('Helvetica-Bold' if r == 0 else 'Helvetica', 9)
        y = top - r * rh - 14
        for k, val in enumerate(row):
            if k >= 3:
                c.drawRightString(cols[k + 1] - 5, y, val)
            else:
                c.drawString(cols[k] + 5, y, val)

    y = top - n * rh - 25
    for label, val, bold in [('Subtotal', '$664.17', False), ('Sales Tax (8%)', '$53.13', False), ('Total Due', '$717.30', True)]:
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 11 if bold else 10)
        c.drawRightString(w - 150, y, label)
        c.drawRightString(w - 55, y, val)
        y -= 18
    c.setFont('Helvetica', 9)
    c.drawString(50, y - 20, 'Payment terms: Net 30. Thank you for your business.')
    c.setFont('Helvetica-Oblique', 7)
    c.drawString(50, 30, NOTE)
    c.save()


def plain_invoice(path: Path) -> None:
    """European-style invoice, EUR, decimal comma, borderless table, line items continue on page 2."""
    c = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    c.setTitle('Invoice 2026/0387')
    items = [
        ('Website maintenance, September', '1', 'month', '450,00', '21%', '450,00'),
        ('Hosting plan Business (annual)', '1', 'pcs', '238,80', '21%', '238,80'),
        ('Extra storage 50 GB', '3', 'pcs', '12,50', '21%', '37,50'),
        ('Content updates', '6,5', 'h', '42,00', '21%', '273,00'),
        ('SSL certificate renewal', '2', 'pcs', '59,00', '21%', '118,00'),
        ('Newsletter template design', '1', 'pcs', '1.150,00', '21%', '1.150,00'),
        ('Backup restore test', '2', 'h', '42,00', '21%', '84,00'),
        ('Domain renewal .example', '4', 'pcs', '14,90', '21%', '59,60'),
        ('Monthly analytics report', '1', 'pcs', '95,00', '21%', '95,00'),
        ('Server migration support', '8', 'h', '42,00', '21%', '336,00'),
        ('Security audit (basic)', '1', 'pcs', '620,00', '21%', '620,00'),
        ('Training session for staff', '3', 'h', '55,00', '21%', '165,00'),
        ('Photo licensing (stock)', '10', 'pcs', '9,90', '21%', '99,00'),
        ('Contact form spam filter setup', '1', 'pcs', '75,00', '21%', '75,00'),
    ]
    subtotal = 3800.90
    vat = 798.19
    total = 4599.09

    def header_block(page: int) -> float:
        c.setFont('Helvetica-Bold', 16)
        c.drawString(40, h - 55, 'Wrenfield Sample Web Studio B.V.')
        c.setFont('Helvetica', 9)
        c.drawString(40, h - 70, 'Voorbeeldstraat 1, 0000 AA Voorbeeldstad')
        c.drawString(40, h - 82, 'VAT No: NL000000000B01')
        c.setFont('Helvetica', 9)
        c.drawRightString(w - 40, h - 55, f'Page {page} of 2')
        return h - 110

    y = header_block(1)
    c.setFont('Helvetica-Bold', 14)
    c.drawString(40, y, 'Invoice')
    c.setFont('Helvetica', 10)
    y -= 22
    for label, val in [('Invoice number:', '2026/0387'), ('Invoice date:', '30.09.2026'), ('Due date:', '14.10.2026')]:
        c.drawString(40, y, label)
        c.drawString(140, y, val)
        y -= 14
    y -= 8
    c.setFont('Helvetica-Bold', 10)
    c.drawString(40, y, 'Customer:')
    c.setFont('Helvetica', 10)
    c.drawString(140, y, 'Harbor Lane Sample Clinic')
    y -= 14
    c.drawString(140, y, 'Example Square 9, 0000 BB Sampletown')
    y -= 34

    cols = [40, 300, 345, 390, 460, 505]  # left edges; numbers right-aligned to next edge - 5
    right = [None, 340, 385, 455, 500, w - 40]
    heads = ['Description', 'Quantity', 'Unit', 'Unit price', 'VAT', 'Total']

    def table_head(yy: float) -> float:
        c.setFont('Helvetica-Bold', 9)
        for k, t in enumerate(heads):
            if k == 0 or k == 2:
                c.drawString(cols[k], yy, t)
            else:
                c.drawRightString(right[k], yy, t)
        c.setLineWidth(0.8)
        c.line(40, yy - 5, w - 40, yy - 5)
        return yy - 20

    def row(yy: float, it) -> float:
        c.setFont('Helvetica', 9)
        for k, t in enumerate(it):
            if k == 0 or k == 2:
                c.drawString(cols[k], yy, t)
            else:
                c.drawRightString(right[k], yy, t)
        return yy - 16

    y = table_head(y)
    for it in items[:9]:
        y = row(y, it)
    c.setFont('Helvetica-Oblique', 8)
    c.drawString(40, 60, 'Continued on next page.')
    c.drawString(40, 30, NOTE)
    c.showPage()

    y = header_block(2)
    y = table_head(y - 10)
    for it in items[9:]:
        y = row(y, it)
    c.line(40, y + 8, w - 40, y + 8)
    y -= 14
    for label, val, bold in [('Subtotal (excl. VAT)', f'EUR {subtotal:,.2f}', False), ('VAT 21%', f'EUR {vat:,.2f}', False), ('Total amount due', f'EUR {total:,.2f}', True)]:
        val = val.replace(',', 'X').replace('.', ',').replace('X', '.')
        c.setFont('Helvetica-Bold' if bold else 'Helvetica', 10)
        c.drawRightString(440, y, label)
        c.drawRightString(w - 40, y, val)
        y -= 16
    c.setFont('Helvetica', 9)
    c.drawString(40, y - 20, 'Please pay within 14 days to IBAN NL00 EXMP 0000 0000 00, quoting the invoice number.')
    c.setFont('Helvetica-Oblique', 8)
    c.drawString(40, 30, NOTE)
    c.save()


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    ruled_invoice(OUT / 'invoice-us-ruled.pdf')
    plain_invoice(OUT / 'invoice-eu-2-pages.pdf')
    print('written to', OUT)


def test_fixtures() -> None:
    """Encrypted and scanned (image-only) PDFs for the tests. Needs pypdf and pillow."""
    import io

    from PIL import Image, ImageDraw
    from pypdf import PdfReader, PdfWriter
    from reportlab.lib.utils import ImageReader

    fx = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
    fx.mkdir(parents=True, exist_ok=True)
    w = PdfWriter()
    for p in PdfReader(str(OUT / 'invoice-us-ruled.pdf')).pages:
        w.add_page(p)
    w.encrypt(user_password='secret123', owner_password='owner456')
    with open(fx / 'encrypted-secret123.pdf', 'wb') as f:
        w.write(f)
    img = Image.new('RGB', (1200, 800), 'white')
    ImageDraw.Draw(img).text((50, 50), 'INVOICE 001  Total 10.00', fill='black')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    c = canvas.Canvas(str(fx / 'scanned-image-only.pdf'), pagesize=A4)
    c.drawImage(ImageReader(buf), 40, 300, width=500, height=333)
    c.save()


if __name__ == '__main__' and len(__import__('sys').argv) > 1 and __import__('sys').argv[1] == '--test-fixtures':
    test_fixtures()
    print('test fixtures written')
