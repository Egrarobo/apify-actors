import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { parseOptions, collectUrls, userAgentFor } from './input.js';
import { captureOnce } from './capture.js';
import { CaptureError, recordKey, sleep } from './utils.js';

const EVENT_SCREENSHOT = 'screenshot';
const EVENT_PDF = 'pdf-export';
const STATE_KEY = 'STATE';
const ZIP_KEY = 'screenshots.zip';
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

await Actor.init();

let browser = null;
try {
    const input = (await Actor.getInput()) ?? {};
    const opts = parseOptions(input);
    const { jobs, invalid } = await collectUrls(input);
    if (!jobs.length && !invalid.length) {
        throw new Error('No URLs to capture. Add web addresses to "URLs", or set "…or dataset with URLs" to read them from another Actor\'s results.');
    }

    const kvs = await Actor.openKeyValueStore();
    const proxyConfiguration = input.proxyConfiguration?.useApifyProxy || input.proxyConfiguration?.proxyUrls?.length
        ? await Actor.createProxyConfiguration(input.proxyConfiguration)
        : undefined;

    // --- Pay-per-event budget: never start a URL whose charges might not fit into the user's spending limit ---
    const chargingManager = Actor.getChargingManager();
    const pricing = chargingManager.getPricingInfo();
    const isPpe = pricing.isPayPerEvent;
    const priceOf = (event) => pricing.perEventPrices?.[event] ?? (Actor.isAtHome() ? 0 : 1); // the SDK prices unknown events at $1 locally
    const costPerUrl = priceOf(EVENT_SCREENSHOT) + (opts.savePdf ? priceOf(EVENT_PDF) : 0);
    let reservedUsd = 0;
    const remainingUsd = () => {
        if (!isPpe) return Infinity;
        const shotPrice = priceOf(EVENT_SCREENSHOT);
        return shotPrice > 0 ? chargingManager.calculateMaxEventChargeCountWithinLimit(EVENT_SCREENSHOT) * shotPrice : Infinity;
    };
    const reserve = () => {
        if (!isPpe || costPerUrl <= 0) return true;
        if (remainingUsd() - reservedUsd < costPerUrl - 1e-9) return false;
        reservedUsd += costPerUrl;
        return true;
    };
    const release = () => {
        if (isPpe && costPerUrl > 0) reservedUsd = Math.max(0, reservedUsd - costPerUrl);
    };
    /** Charges one event only if it surely fits into the limit (Actor.charge would otherwise overcharge by one). */
    const chargeOne = async (event) => {
        if (!isPpe) return true;
        if (chargingManager.calculateMaxEventChargeCountWithinLimit(event) < 1) return false;
        const res = await Actor.charge({ eventName: event, count: 1 });
        return res.chargedCount >= 1;
    };

    // --- State survives migrations/restarts so no URL is captured (or charged) twice ---
    const state = (await kvs.getValue(STATE_KEY)) ?? { done: {}, invalidReported: false, stats: null };
    const stats = state.stats ?? { succeeded: 0, failed: 0, invalid: 0, pdfs: 0, httpErrors: 0, charged: { [EVENT_SCREENSHOT]: 0, [EVENT_PDF]: 0 } };
    state.stats = stats;
    const persist = () => kvs.setValue(STATE_KEY, state);
    Actor.on('persistState', persist);
    Actor.on('migrating', persist);
    const resumed = Object.keys(state.done).length;
    if (resumed) log.info(`Resuming: ${resumed} URL(s) were already processed before the restart.`);

    if (invalid.length && !state.invalidReported) {
        const takenAt = new Date().toISOString();
        await Actor.pushData(invalid.map((i) => ({ url: i.url, finalUrl: null, status: null, title: null, screenshotUrl: null, error: i.error, errorType: 'invalid-url', takenAt })));
        stats.invalid = invalid.length;
        state.invalidReported = true;
        log.warning(`${invalid.length} invalid URL(s) reported in the results and skipped (not charged).`);
    }

    // --- Browser ---
    const launch = () => chromium.launch({
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--disable-blink-features=AutomationControlled', '--disable-background-networking'],
    });
    browser = await launch();
    let relaunching = null;
    const getBrowser = async () => {
        if (browser.isConnected()) return browser;
        relaunching ??= launch().then((b) => { browser = b; relaunching = null; log.warning('The browser crashed and was restarted.'); return b; });
        return relaunching;
    };
    const chromeMajor = (browser.version().match(/^(\d+)/) ?? [])[1] ?? '140';
    const userAgent = opts.userAgent ?? userAgentFor(opts.uaKind, chromeMajor);

    const todo = jobs.filter((j) => !state.done[j.url]);
    log.info(`Capturing ${todo.length} URL(s): ${opts.device} ${opts.width}×${opts.height} @${opts.deviceScaleFactor}x, ${opts.fullPage ? 'full page' : 'viewport'}, `
        + `${opts.format.toUpperCase()}${opts.savePdf ? ' + PDF' : ''}, concurrency ${opts.maxConcurrency}${proxyConfiguration ? ', proxy on' : ''}.`);

    let stopReason = null;
    let started = 0;
    let finished = 0;

    const processJob = async (job) => {
        const attempts = opts.retries + 1;
        let result = null;
        let lastError = null;
        let attempt = 0;
        for (attempt = 1; attempt <= attempts; attempt++) {
            try {
                const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl(`s${job.index}_${attempt}_${Date.now() % 1e6}`) : undefined;
                result = await captureOnce({ browser: await getBrowser(), url: job.url, opts, userAgent, proxyUrl });
                const retryStatus = result.status === 429 || (result.status >= 500 && result.status <= 599);
                if (retryStatus && attempt < attempts) {
                    log.info(`${job.url}: HTTP ${result.status}, retrying (${attempt}/${attempts}).`);
                    result = null;
                    await sleep(1000 * attempt);
                    continue;
                }
                break;
            } catch (err) {
                lastError = err instanceof CaptureError ? err : new CaptureError(String(err?.message ?? err));
                if (!lastError.retryable || attempt >= attempts) break;
                log.info(`${job.url}: ${lastError.message} Retrying (${attempt}/${attempts}).`);
                await sleep(1000 * attempt);
            }
        }
        attempt = Math.min(attempt, attempts);
        const takenAt = new Date().toISOString();

        if (!result) {
            stats.failed++;
            log.warning(`✗ ${job.url}: ${lastError?.message}`);
            await Actor.pushData({
                url: job.url, finalUrl: null, status: null, title: null, screenshotUrl: null,
                error: lastError?.message ?? 'Unknown error', errorType: lastError?.code ?? 'error', attempts: attempt, takenAt,
            });
            return;
        }

        if (!(await chargeOne(EVENT_SCREENSHOT))) {
            stopReason = 'cost-limit';
            await Actor.pushData({ url: job.url, finalUrl: result.finalUrl, status: result.status, title: result.title, screenshotUrl: null, error: 'Not saved: the run reached your maximum cost per run.', errorType: 'cost-limit', takenAt });
            return;
        }
        stats.charged[EVENT_SCREENSHOT] += isPpe ? 1 : 0;
        const key = recordKey(job.url, EXT[opts.format]);
        await kvs.setValue(key, result.buffer, { contentType: MIME[opts.format] });

        let pdfKey = null;
        let pdfUrl = null;
        if (result.pdfBuffer) {
            if (await chargeOne(EVENT_PDF)) {
                stats.charged[EVENT_PDF] += isPpe ? 1 : 0;
                pdfKey = recordKey(job.url, 'pdf');
                await kvs.setValue(pdfKey, result.pdfBuffer, { contentType: 'application/pdf' });
                pdfUrl = kvs.getPublicUrl(pdfKey);
                stats.pdfs++;
            } else {
                result.warnings.push('PDF not saved: the run reached your maximum cost per run.');
            }
        }

        stats.succeeded++;
        if (result.status >= 400) stats.httpErrors++;
        const item = {
            url: job.url,
            finalUrl: result.finalUrl,
            status: result.status,
            title: result.title,
            screenshotUrl: kvs.getPublicUrl(key),
            screenshotKey: key,
            pdfUrl,
            pdfKey,
            format: opts.format,
            device: opts.device,
            width: result.width,
            height: result.height,
            fullPage: opts.fullPage && !opts.clipSelector,
            truncated: result.truncated,
            bytes: result.buffer.length,
            contentType: result.contentType,
            cookieBannersHidden: result.cookieBannersHidden,
            loadTimeMs: result.loadTimeMs,
            attempts: attempt,
            warnings: result.warnings,
            takenAt,
            error: null,
        };
        state.done[job.url] = { key, pdfKey };
        await Actor.pushData(item);
        log.info(`✓ ${job.url} → HTTP ${result.status ?? '?'}, ${result.width}×${result.height}, ${(result.buffer.length / 1024).toFixed(0)} kB${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}`);
    };

    let cursor = 0;
    const worker = async () => {
        while (!stopReason && cursor < todo.length) {
            if (!reserve()) {
                stopReason = 'cost-limit';
                break;
            }
            const job = todo[cursor++];
            started++;
            try {
                await processJob(job);
            } catch (err) {
                // Storage/API problems for one URL must not stop the others.
                stats.failed++;
                log.exception(err, `Unexpected error for ${job.url}`);
                await Actor.pushData({ url: job.url, screenshotUrl: null, error: `Internal error: ${err.message}`, errorType: 'internal', takenAt: new Date().toISOString() }).catch(() => {});
            } finally {
                release();
                state.done[job.url] ??= { key: null };
                finished++;
                if (finished % 25 === 0) {
                    await Actor.setStatusMessage(`${finished}/${todo.length} URLs processed (${stats.succeeded} OK, ${stats.failed} failed)`).catch(() => {});
                    await persist().catch(() => {});
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(opts.maxConcurrency, Math.max(1, todo.length)) }, worker));
    await browser.close().catch(() => {});
    browser = null;

    const notProcessed = todo.length - started;
    if (stopReason === 'cost-limit') {
        log.warning(`Stopped because the run reached your maximum cost per run. ${notProcessed} URL(s) were not processed. Raise the limit and run again to capture the rest.`);
    }

    // --- Optional ZIP of every saved file (read back from storage, so memory stays low during the crawl) ---
    let zipUrl = null;
    if (opts.outputZip) {
        const entries = Object.values(state.done).flatMap((d) => [d.key, d.pdfKey]).filter(Boolean);
        if (entries.length) {
            const zip = new JSZip();
            let total = 0;
            for (const key of entries) {
                const buf = await kvs.getValue(key);
                if (!buf) continue;
                total += buf.length;
                if (total > 1.5 * 1024 ** 3) {
                    log.warning('The ZIP would exceed 1.5 GB, so it was limited to the files added so far.');
                    break;
                }
                zip.file(key, buf);
            }
            const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
            await kvs.setValue(ZIP_KEY, zipBuf, { contentType: 'application/zip' });
            zipUrl = kvs.getPublicUrl(ZIP_KEY);
            log.info(`ZIP with ${entries.length} file(s) saved: ${ZIP_KEY} (${(zipBuf.length / 1024 / 1024).toFixed(1)} MB).`);
        }
    }

    const datasetId = process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID;
    const output = {
        totalUrls: jobs.length + invalid.length,
        succeeded: stats.succeeded,
        failed: stats.failed,
        invalidUrls: stats.invalid,
        notProcessed,
        withHttpErrorStatus: stats.httpErrors,
        pdfs: stats.pdfs,
        chargedEvents: isPpe ? stats.charged : {},
        stoppedAtCostLimit: stopReason === 'cost-limit',
        zipUrl,
        resultsUrl: Actor.isAtHome() && datasetId ? `https://console.apify.com/storage/datasets/${datasetId}` : null,
        settings: {
            device: opts.device, width: opts.width, height: opts.height, scaleFactor: opts.deviceScaleFactor,
            fullPage: opts.fullPage, format: opts.format, savePdf: opts.savePdf,
        },
        finishedAt: new Date().toISOString(),
    };
    await Actor.setValue('OUTPUT', output);
    Actor.off('persistState', persist);
    Actor.off('migrating', persist);
    await kvs.setValue(STATE_KEY, null); // run finished: the resume state is no longer needed

    const status = `${stats.succeeded} screenshot(s) saved, ${stats.failed + stats.invalid} failed`
        + `${notProcessed ? `, ${notProcessed} not processed (cost limit)` : ''}.`;
    log.info(status);
    await Actor.exit({ statusMessage: status });
} catch (err) {
    if (browser) await browser.close().catch(() => {});
    log.error(err.message);
    await Actor.fail(err.message);
}
