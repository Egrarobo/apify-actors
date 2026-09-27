import { Actor, log } from 'apify';
import Papa from 'papaparse';

const PAGE_SIZE = 1000;

const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim())?.trim();

/**
 * Figures out where the items come from. Supports the webhook / integration payload that Apify sends
 * when this Actor runs after another Actor ("resource" = the finished run).
 */
export async function resolveSource(input) {
    const resource = input.payload?.resource ?? input.resource ?? null;
    const sourceRun = {
        runId: pick(input.actorRunId, resource?.id),
        actorId: pick(resource?.actId),
        taskId: pick(resource?.actorTaskId),
    };

    if (Array.isArray(input.items) && input.items.length) {
        return { kind: 'items', description: `${input.items.length} items from input`, sourceRun, iterate: iterateArray(input.items) };
    }

    let datasetId = pick(input.datasetId, resource?.defaultDatasetId);
    if (!datasetId && pick(input.actorRunId)) {
        if (!Actor.isAtHome() && !process.env.APIFY_TOKEN) {
            throw new Error('"actorRunId" needs an Apify API token. Run the Actor on the Apify platform or set APIFY_TOKEN.');
        }
        const run = await Actor.apifyClient.run(input.actorRunId.trim()).get();
        if (!run) throw new Error(`Actor run "${input.actorRunId}" was not found. Check the run ID and that your account can access it.`);
        if (!['SUCCEEDED', 'ABORTED', 'TIMED-OUT', 'FAILED'].includes(run.status)) {
            log.warning(`Run ${run.id} is still ${run.status}. Only items stored so far will be compared.`);
        }
        datasetId = run.defaultDatasetId;
        sourceRun.actorId ??= run.actId;
        sourceRun.taskId ??= run.actorTaskId ?? undefined;
    }
    if (datasetId) {
        return { kind: 'dataset', description: `dataset ${datasetId}`, datasetId, sourceRun, iterate: iterateDataset(datasetId) };
    }

    if (pick(input.datasetUrl)) {
        const url = input.datasetUrl.trim();
        return { kind: 'url', description: url.replace(/([?&]token=)[^&]+/, '$1***'), sourceRun, iterate: await iterateUrl(url) };
    }

    throw new Error('No data to compare. Provide "datasetId", "actorRunId", "datasetUrl" or "items". '
        + 'When you use this Actor as an integration after another Actor, the dataset is detected automatically.');
}

function iterateArray(items) {
    return async function* () {
        for (let i = 0; i < items.length; i += PAGE_SIZE) yield items.slice(i, i + PAGE_SIZE);
    };
}

function iterateDataset(datasetId) {
    return async function* () {
        // Use the client directly: Actor.openDataset() would silently create a new, empty named dataset on a typo.
        const useCloud = Actor.isAtHome() || !!process.env.APIFY_TOKEN;
        const client = (useCloud ? Actor.apifyClient : Actor.config.getStorageClient()).dataset(datasetId);
        let info;
        try {
            info = await client.get();
        } catch (err) {
            throw new Error(`Could not open dataset "${datasetId}": ${err.message}`);
        }
        if (!info) throw new Error(`Dataset "${datasetId}" was not found. Check the ID (or name) and that your account can access it.`);
        let offset = 0;
        for (;;) {
            let page;
            try {
                page = await client.listItems({ offset, limit: PAGE_SIZE, clean: true });
            } catch (err) {
                throw new Error(`Could not read dataset "${datasetId}": ${err.message}`);
            }
            if (!page.items.length) return;
            yield page.items;
            offset += page.items.length;
        }
    };
}

async function iterateUrl(url) {
    let res;
    try {
        res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    } catch (err) {
        throw new Error(`Could not download ${url}: ${err.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status}). The link must be public or include a token.`);
    const items = parseText(text, res.headers.get('content-type') ?? '', url);
    return iterateArray(items);
}

function parseText(raw, contentType, url) {
    const text = raw.replace(/^﻿/, '');
    const trimmed = text.trimStart();
    if (/^<(!doctype|html)/i.test(trimmed)) throw new Error(`${url} returned a web page, not JSON or CSV data.`);
    const looksJson = /json/i.test(contentType) || trimmed.startsWith('[') || trimmed.startsWith('{');
    if (looksJson && !/csv/i.test(contentType)) {
        try {
            const data = JSON.parse(text);
            const items = Array.isArray(data) ? data : data.items ?? data.data?.items ?? data.data;
            if (!Array.isArray(items)) throw new Error('not an array');
            return items;
        } catch {
            // JSON Lines: one object per line
            const lines = text.split(/\r?\n/).filter((l) => l.trim());
            try {
                return lines.map((l) => JSON.parse(l));
            } catch {
                throw new Error(`${url} is not valid JSON. Expected an array of objects, {"items": [...]}, JSON Lines or CSV.`);
            }
        }
    }
    const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
    if (!res.meta.fields?.length) throw new Error(`${url} could not be read as CSV (no header row).`);
    return res.data;
}
