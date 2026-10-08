// Field names for files in a key-value store: the new names and the old ones (kept for existing users).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSources } from '../src/sources.js';

test('kvStoreFileNames + kvStoreId (new names)', async () => {
    const s = await collectSources({ kvStoreFileNames: ['deck.pptx'], kvStoreId: 'my-uploads' });
    assert.deepEqual(s, [{ storeId: 'my-uploads', key: 'deck.pptx' }]);
});

test('keyValueStoreKeys + keyValueStoreId (old names) still work', async () => {
    const s = await collectSources({ keyValueStoreKeys: ['uploads/my-deck', 'report.pdf'] });
    assert.deepEqual(s, [{ storeId: 'uploads', key: 'my-deck' }, { storeId: null, key: 'report.pdf' }]);
    const t = await collectSources({ keyValueStoreKeys: ['deck.pptx'], keyValueStoreId: 'old-store' });
    assert.deepEqual(t, [{ storeId: 'old-store', key: 'deck.pptx' }]);
});

test('new names win when both are given', async () => {
    const s = await collectSources({ kvStoreFileNames: ['a.pdf'], keyValueStoreKeys: ['b.pdf'], kvStoreId: 'new', keyValueStoreId: 'old' });
    assert.deepEqual(s, [{ storeId: 'new', key: 'a.pdf' }]);
});
