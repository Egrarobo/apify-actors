// HTML -> Markdown with Turndown. Removes page chrome (nav, footer, scripts…), prefers <main>/<article>,
// converts every table (with or without <th>) to a Markdown table.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import domino from '@mixmark-io/domino';
import { mdTable, tidyMarkdown } from '../markdown.js';

const JUNK = 'script, style, noscript, template, iframe, svg, canvas, form, button, nav, footer, header, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"]';

function createTurndown() {
    const td = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined',
    });
    td.use(gfm);
    // Images carry no text for LLMs; keep only meaningful alt text.
    td.addRule('img', {
        filter: 'img',
        replacement: (_, node) => {
            const alt = (node.getAttribute('alt') || '').trim();
            return alt && !/^(image|img|picture|photo)\d*$/i.test(alt) ? `[Image: ${alt}]` : '';
        },
    });
    // Links without a real target collapse to their text.
    td.addRule('plainLinks', {
        filter: (node) => node.nodeName === 'A' && !/^(https?:|mailto:)/i.test(node.getAttribute('href') || ''),
        replacement: (content) => content,
    });
    // Every table becomes a Markdown table; the first row is used as the header.
    td.addRule('anyTable', {
        filter: 'table',
        replacement: (_, node) => {
            const rows = Array.from(node.querySelectorAll('tr'))
                .filter((tr) => tr.closest('table') === node)
                .map((tr) => Array.from(tr.children).filter((c) => /^(TD|TH)$/.test(c.nodeName)).flatMap((cell) => {
                    const text = td.turndown(cell.innerHTML).replace(/\n+/g, ' ').trim();
                    const span = Math.min(Number(cell.getAttribute('colspan')) || 1, 20);
                    return [text, ...Array(span - 1).fill('')];
                }));
            const md = mdTable(rows);
            return md ? `\n\n${md}\n\n` : '';
        },
    });
    return td;
}

/** @returns {{ title: string, markdown: string }} */
export function htmlToMarkdown(html, { fullPage = true } = {}) {
    const doc = domino.createDocument(String(html));
    const title = (doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent || '').trim();
    let root = doc.body || doc.documentElement;
    if (fullPage) {
        Array.from(doc.querySelectorAll(JUNK)).forEach((el) => el.remove());
        const main = doc.querySelector('main, article, [role="main"]');
        if (main && main.textContent.trim().length > 200) root = main;
    } else {
        Array.from(doc.querySelectorAll('script, style')).forEach((el) => el.remove());
    }
    const markdown = tidyMarkdown(createTurndown().turndown(root.innerHTML || '')
        .replace(/^(\s*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 '));
    return { title, markdown };
}

export function convertHtml(buffer) {
    const { title, markdown } = htmlToMarkdown(decodeText(buffer));
    return { title, markdown, warnings: [] };
}

/** Decode text with BOM / charset sniffing (UTF-8 default, windows-1251/1250 fallbacks via <meta charset>). */
export function decodeText(buffer, contentType = '') {
    const buf = Buffer.from(buffer);
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    const head = buf.subarray(0, 2048).toString('latin1');
    const cs = (contentType.match(/charset=([\w-]+)/i) || head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    try {
        const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return utf8.replace(/^﻿/, '');
    } catch {
        try { return new TextDecoder(cs || 'windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
    }
}
