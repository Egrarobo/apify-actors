// Google News article links (news.google.com/rss/articles/<id>) → the publisher's real URL.
// Old ids carry the URL inside (base64 protobuf): decoded offline, no request.
// New ids ("AU_yqL..."): one GET of the article page for its signature and timestamp, then one batched
// POST to Google's batchexecute endpoint (rpc "Fbv4je") for up to `batchSize` articles at once.

/** Offline decode of old-style ids. Returns the URL or null when the id needs the online decoder. */
export function decodeOffline(articleId) {
    if (!articleId) return null;
    let buf;
    try {
        buf = Buffer.from(articleId.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    } catch {
        return null;
    }
    // Layout: 0x08 0x13 0x22 <varint length> <bytes> ...
    let i = buf.indexOf(0x22);
    if (i < 0 || i > 4) return null;
    i++;
    let len = 0;
    let shift = 0;
    while (i < buf.length) {
        const b = buf[i++];
        len |= (b & 0x7f) << shift;
        if (!(b & 0x80)) break;
        shift += 7;
    }
    const s = buf.subarray(i, i + len).toString('latin1');
    return /^https?:\/\//.test(s) ? s : null;
}

/** Signature and timestamp from the article page (attributes data-n-a-sg / data-n-a-ts). */
export function parseArticlePage(html) {
    const sg = String(html).match(/data-n-a-sg="([^"]+)"/);
    const ts = String(html).match(/data-n-a-ts="([^"]+)"/);
    return sg && ts ? { signature: sg[1], timestamp: Number(ts[1]) } : null;
}

/** Form body for one batchexecute call that decodes several articles; index i+1 maps answers back. */
export function batchBody(entries) {
    const calls = entries.map(({ articleId, timestamp, signature }, i) => {
        const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], articleId, timestamp, signature]);
        return ['Fbv4je', inner, null, String(i + 1)];
    });
    return `f.req=${encodeURIComponent(JSON.stringify([calls]))}`;
}

/** Parses the batchexecute answer → Map(index → url). Answers come back in any order. */
export function parseBatchResponse(text) {
    const out = new Map();
    const body = String(text).replace(/^\)\]\}'\s*/, '');
    const candidates = [];
    try {
        candidates.push(JSON.parse(body));
    } catch {
        // Chunked form: length lines between JSON arrays.
        for (const line of body.split('\n')) {
            if (line.trim().startsWith('[')) {
                try { candidates.push(JSON.parse(line)); } catch { /* ignore */ }
            }
        }
    }
    for (const arr of candidates) {
        if (!Array.isArray(arr)) continue;
        for (const e of arr) {
            if (!Array.isArray(e) || e[0] !== 'wrb.fr' || e[1] !== 'Fbv4je' || typeof e[2] !== 'string') continue;
            let payload;
            try { payload = JSON.parse(e[2]); } catch { continue; }
            if (payload?.[0] === 'garturlres' && typeof payload[1] === 'string' && /^https?:\/\//.test(payload[1])) {
                out.set(String(e[6] ?? 'generic'), payload[1]);
            }
        }
    }
    return out;
}
