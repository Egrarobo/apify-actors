"""Full-page screenshots of a list of URLs with Playwright (Python, sync API).

Usage: python shots.py urls.txt [out_dir]
One URL per line in urls.txt. Writes one PNG per page and shots.csv to out_dir (default: shots).
"""
import csv
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

MAX_HEIGHT = 15000      # px; taller pages are cut here and the CSV says so
NAV_TIMEOUT = 30000     # ms per page
SETTLE_MS = 5000        # max wait for late requests after scrolling

# Hide common cookie/consent banners instead of clicking "Accept".
HIDE_BANNERS = """
#onetrust-consent-sdk, #onetrust-banner-sdk, #CybotCookiebotDialog, #usercentrics-root,
#didomi-host, .qc-cmp2-container, .fc-consent-root, #truste-consent-track, .cc-window,
#cookie-banner, #cookie-notice, #cookieConsent, [id^="sp_message_container"],
[aria-label*="cookie" i][role="dialog"], [class*="cookie-banner" i], [class*="cookie-consent" i]
{ display: none !important; }
"""

# Consent pop-ups also lock scrolling (body fixed, overflow hidden, a negative margin to keep the
# scroll position). Inline !important beats their CSS.
UNLOCK_SCROLL = """() => { for (const el of [document.documentElement, document.body]) {
  for (const [k, v] of [["overflow", "visible"], ["height", "auto"], ["position", "static"], ["top", "auto"]])
    el.style.setProperty(k, v, "important");
  if (parseFloat(getComputedStyle(el).marginTop) < 0) el.style.setProperty("margin-top", "0", "important"); } }"""


def scroll_to_bottom(page, max_steps=50):
    """Scroll down one screen at a time so lazy images start loading, then go back to the top."""
    for _ in range(max_steps):
        page.evaluate(UNLOCK_SCROLL)  # the pop-up may lock the page a few seconds after load
        at_bottom = page.evaluate(
            "() => { window.scrollBy(0, window.innerHeight);"
            " const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);"
            " return window.scrollY + window.innerHeight >= h - 2; }")
        page.wait_for_timeout(200)
        if at_bottom:
            break
    try:
        page.wait_for_load_state("networkidle", timeout=SETTLE_MS)
    except Exception:
        pass  # some pages never go idle (analytics, live updates); don't wait forever
    page.evaluate(UNLOCK_SCROLL)
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(300)


def shoot(page, url, path):
    row = {"url": url, "status": "", "final_url": "", "title": "", "height": "", "file": "", "note": "", "error": ""}
    response = page.goto(url, wait_until="load", timeout=NAV_TIMEOUT)
    row["status"] = response.status if response else ""
    page.add_style_tag(content=HIDE_BANNERS)
    scroll_to_bottom(page)
    row["final_url"] = page.url
    row["title"] = page.title()
    height = page.evaluate(
        "() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")
    width = page.viewport_size["width"]
    row["height"] = height
    if height > MAX_HEIGHT:
        clip = {"x": 0, "y": 0, "width": width, "height": MAX_HEIGHT}
        page.screenshot(path=path, full_page=True, clip=clip, animations="disabled")
        row["note"] = f"cut at {MAX_HEIGHT}px (page is {height}px)"
        print(f"  warning: {url} is {height}px tall, cut at {MAX_HEIGHT}px")
    else:
        page.screenshot(path=path, full_page=True, animations="disabled")
    row["file"] = str(path)
    return row


def main():
    urls = [u.strip() for u in Path(sys.argv[1]).read_text().splitlines() if u.strip() and not u.startswith("#")]
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "shots")
    out.mkdir(exist_ok=True)
    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for i, url in enumerate(urls, 1):
            name = re.sub(r"[^a-zA-Z0-9]+", "-", url.split("//")[-1]).strip("-")[:60]
            path = out / f"{i:03d}-{name}.png"
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            try:
                rows.append(shoot(page, url, path))
            except Exception as e:  # one bad URL must not stop the batch
                first_line = str(e).splitlines()[0] if str(e) else type(e).__name__
                rows.append({"url": url, "status": "", "final_url": "", "title": "", "height": "",
                             "file": "", "note": "", "error": first_line})
            finally:
                page.close()
            r = rows[-1]
            print(f"{i}/{len(urls)} {r['status'] or 'ERR'} {url} {r['height'] or ''} {r['error']}")
        browser.close()
    with open(out / "shots.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"{sum(1 for r in rows if r['file'])} of {len(rows)} saved, see {out / 'shots.csv'}")


if __name__ == "__main__":
    main()
