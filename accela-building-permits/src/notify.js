// Monitor notifications (Telegram, Slack, webhook, email). Same design as the mtender Actor's notify.js.
import { Actor, log } from 'apify';

const TELEGRAM_API = process.env.ACCELA_TELEGRAM_API || 'https://api.telegram.org';
const TELEGRAM_LIMIT = 4000;
const TIMEOUT_MS = 20_000;

const n = (x) => Number(x).toLocaleString('en-US');
const short = (s, max = 160) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function permitLine(p) {
    const where = [p.address, p.city].filter(Boolean).join(', ') || p.fullAddress || '';
    const bits = [];
    if (p.status) bits.push(p.status);
    if (p.openedDate) bits.push(`opened ${p.openedDate}`);
    if (p.valuation !== null && p.valuation !== undefined) bits.push(`$${n(p.valuation)}`);
    if (p.contractorName) bits.push(short(p.contractorName, 60));
    const head = `🏗️ ${p.agency} ${p.recordNumber} · ${short(p.recordType || p.category, 80)}`;
    const addr = where ? `\n    ${short(where, 120)}` : '';
    const desc = p.description ? `\n    ${short(p.description, 140)}` : '';
    const meta = bits.length ? `\n    ${bits.join(' · ')}` : '';
    const link = p.detailUrl ? `\n    ${p.detailUrl}` : '';
    return `${head}${addr}${desc}${meta}${link}`;
}

export function buildMessage({ monitorName, summary, previewPermits, resultsUrl, costLimitReached }) {
    const lines = [summary.newPermits
        ? `🔔 ${monitorName}: ${n(summary.newPermits)} new permit${summary.newPermits === 1 ? '' : 's'} (${summary.agencies.join(', ')})`
        : `✅ ${monitorName}: no new permits (${summary.agencies.join(', ')}, ${n(summary.checked)} checked)`];
    if (summary.failedAgencies?.length) lines.push(`⚠️ Could not check: ${summary.failedAgencies.join(', ')}`);
    if (costLimitReached) lines.push(`⚠️ Maximum cost per run reached: only ${n(summary.newPermits)} permits were saved. The rest will be reported on the next run.`);
    for (const p of previewPermits) lines.push(permitLine(p));
    const more = summary.newPermits - previewPermits.length;
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

export const hasNotificationTargets = (input) => !!(input.telegramBotToken?.trim() || String(input.telegramChatId ?? '').trim()
    || input.slackWebhookUrl?.trim() || input.webhookUrl?.trim() || input.emailTo?.trim());

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

    if (input.slackWebhookUrl?.trim()) await run('slack', () => post(input.slackWebhookUrl.trim(), { text }, 'Slack'));

    if (input.webhookUrl?.trim()) {
        const body = {
            event: ctx.summary.newPermits ? 'permits.new' : 'permits.none',
            monitorName: ctx.monitorName,
            summary: { ...ctx.summary, costLimitReached: !!ctx.costLimitReached },
            resultsUrl: ctx.resultsUrl ?? null,
            runId: process.env.ACTOR_RUN_ID ?? process.env.APIFY_ACTOR_RUN_ID ?? null,
            datasetId: process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID ?? null,
            message: text,
            permits: ctx.webhookPermits,
        };
        await run('webhook', () => post(input.webhookUrl.trim(), body, 'Webhook'));
    }

    if (input.emailTo?.trim()) {
        await run('email', async () => {
            const subject = input.emailSubject?.trim()
                || (ctx.summary.newPermits ? `${ctx.monitorName}: ${ctx.summary.newPermits} new building permit(s)` : `${ctx.monitorName}: no new building permits`);
            const res = await Actor.call('apify/send-mail', { to: input.emailTo.trim(), subject, text }, { memory: 256 });
            if (res?.status && res.status !== 'SUCCEEDED') throw new Error(`apify/send-mail finished with status ${res.status}`);
        });
    }
    return results;
}
