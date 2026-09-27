import { Actor, log } from 'apify';

const TELEGRAM_API = process.env.CHANGE_MONITOR_TELEGRAM_API || 'https://api.telegram.org';
const TELEGRAM_LIMIT = 4000;
const TIMEOUT_MS = 20_000;

const ICON = { new: '🆕', changed: '✏️', removed: '❌' };
const LABEL = { new: 'NEW', changed: 'CHANGED', removed: 'REMOVED' };

const short = (v, max = 80) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) return '∅';
    return s.length > max ? `${s.slice(0, max)}…` : s;
};

const n = (x) => Number(x).toLocaleString('en-US');

/** Readable label for a change: the key, or a title-like field when the key is only a hash. */
export function changeLabel(change) {
    if (!change.key.startsWith('#')) return change.key;
    const it = change.item ?? {};
    return short(it.title ?? it.name ?? it.url ?? change.key, 100);
}

export function buildMessage({ monitorName, summary, previewChanges, resultsUrl, costLimitReached }) {
    const head = summary.reported
        ? `🔔 ${monitorName}: ${summary.new} new, ${summary.changed} changed, ${summary.removed} removed (${n(summary.itemsCompared)} items checked)`
        : `✅ ${monitorName}: no changes (${n(summary.itemsCompared)} items checked)`;
    const lines = [head];
    if (costLimitReached) lines.push(`⚠️ Maximum cost per run reached: only ${n(summary.reported)} changes were saved. Raise the limit to get all of them.`);
    const order = { new: 0, changed: 1, removed: 2 };
    for (const c of [...previewChanges].sort((a, b) => order[a.changeType] - order[b.changeType])) {
        let line = `${ICON[c.changeType]} ${LABEL[c.changeType]}: ${changeLabel(c)}`;
        if (c.changeType === 'changed' && c.changes?.length) {
            line += `\n    ${c.changes.slice(0, 3).map((ch) => `${ch.field}: ${short(ch.before, 40)} → ${short(ch.after, 40)}`).join('; ')}`;
            if (c.totalChangedFields > 3) line += ` (+${c.totalChangedFields - 3} more fields)`;
        }
        lines.push(line);
    }
    const more = summary.reported - previewChanges.length;
    if (more > 0) lines.push(`…and ${n(more)} more`);
    if (resultsUrl) lines.push(`Full results: ${resultsUrl}`);
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
            event: ctx.summary.reported ? 'changes.detected' : 'changes.none',
            monitorName: ctx.monitorName,
            summary: { ...ctx.summary, costLimitReached: !!ctx.costLimitReached },
            resultsUrl: ctx.resultsUrl ?? null,
            runId: process.env.ACTOR_RUN_ID ?? process.env.APIFY_ACTOR_RUN_ID ?? null,
            datasetId: process.env.ACTOR_DEFAULT_DATASET_ID ?? process.env.APIFY_DEFAULT_DATASET_ID ?? null,
            message: text,
            changes: ctx.webhookChanges,
        };
        await run('webhook', () => post(input.webhookUrl.trim(), body, 'Webhook'));
    }

    if (input.emailTo?.trim()) {
        await run('email', async () => {
            const subject = input.emailSubject?.trim()
                || `${ctx.monitorName}: ${ctx.summary.new} new, ${ctx.summary.changed} changed, ${ctx.summary.removed} removed`;
            const res = await Actor.call('apify/send-mail', { to: input.emailTo.trim(), subject, text }, { memory: 256 });
            if (res?.status && res.status !== 'SUCCEEDED') throw new Error(`apify/send-mail finished with status ${res.status}`);
        });
    }
    return results;
}
