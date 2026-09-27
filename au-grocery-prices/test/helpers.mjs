import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;

export const newStorageDir = () => mkdtempSync(path.join(tmpdir(), 'au-grocery-test-'));

/** Runs the Actor locally with the given input and returns its dataset, OUTPUT record and log. */
export async function runActor(input, { storageDir = newStorageDir(), env = {} } = {}) {
    const kvDir = path.join(storageDir, 'key_value_stores', 'default');
    mkdirSync(kvDir, { recursive: true });
    writeFileSync(path.join(kvDir, 'INPUT.json'), JSON.stringify(input));
    const child = spawn(process.execPath, ['src/main.js'], {
        cwd: root,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            APIFY_LOCAL_STORAGE_DIR: storageDir,
            CRAWLEE_STORAGE_DIR: storageDir,
            AU_GROCERY_BACKOFF_MS: '20',
            APIFY_LOG_LEVEL: 'INFO',
            ...env,
        },
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const code = await new Promise((r) => child.on('close', r));
    const dsDir = path.join(storageDir, 'datasets', 'default');
    const items = existsSync(dsDir)
        ? readdirSync(dsDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(path.join(dsDir, f), 'utf8')))
        : [];
    const outFile = path.join(kvDir, 'OUTPUT.json');
    const output = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : null;
    return { code, log, items, output, storageDir };
}
