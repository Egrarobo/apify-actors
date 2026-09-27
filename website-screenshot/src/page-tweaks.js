// Page clean-up helpers: cookie/consent banners, ad blocking, custom hidden elements, lazy-load scrolling.

/** Containers of popular consent-management platforms (CMPs). Hidden with display:none. */
const CMP_SELECTORS = [
    '#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter', // OneTrust
    '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay', '#CookiebotWidget', // Cookiebot
    '#didomi-host', '.didomi-popup-backdrop', // Didomi
    '#qc-cmp2-container', '.qc-cmp2-container', '#qcCmpUi', // Quantcast
    '#truste-consent-track', '#truste-consent-content', '.truste_overlay', '.truste_box_overlay', '#consent_blackbar', '#trustarc-banner-overlay', // TrustArc
    '#usercentrics-root', '#usercentrics-cmp-ui', // Usercentrics
    '[id^="sp_message_container"]', // Sourcepoint
    '.fc-consent-root', // Google Funding Choices
    '#cmpbox', '#cmpbox2', '.cmpboxBG', // consentmanager.net
    '.cky-consent-container', '.cky-overlay', '.cky-modal', // CookieYes
    '.cc-window', '.cc-banner', '.cc-grower', // Osano / cookieconsent
    '.osano-cm-window', '.osano-cm-dialog',
    '#cookie-law-info-bar', '.cli-modal-backdrop', '#moove_gdpr_cookie_info_bar', '#cookie-notice', '#catapult-cookie-bar', // WordPress plugins
    '#hs-eu-cookie-confirmation', // HubSpot
    '#iubenda-cs-banner', // iubenda
    '#axeptio_overlay', // Axeptio
    '#tarteaucitronRoot', // tarteaucitron
    '.klaro .cookie-notice', '.klaro .cookie-modal', // Klaro
    '#cookiescript_injected', '#cookiescript_injected_wrapper', // CookieScript
    '#_evidon_banner', '.evidon-banner', '#_evidon-background', // Evidon / Crownpeak
    '#termly-code-snippet-support', // Termly
    '#ccm-widget', '#BorlabsCookieBox', '#borlabs-cookie', // Borlabs
    '#gdpr-cookie-message', '.gdpr-cookie-notice',
];

export const COOKIE_CSS = `${CMP_SELECTORS.join(',\n')} { display: none !important; visibility: hidden !important; }`;

/**
 * Runs inside the page. Finds fixed/sticky consent banners that are not covered by the list above,
 * hides them and restores page scrolling if a banner locked it. Conservative on purpose:
 * an element is only hidden if it is fixed/sticky AND mentions cookies/consent (or is a CMP backdrop).
 */
export function hideConsentOverlaysInPage() {
    const NAME_RX = /(cookie|consent|gdpr|ccpa|privacy[-_]?(banner|notice|popup|bar|modal)|cmp[-_]?(banner|container|popup|modal))/i;
    const TEXT_RX = /cookie|consent|gdpr|we value your privacy|your privacy|datenschutz|confidentialit|privacidad|informativa/i;
    const skip = new Set([document.documentElement, document.body]);
    const done = new Set();
    let hidden = 0;
    const isOverlay = (el) => {
        const pos = getComputedStyle(el).position;
        return pos === 'fixed' || pos === 'sticky';
    };
    const hide = (el) => {
        if (done.has(el) || skip.has(el)) return;
        done.add(el);
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute('data-screenshot-hidden', 'consent');
        hidden++;
    };
    const candidates = document.querySelectorAll([
        '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
        '[id*="gdpr" i]', '[class*="gdpr" i]', '[id*="privacy" i]', '[class*="privacy" i]', '[id*="cmp" i]', '[class*="cmp" i]',
        '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
    ].join(','));
    for (const el of candidates) {
        if (skip.has(el) || el.closest('[data-screenshot-hidden]')) continue;
        if (/^(A|BUTTON|INPUT|LABEL|IMG|SVG|SCRIPT|STYLE|LINK|META|NOSCRIPT)$/i.test(el.tagName)) continue; // e.g. a "Cookie policy" link in a sticky header
        const named = NAME_RX.test(`${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('aria-label') ?? ''}`);
        // The fixed element can be the candidate itself or one of its close ancestors.
        let target = null;
        for (let node = el, depth = 0; node && !skip.has(node) && depth < 5; node = node.parentElement, depth++) {
            if (isOverlay(node)) {
                target = node;
                break;
            }
        }
        if (!target) continue;
        const text = (target.innerText || '').slice(0, 3000);
        if (text.length >= 3000) continue; // too much content to be a banner; never hide real page content
        // If the fixed element is an ancestor, the matched element must be most of it (not a small widget inside a sticky header).
        if (target !== el && (el.innerText || '').length < text.length * 0.5) continue;
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const mentions = TEXT_RX.test(text);
        const hasFrame = !!target.querySelector('iframe');
        const isBackdrop = named && !text.trim() && rect.width >= innerWidth * 0.9 && rect.height >= innerHeight * 0.9;
        if ((named && (mentions || hasFrame || isBackdrop)) || (!named && mentions && /cookie|consent/i.test(text))) hide(target);
    }
    if (hidden) {
        // Banners often lock scrolling (overflow: hidden on <html>/<body>); undo that so the full page renders.
        for (const el of [document.documentElement, document.body]) {
            if (el && getComputedStyle(el).overflowY === 'hidden') el.style.setProperty('overflow', 'visible', 'important');
        }
    }
    return hidden;
}

/** CSS that hides user-supplied selectors. One rule per selector so an invalid one does not break the rest. */
export function hideSelectorsCss(selectors) {
    return selectors.map((s) => `${s} { display: none !important; }`).join('\n');
}

/** Small built-in list of ad, tracking and analytics hosts (subdomains included). */
const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
    'googletagservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com', 'imasdk.googleapis.com',
    'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'revcontent.com',
    'mgid.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'moatads.com', 'adsrvr.org',
    'advertising.com', 'smartadserver.com', 'teads.tv', 'sharethrough.com', 'media.net', '33across.com', 'yieldmo.com',
    'bidswitch.net', 'quantserve.com', 'scorecardresearch.com', 'zedo.com', 'adform.net', 'serving-sys.com',
    'hotjar.com', 'mouseflow.com', 'fullstory.com', 'clarity.ms', 'bat.bing.com', 'ads-twitter.com', 'ads.linkedin.com',
    'connect.facebook.net', 'analytics.tiktok.com', 'adroll.com', 'ad.doubleclick.net', 'popads.net', 'propellerads.com',
    'exoclick.com', 'adcash.com', 'yandex.ru/ads', 'an.yandex.ru', 'mc.yandex.ru',
];

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches any http(s) request whose host is (a subdomain of) a listed ad/tracker host. */
export const AD_URL_RX = new RegExp(
    `^https?://([^/?#]+\\.)?(${AD_HOSTS.filter((h) => !h.includes('/')).map(escapeRx).join('|')})(:\\d+)?([/?#]|$)`,
    'i',
);

/** Cosmetic rules for ad slots that remain empty after their requests are blocked. */
export const AD_CSS = 'ins.adsbygoogle, iframe[id^="google_ads_iframe"], div[id^="div-gpt-ad"], [id^="taboola-"], .OUTBRAIN, .trc_related_container { display: none !important; }';

/**
 * Runs inside the page: scrolls down step by step so lazy-loaded images and sections load,
 * waits for pending images, then returns to the top.
 */
export async function autoScrollInPage({ maxHeight, maxMs }) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = Date.now();
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const limit = maxHeight > 0 ? maxHeight : 100000;
    let y = 0;
    while (Date.now() - started < maxMs) {
        const docHeight = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
        if (y + window.innerHeight >= Math.min(docHeight, limit)) break;
        y += step;
        window.scrollTo(0, y);
        await wait(120);
    }
    // Give images that started loading a moment to finish (bounded).
    const pending = [...document.images].filter((img) => !img.complete);
    if (pending.length) {
        await Promise.race([
            Promise.all(pending.map((img) => new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }))),
            wait(Math.max(500, Math.min(5000, maxMs - (Date.now() - started)))),
        ]);
    }
    window.scrollTo(0, 0);
    await wait(250);
    return y;
}

/** Runs inside a blank page: re-encodes a PNG (base64) as WebP using the browser's encoder. */
export async function pngToWebpInPage({ b64, quality }) {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality / 100));
    if (!blob || blob.type !== 'image/webp') throw new Error('WebP encoding failed');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
