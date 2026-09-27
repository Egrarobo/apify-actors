import { Actor, log } from 'apify';

const TELEGRAM_API = process.env.PROZORRO_TELEGRAM_API || 'https://api.telegram.org';
const TELEGRAM_LIMIT = 4000;
const TIMEOUT_MS = 20_000;

const n = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
const short = (s, max) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);
const day = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : null);

/** One readable line (plus link) per auction. */
export function auctionLine(a) {
    const bits = [];
    if (a.startingPrice !== null && a.startingPrice !== undefined) bits.push(`${n(a.startingPrice)} ${a.currency ?? 'UAH'}`);
    if (a.region || a.city) bits.push([a.city, a.region].filter(Boolean).join(', '));
    if (a.auctionDate) bits.push(`auction ${day(a.auctionDate)}`);
    const head = `🆕 ${a.auctionId ?? a.procedureId}: ${short(a.title ?? '(no title)', 140)}`;
    return `${head}${bits.length ? `\n    ${bits.join(' · ')}` : ''}${a.url ? `\n    ${a.url}` : ''}`;
}

export function buildMessage({ monitorName, newCount, preview, resultsUrl, costLimitReached, scan }) {
    const lines = [newCount
        ? `🔔 ${monitorName}: ${n(newCount)} new Prozorro.Sale auction${newCount === 1 ? '' : 's'}`
        : `✅ ${monitorName}: no new auctions (${n(scan?.recordsScanned ?? 0)} checked)`];
    if (costLimitReached) lines.push('⚠️ Maximum cost per run reached: some new auctions were not saved. They will be reported in the next run.');
    for (const a of preview) lines.push(auctionLine(a));
    const more = newCount - preview.length;
    if (more > 0) lines.push(`…and ${n(more)} more`);
    if (resultsUrl) lines.push(`All results: ${resultsUrl}`);
    return lines.join('\n');
}

async function post(url, body, what) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`${what} answered HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
}

function splitMessage(text, limit) {
    const parts = [];
    let cur = '';
    for (const line of text.split('\n')) {
        const piece = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
        if (cur && cur.length + piece.length + 1 > limit) {
            parts.push(cur);
            cur = '';
        }
        cur = cur ? `${cur}\n${piece}` : piece;
    }
    if (cur) parts.push(cur);
    return parts;
}

/** Sends every configured notification. Failures are logged and returned, never thrown. */
export async function sendNotifications(input, ctx) {
    const results = {};
    const text = buildMessage(ctx);
    const run = async (name, fn) => {
        try {
            await fn();
            results[name] = 'sent';
            log.info(`Notification sent: ${name}`);
        } catch (err) {
            results[name] = `failed: ${err.message}`;
            log.warning(`Could not send ${name} notification: ${err.message}`);
        }
    };

    const botToken = input.telegramBotToken?.trim();
    const chatId = String(input.telegramChatId ?? '').trim();
    if (botToken || chatId) {
        if (!botToken || !chatId) {
            results.telegram = 'skipped: both "Telegram bot token" and "Telegram chat ID" are needed';
            log.warning(results.telegram);
        } else {
            await run('telegram', async () => {
                for (const part of splitMessage(text, TELEGRAM_LIMIT)) {
                    await post(`${TELEGRAM_API}/bot${botToken}/sendMessage`, { chat_id: chatId, text: part, disable_web_page_preview: true }, 'Telegram')
                        .catch((err) => { throw new Error(err.message.replaceAll(botToken, '***')); });
                }
            });
        }
    }

    if (input.slackWebhookUrl?.trim()) {
        await run('slack', () => post(input.slackWebhookUrl.trim(), { text }, 'Slack'));
    }

    if (input.webhookUrl?.trim()) {
        const body = {
            event: ctx.newCount ? 'auctions.new' : 'auctions.none',
            monitorName: ctx.monitorName,
            newCount: ctx.newCount,
            costLimitReached: !!ctx.costLimitReached,
            scan: ctx.scan ?? null,
            resultsUrl: ctx.resultsUrl ?? null,
            runId: process.env.ACTOR_RUN_ID ?? process.env.APIFY_ACTOR_RUN_ID ?? null,
            datasetId: process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID ?? null,
            message: text,
            auctions: ctx.webhookItems,
        };
        await run('webhook', () => post(input.webhookUrl.trim(), body, 'Webhook'));
    }

    if (input.emailTo?.trim()) {
        await run('email', async () => {
            const subject = input.emailSubject?.trim() || `${ctx.monitorName}: ${ctx.newCount} new Prozorro.Sale auction${ctx.newCount === 1 ? '' : 's'}`;
            const res = await Actor.call('apify/send-mail', { to: input.emailTo.trim(), subject, text }, { memory: 256 });
            if (res?.status && res.status !== 'SUCCEEDED') throw new Error(`apify/send-mail finished with status ${res.status}`);
        });
    }
    return results;
}
