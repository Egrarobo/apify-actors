import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error raised while capturing a single URL. `retryable: false` skips the remaining attempts. */
export class CaptureError extends Error {
    constructor(message, { retryable = true, code = 'error' } = {}) {
        super(message);
        this.retryable = retryable;
        this.code = code;
    }
}

/**
 * Turns user input into an absolute http(s) URL.
 * Adds "https://" when the scheme is missing ("example.com/page"). Returns null for anything else.
 */
export function normalizeUrl(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return null;
    if (/^\/\//.test(s)) s = `https:${s}`;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
    let u;
    try {
        u = new URL(s);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return null;
    // A bare word such as "hello" is almost certainly a typo, not a host (except localhost / IPs).
    if (!u.hostname.includes('.') && u.hostname !== 'localhost' && !u.hostname.startsWith('[')) return null;
    return u.href;
}

/** Key-value store key: readable host + path, plus a short hash so different URLs never collide. */
export function recordKey(url, ext) {
    const u = new URL(url);
    const readable = `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`
        .replace(/[^a-zA-Z0-9!_.'()-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 180) || 'page';
    const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
    return `${readable}-${hash}.${ext}`;
}

/** Pixel size of a PNG, JPEG or WebP buffer (null if unknown). */
export function imageSize(buf) {
    if (!buf || buf.length < 30) return null;
    // PNG
    if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        if (chunk === 'VP8L') {
            const b = buf.readUInt32LE(21);
            return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
        }
        if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        return null;
    }
    // JPEG: walk the segments until a start-of-frame marker
    if (buf[0] === 0xff && buf[1] === 0xd8) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xff) {
                i++;
                continue;
            }
            const marker = buf[i + 1];
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
            }
            i += 2 + buf.readUInt16BE(i + 2);
        }
    }
    return null;
}

/** Converts low-level browser errors into messages a non-developer understands. */
export function friendlyError(err, { timeoutSecs } = {}) {
    const msg = String(err?.message ?? err ?? 'Unknown error');
    const table = [
        [/ERR_NAME_NOT_RESOLVED/, 'Domain not found (DNS lookup failed). Check the address for typos.', false],
        [/ERR_CONNECTION_REFUSED/, 'The server refused the connection.', true],
        [/ERR_CONNECTION_(RESET|CLOSED)|ERR_EMPTY_RESPONSE/, 'The server closed the connection without sending a page.', true],
        [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/, 'The server did not respond (connection timed out).', true],
        [/ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, 'The server could not be reached.', true],
        [/ERR_TOO_MANY_REDIRECTS/, 'The page redirects in a loop (too many redirects).', false],
        [/ERR_CERT_|ERR_SSL_/, 'The site\'s SSL/TLS setup is broken, so the page could not be loaded.', false],
        [/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_/, 'The proxy could not connect to this site.', true],
        [/ERR_BLOCKED_BY_CLIENT/, 'The page address itself is on the ad/tracker block list. Turn off "Block ads and trackers" for this URL.', false],
        [/ERR_INVALID_URL|Cannot navigate to invalid URL/, 'Invalid URL.', false],
        [/Timeout \d+ms exceeded|TimeoutError/, `The page did not load within ${timeoutSecs ?? '?'} s. Increase "Page timeout" or try a proxy.`, true],
        [/Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected/i, 'The browser tab crashed or was closed (the page may be too heavy).', true],
    ];
    for (const [rx, text, retryable] of table) if (rx.test(msg)) return { message: text, retryable };
    return { message: msg.split('\n')[0].slice(0, 300), retryable: true };
}

/** Reads a dotted path such as "result.url" from an object. */
export function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
