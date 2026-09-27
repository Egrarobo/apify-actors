import { CaptureError, friendlyError, imageSize, sleep } from './utils.js';
import { COOKIE_CSS, AD_CSS, AD_URL_RX, hideConsentOverlaysInPage, hideSelectorsCss, autoScrollInPage, pngToWebpInPage } from './page-tweaks.js';

const WEBP_MAX = 16383;
const DOWNLOAD_TYPES = /^(application\/(pdf|zip|octet-stream|x-|vnd\.|msword|gzip)|audio\/|video\/|font\/)/i;

/** Screenshot through the DevTools protocol (no font/idle waiting). Supports PNG, JPEG and WebP natively. */
async function cdpScreenshot(page, { format, quality, clip, beyondViewport, scale = 1 }) {
    const cdp = await page.context().newCDPSession(page);
    try {
        const params = { format, captureBeyondViewport: !!beyondViewport, fromSurface: true };
        if (format !== 'png') params.quality = quality;
        if (clip) params.clip = { x: clip.x, y: clip.y, width: Math.ceil(clip.width), height: Math.ceil(clip.height), scale };
        const { data } = await cdp.send('Page.captureScreenshot', params);
        return Buffer.from(data, 'base64');
    } finally {
        await cdp.detach().catch(() => {});
    }
}

function proxySettings(proxyUrl) {
    if (!proxyUrl) return undefined;
    const u = new URL(proxyUrl);
    return {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
    };
}

/**
 * Loads one URL in a fresh browser context and captures it.
 * Returns buffers + metadata, or throws CaptureError. Never throws raw Playwright errors.
 */
export async function captureOnce({ browser, url, opts, userAgent, proxyUrl }) {
    const timeoutMs = opts.timeoutSecs * 1000;
    const warnings = [];
    const context = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
        screen: { width: opts.width, height: opts.height },
        deviceScaleFactor: opts.deviceScaleFactor,
        isMobile: opts.isMobile,
        hasTouch: opts.hasTouch,
        userAgent,
        colorScheme: opts.darkMode ? 'dark' : 'light',
        locale: 'en-US',
        ignoreHTTPSErrors: true,
        bypassCSP: true, // lets us inject the clean-up CSS on strict sites
        serviceWorkers: 'block', // service workers would bypass ad blocking
        acceptDownloads: false,
        proxy: proxySettings(proxyUrl),
    });
    // Hard stop for pages that hang the renderer: closing the context makes every pending call fail fast.
    let killed = false;
    const hardLimitMs = timeoutMs * 2 + opts.delaySecs * 1000 + 60000;
    const killer = setTimeout(() => {
        killed = true;
        context.close().catch(() => {});
    }, hardLimitMs);

    try {
        if (opts.blockAds) await context.route(AD_URL_RX, (route) => route.abort('blockedbyclient'));
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);

        let mainResponse = null;
        page.on('response', (res) => {
            try {
                if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) mainResponse = res;
            } catch { /* frame detached */ }
        });

        const started = Date.now();
        const deadline = started + timeoutMs;
        const remaining = () => Math.max(1000, deadline - Date.now());

        let response;
        try {
            response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        } catch (err) {
            const type = mainResponse?.headers()['content-type'] ?? '';
            if (/Download is starting|ERR_ABORTED/i.test(err.message) && (DOWNLOAD_TYPES.test(type) || /Download is starting/.test(err.message))) {
                throw new CaptureError(`This URL is a file download${type ? ` (${type.split(';')[0]})` : ''}, not a web page, so there is nothing to screenshot.`, { retryable: false, code: 'not-a-web-page' });
            }
            const f = friendlyError(err, { timeoutSecs: opts.timeoutSecs });
            throw new CaptureError(f.message, { retryable: f.retryable, code: 'navigation-failed' });
        }
        response = response ?? mainResponse;
        const status = response?.status() ?? null;
        const contentType = (response?.headers()['content-type'] ?? '').split(';')[0].trim() || null;
        if (contentType && DOWNLOAD_TYPES.test(contentType)) {
            const what = contentType === 'application/pdf' ? 'a PDF document' : `a file (${contentType})`;
            throw new CaptureError(`This URL is ${what}, not a web page, so there is nothing to screenshot.`, { retryable: false, code: 'not-a-web-page' });
        }
        if (contentType?.startsWith('image/')) warnings.push(`The URL is an image (${contentType}), not a web page; the screenshot shows the image.`);

        if (opts.waitUntil !== 'domcontentloaded') {
            try {
                await page.waitForLoadState(opts.waitUntil, { timeout: remaining() });
            } catch {
                warnings.push(`The page did not reach "${opts.waitUntil}" within ${opts.timeoutSecs} s (slow resources or constant network activity); the screenshot was taken anyway.`);
            }
        }

        const css = [
            opts.hideCookieBanners ? COOKIE_CSS : '',
            opts.blockAds ? AD_CSS : '',
            opts.hideSelectors.length ? hideSelectorsCss(opts.hideSelectors) : '',
        ].filter(Boolean).join('\n');
        if (css) await page.addStyleTag({ content: css }).catch(() => warnings.push('Could not inject the clean-up CSS into this page.'));

        if (opts.waitForSelector) {
            try {
                await page.waitForSelector(opts.waitForSelector, { state: 'visible', timeout: remaining() });
            } catch (err) {
                if (/Unexpected token|not a valid selector|SyntaxError/i.test(err.message)) {
                    throw new CaptureError(`"Wait for element" is not a valid CSS selector: ${opts.waitForSelector}`, { retryable: false, code: 'bad-selector' });
                }
                throw new CaptureError(`The element "${opts.waitForSelector}" did not appear within ${opts.timeoutSecs} s.`, { code: 'selector-timeout' });
            }
        }

        if (opts.scrollToBottom && (opts.fullPage || opts.clipSelector)) {
            await page.evaluate(autoScrollInPage, { maxHeight: opts.maxHeight, maxMs: Math.min(20000, remaining()) })
                .catch(() => warnings.push('Scrolling the page to load lazy images failed; some images may be missing.'));
        }

        if (opts.delaySecs > 0) await sleep(opts.delaySecs * 1000);

        let cookieBannersHidden = 0;
        if (opts.hideCookieBanners) {
            cookieBannersHidden = await page.evaluate(hideConsentOverlaysInPage).catch(() => 0);
        }

        // --- Screenshot ---
        const pwType = opts.format === 'jpeg' ? 'jpeg' : 'png';
        const shotOpts = { type: pwType, timeout: Math.max(30000, remaining()) };
        if (pwType === 'jpeg') shotOpts.quality = opts.quality;
        let buffer;
        let truncated = false;
        // Playwright waits for web fonts before a screenshot; on pages with a request that never finishes
        // that wait never ends. In that case we capture through the DevTools protocol directly.
        const fontsReady = await page.evaluate(() => Promise.race([
            document.fonts.ready.then(() => true),
            new Promise((r) => setTimeout(() => r(false), 3000)),
        ])).catch(() => false);
        const useCdp = !fontsReady;
        if (useCdp) warnings.push('Some page resources never finished loading; the screenshot was taken without waiting for them.');
        let nativeWebp = false;

        if (opts.clipSelector) {
            const loc = page.locator(opts.clipSelector).first();
            try {
                await loc.waitFor({ state: 'visible', timeout: Math.min(remaining(), 15000) });
            } catch (err) {
                if (/Unexpected token|not a valid selector|SyntaxError/i.test(err.message)) {
                    throw new CaptureError(`"Capture only this element" is not a valid CSS selector: ${opts.clipSelector}`, { retryable: false, code: 'bad-selector' });
                }
                throw new CaptureError(`The element "${opts.clipSelector}" was not found (or is not visible) on the page.`, { code: 'element-not-found' });
            }
            if (useCdp) {
                await loc.scrollIntoViewIfNeeded().catch(() => {});
                const box = await loc.evaluate((el) => {
                    const r = el.getBoundingClientRect();
                    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
                });
                buffer = await cdpScreenshot(page, { format: opts.format, quality: opts.quality, clip: box, beyondViewport: true, scale: opts.deviceScaleFactor });
                nativeWebp = true;
            } else {
                buffer = await loc.screenshot(shotOpts);
            }
        } else {
            let maxHeight = opts.maxHeight;
            if (opts.format === 'webp') {
                const cap = Math.floor(WEBP_MAX / opts.deviceScaleFactor);
                maxHeight = maxHeight > 0 ? Math.min(maxHeight, cap) : cap;
            }
            let captureHeight = opts.height;
            if (opts.fullPage) {
                const pageHeight = await page.evaluate(() => Math.max(
                    document.documentElement.scrollHeight,
                    document.body ? document.body.scrollHeight : 0,
                ));
                captureHeight = pageHeight;
                if (maxHeight > 0 && pageHeight > maxHeight) {
                    truncated = true;
                    captureHeight = maxHeight;
                    shotOpts.clip = { x: 0, y: 0, width: opts.width, height: maxHeight };
                    warnings.push(`The page is ${pageHeight} px tall; the screenshot was cut at "Max. height" = ${maxHeight} px.`);
                }
                shotOpts.fullPage = true;
            }
            if (useCdp) {
                await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
                buffer = await cdpScreenshot(page, {
                    format: opts.format,
                    quality: opts.quality,
                    clip: { x: 0, y: 0, width: opts.width, height: captureHeight },
                    beyondViewport: opts.fullPage,
                    scale: opts.deviceScaleFactor,
                });
                nativeWebp = true;
            } else {
                buffer = await page.screenshot(shotOpts);
            }
        }
        if (opts.format === 'webp' && !nativeWebp) {
            const helper = await context.newPage();
            try {
                const b64 = await helper.evaluate(pngToWebpInPage, { b64: buffer.toString('base64'), quality: opts.quality });
                buffer = Buffer.from(b64, 'base64');
            } finally {
                await helper.close().catch(() => {});
            }
        }
        const size = imageSize(buffer) ?? { width: null, height: null };
        const title = await page.title().catch(() => '');

        let pdfBuffer = null;
        if (opts.savePdf) {
            try {
                pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, timeout: Math.max(30000, remaining()) });
            } catch (err) {
                warnings.push(`PDF export failed: ${friendlyError(err, opts).message}`);
            }
        }

        return {
            finalUrl: page.url(),
            status,
            contentType,
            title,
            buffer,
            pdfBuffer,
            width: size.width,
            height: size.height,
            truncated,
            cookieBannersHidden,
            loadTimeMs: Date.now() - started,
            warnings,
        };
    } catch (err) {
        if (err instanceof CaptureError) throw err;
        if (killed) throw new CaptureError(`The page stopped responding and was closed after ${Math.round(hardLimitMs / 1000)} s.`, { code: 'hung' });
        const f = friendlyError(err, { timeoutSecs: opts.timeoutSecs });
        throw new CaptureError(f.message, { retryable: f.retryable, code: 'capture-failed' });
    } finally {
        clearTimeout(killer);
        await context.close().catch(() => {});
    }
}
