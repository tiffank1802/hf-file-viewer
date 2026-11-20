import test from 'node:test';
import assert from 'node:assert/strict';
import { createFolderReader } from '../src/services/folderReader.js';

function makeReader(options = {}) {
  const calls = [];
  const reader = createFolderReader({
    ...options,
    fallback: (path) => [`offline:${path}`],
    fetchFolder: (path, signal) => new Promise((resolve, reject) => {
      calls.push({ path, signal, resolve, reject });
    }),
  });
  return { calls, reader };
}

test('plusieurs vues d’un même dossier partagent le chargement et le cache, y compris un dossier vide', async () => {
  const { calls, reader } = makeReader();
  const active = reader.acquire('Dossier vide');
  const column = reader.acquire('Dossier vide');
  await Promise.resolve();
  assert.equal(calls.length, 1);
  active.release();
  await Promise.resolve();
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve({ items: [] });
  const data = await column.result;
  column.release();
  assert.deepEqual(data.items, []);
  assert.equal(data.error, null);
  assert.equal(await reader.acquire('Dossier vide').result, data);
  assert.equal(calls.length, 1);
});

test('une réponse arrivée après abandon ne remplace jamais le résultat d’une nouvelle requête', async () => {
  const { calls, reader } = makeReader();
  const old = reader.acquire('A');
  await Promise.resolve();
  const aborted = assert.rejects(old.result, { name: 'AbortError' });
  old.release();
  await Promise.resolve();
  assert.equal(calls[0].signal.aborted, true);
  const fresh = reader.acquire('A');
  await Promise.resolve();
  calls[1].resolve({ items: ['nouveau'] });
  assert.deepEqual((await fresh.result).items, ['nouveau']);
  calls[0].resolve({ items: ['ancien'] });
  await aborted;
  assert.deepEqual((await reader.acquire('A').result).items, ['nouveau']);
});

test('un échec utilise le repli local sans mettre cet échec en cache', async () => {
  const { calls, reader } = makeReader();
  const first = reader.acquire('A');
  await Promise.resolve();
  calls[0].reject(new Error('Réseau indisponible'));
  const offline = await first.result;
  assert.deepEqual(offline.items, ['offline:A']);
  assert.equal(offline.source, 'fallback');
  const retry = reader.acquire('A');
  await Promise.resolve();
  calls[1].resolve({ items: ['A/vrai'] });
  assert.deepEqual((await retry.result).items, ['A/vrai']);
});

test('le cache LRU est borné et un rafraîchissement peut le contourner', async () => {
  const { calls, reader } = makeReader({ limit: 1 });
  const load = async (path, options) => {
    const one = reader.acquire(path, options);
    await Promise.resolve();
    calls.at(-1).resolve({ items: [calls.length] });
    return (await one.result).items;
  };
  assert.deepEqual(await load('A'), [1]);
  assert.deepEqual(await load('A', { refresh: true }), [2]);
  assert.deepEqual(await load('B'), [3]);
  assert.deepEqual(await load('A'), [4]);
});
