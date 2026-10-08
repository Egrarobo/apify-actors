// Optional: open the publisher's page once and read its <head> metadata (description, image, author, canonical URL).
// Only the metadata the publisher publishes for link previews; the article body is not stored.
import { decodeEntities } from './feeds.js';

function meta(head, keys) {
    for (const key of keys) {
        const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const a = head.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${k}["'][^>]*>`, 'i'));
        if (a) {
            const c = a[0].match(/content=["']([^"']*)["']/i);
            if (c && c[1].trim()) return decodeEntities(c[1]).replace(/\s+/g, ' ').trim();
        }
    }
    return null;
}

export function parsePublisherHead(html) {
    const s = String(html ?? '');
    const end = s.search(/<\/head>/i);
    const head = end > 0 ? s.slice(0, end) : s.slice(0, 200000);
    const canonical = head.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1] ?? null;
    return {
        snippet: meta(head, ['og:description', 'description', 'twitter:description']),
        imageUrl: meta(head, ['og:image', 'og:image:url', 'twitter:image']),
        author: [meta(head, ['author', 'parsely-author', 'sailthru.author']), meta(head, ['article:author'])].find((a) => a && !/^https?:\/\//i.test(a)) ?? null,
        canonicalUrl: canonical ? decodeEntities(canonical) : null,
        language: head.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] ?? null,
    };
}
