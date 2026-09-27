// Lightweight OCR with tesseract.js (WASM). Language data ships inside the image (npm @tesseract.js-data/*),
// so no network access is needed at run time. One worker is created lazily and reused for the whole run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
export const OCR_LANGUAGES = ['eng', 'ron', 'rus'];

let workerPromise = null;
let workerLangs = '';

function prepareLangDir(langs) {
    const dir = path.join(os.tmpdir(), 'tessdata');
    fs.mkdirSync(dir, { recursive: true });
    for (const lang of langs) {
        const target = path.join(dir, `${lang}.traineddata.gz`);
        if (fs.existsSync(target)) continue;
        const pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
        fs.copyFileSync(path.join(pkgDir, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
    }
    return dir;
}

async function getWorker(langs) {
    const key = langs.join('+');
    if (workerPromise && workerLangs === key) return workerPromise;
    if (workerPromise) await (await workerPromise).terminate();
    workerLangs = key;
    const langPath = prepareLangDir(langs);
    workerPromise = createWorker(langs, 1, { langPath, cachePath: langPath, gzip: true, logger: () => {} });
    return workerPromise;
}

/** Tesseract plain text -> Markdown paragraphs (joins wrapped lines, removes line-end hyphenation). */
export function ocrTextToMarkdown(text) {
    return String(text ?? '')
        .split(/\n\s*\n/)
        .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)
            .reduce((acc, l) => (acc && /\p{Ll}-$/u.test(acc) && /^\p{Ll}/u.test(l) ? acc.slice(0, -1) + l : acc ? `${acc} ${l}` : l), ''))
        .filter(Boolean)
        .join('\n\n');
}

/** OCR an image (PNG/JPG/... buffer). Returns { markdown, confidence }. */
export async function ocrImage(buffer, langs = ['eng']) {
    const worker = await getWorker(langs);
    const { data } = await worker.recognize(buffer);
    return { markdown: ocrTextToMarkdown(data.text), confidence: Math.round(data.confidence ?? 0) };
}

export async function terminateOcr() {
    if (!workerPromise) return;
    try { await (await workerPromise).terminate(); } catch { /* ignore */ }
    workerPromise = null;
}
