// Shared Markdown helpers: tables, block splitting, Markdown -> plain text, token counting.
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

const enc = new Tiktoken(cl100k);

/** Token count with the cl100k_base tokenizer (OpenAI text-embedding-3 / GPT-4 family). */
export const countTokens = (s) => (s ? enc.encode(s, [], []).length : 0);

export const escapeCell = (v) => String(v ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();

/** Rows (array of arrays) -> GitHub-flavoured Markdown table. First row is the header. */
export function mdTable(rows) {
    const clean = rows.filter((r) => r && r.some((c) => String(c ?? '').trim() !== ''));
    if (!clean.length) return '';
    const width = Math.max(...clean.map((r) => r.length));
    const norm = clean.map((r) => Array.from({ length: width }, (_, i) => escapeCell(r[i])));
    const [head, ...body] = norm;
    const line = (r) => `| ${r.join(' | ')} |`;
    return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');
}

/** Normalise whitespace and blank lines of a Markdown document. */
export function tidyMarkdown(md) {
    return String(md ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/ /g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Split Markdown into blocks separated by blank lines (code fences kept intact).
 * Each block: { md, heading: level|0, headingText }
 */
export function mdToBlocks(md) {
    const lines = tidyMarkdown(md).split('\n');
    const blocks = [];
    let cur = [];
    let inFence = false;
    const flush = () => {
        if (!cur.length) return;
        const text = cur.join('\n');
        if (text.trim()) blocks.push(text);
        cur = [];
    };
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
        if (!inFence && /^#{1,6}\s/.test(line)) { flush(); cur.push(line); flush(); continue; }
        if (!inFence && line.trim() === '') { flush(); continue; }
        cur.push(line);
    }
    flush();
    return blocks.map((b) => {
        const m = b.match(/^(#{1,6})\s+(.*)$/);
        return m && !b.includes('\n')
            ? { md: b, heading: m[1].length, headingText: m[2].replace(/[*_`]/g, '').trim() }
            : { md: b, heading: 0, isTable: /^\s*\|.*\|\s*\n\s*\|[\s:|-]+\|/.test(b) };
    });
}

/** Markdown -> readable plain text (keeps table rows as "a | b", list markers as "- "). */
export function mdToText(md) {
    return tidyMarkdown(String(md ?? '')
        .replace(/<!--\s*page:\s*(\d+)\s*-->/g, '[Page $1]')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^```.*$/gm, '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)/g, '$1')
        .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$\n?/gm, '')
        .replace(/^[ \t]*\|[ \t]?(.*?)[ \t]?\|[ \t]*$/gm, '$1')
        .replace(/\\\|/g, '|')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^([ \t]*)[*+][ \t]+/gm, '$1- ')
        .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1'));
}
