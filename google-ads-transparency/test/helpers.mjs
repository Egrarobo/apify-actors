import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
export const newStorageDir = () => mkdtempSync(path.join(tmpdir(), 'gads-test-'));

/** Runs the Actor locally with the given input; returns its dataset, OUTPUT and log. */
export async function runActor(input, { storageDir = newStorageDir(), env = {} } = {}) {
    const kvDir = path.join(storageDir, 'key_value_stores', 'default');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(path.join(kvDir, 'INPUT.json'), JSON.stringify(input));
    const child = spawn(process.execPath, ['src/main.js'], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, APIFY_LOCAL_STORAGE_DIR: storageDir, CRAWLEE_STORAGE_DIR: storageDir, APIFY_LOG_LEVEL: 'INFO', ...env },
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const code = await new Promise((r) => child.on('close', r));
    // eslint-disable-next-line no-control-regex
    log = log.replace(/\x1b\[[0-9;]*m/g, '');
    const dsDir = path.join(storageDir, 'datasets', 'default');
    const items = existsSync(dsDir)
        ? readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(dsDir, f), 'utf8')))
        : [];
    const outFile = path.join(kvDir, 'OUTPUT.json');
    const output = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
    return { code, log, items, output };
}
