import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { normalizeApsManifestStatus } from '../worker/index.js';

function createCache() {
  const entries = new Map();
  const key = (request) => (request instanceof Request ? request.url : String(request));
  return {
    async match(request) {
      const response = entries.get(key(request));
      return response?.clone();
    },
    async put(request, response) {
      entries.set(key(request), response.clone());
    },
  };
}

function createContext() {
  const promises = [];
  return {
    waitUntil(promise) {
      promises.push(promise);
    },
    async done() {
      await Promise.all(promises);
    },
  };
}

const env = {
  HF_BUCKET_ID: 'ktongue/ENISE-SITE',
  APS_CLIENT_ID: 'id-test',
  APS_CLIENT_SECRET: 'secret-test',
  APS_CACHE_TTL: '86400',
  MAX_APS_UPLOAD_BYTES: '104857600',
  ASSETS: { fetch: () => new Response('asset') },
};

const VIEW_URL = 'https://docs.example/api/aps/view?path=GM%2Fpiece.stl&size=123&mtime=2026-01-01';
const STATUS_URL = 'https://docs.example/api/aps/status?path=GM%2Fpiece.stl&size=123&mtime=2026-01-01';

/** Mock fetch routé : token, bucket, HF, upload signé, job, manifeste. */
function createApsFetch({ manifest = 'success' } = {}) {
  const calls = { tokenScopes: [], job: 0, manifest: 0 };
  const handler = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = String(init.method || 'GET').toUpperCase();
    if (url.includes('/authentication/v2/token')) {
      calls.tokenScopes.push(new URLSearchParams(init.body).get('scope'));
      return Response.json({ access_token: 'aps-test-token', expires_in: 3600 });
    }
    if (url.includes('/oss/v2/buckets/') && url.endsWith('/details')) {
      return Response.json({});
    }
    if (url.includes('signeds3upload') && method === 'GET') {
      return Response.json({ urls: ['https://upload.example/put'], uploadKey: 'key-1' });
    }
    if (url === 'https://upload.example/put' && method === 'PUT') {
      return new Response('ok');
    }
    if (url.includes('signeds3upload') && method === 'POST') {
      return Response.json({ objectId: 'urn:adsk.objects:os.object:bucket/piece.stl' });
    }
    if (url.includes('/modelderivative/v2/designdata/job') && method === 'POST') {
      calls.job += 1;
      return Response.json({ urn: 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6YnVja2V0L3BpZWNlLnN0bA' });
    }
    if (url.includes('/manifest')) {
      calls.manifest += 1;
      if (manifest === 'missing') return new Response('{}', { status: 404 });
      return Response.json({
        status: manifest,
        progress: manifest === 'success' ? 'complete' : '10%',
      });
    }
    if (url.includes('huggingface.co')) {
      return new Response(new TextEncoder().encode('solid fake').buffer);
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return { handler, calls };
}

function useMocks(fetchHandler, cache) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = fetchHandler;
  globalThis.caches = { default: cache };
  return () => {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  };
}

/** Joue le flux nominal (view → status) jusqu’au succès en cache. */
async function seedSuccessRecord(cache, fetchHandler) {
  const restore = useMocks(fetchHandler, cache);
  try {
    const viewContext = createContext();
    const view = await worker.fetch(new Request(VIEW_URL, { method: 'POST' }), env, viewContext);
    assert.equal(view.status, 200);
    assert.equal((await view.json()).status, 'inprogress');
    await viewContext.done();

    const statusContext = createContext();
    const status = await worker.fetch(new Request(STATUS_URL), env, statusContext);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, 'success');
    await statusContext.done();
  } finally {
    restore();
  }
}

test('les statuts de manifeste Autodesk sont normalisés', () => {
  assert.equal(normalizeApsManifestStatus('success'), 'success');
  assert.equal(normalizeApsManifestStatus('complete'), 'success');
  assert.equal(normalizeApsManifestStatus('failed'), 'failed');
  assert.equal(normalizeApsManifestStatus('timeout'), 'failed');
  assert.equal(normalizeApsManifestStatus('inprogress'), 'inprogress');
  assert.equal(normalizeApsManifestStatus('pending'), 'inprogress');
  assert.equal(normalizeApsManifestStatus(''), 'inprogress');
});

test('le jeton navigateur est à privilèges minimaux, le Worker garde le jeton complet', async () => {
  const { handler, calls } = createApsFetch();
  const restore = useMocks(handler, createCache());
  try {
    const token = await worker.fetch(new Request('https://docs.example/api/aps/token'), env, createContext());
    assert.equal(token.status, 200);
    assert.equal((await token.json()).access_token, 'aps-test-token');
  } finally {
    restore();
  }
  assert.deepEqual(calls.tokenScopes, ['viewables:read']);

  const backend = createApsFetch();
  const restoreBackend = useMocks(backend.handler, createCache());
  try {
    const context = createContext();
    await worker.fetch(new Request(VIEW_URL, { method: 'POST' }), env, context);
    await context.done();
  } finally {
    restoreBackend();
  }
  assert.deepEqual(backend.calls.tokenScopes, ['bucket:create bucket:read data:read data:write viewables:read']);
});

test('un succès en cache est revérifié (pas de nouveau job si le manifeste existe)', async () => {
  const cache = createCache();
  await seedSuccessRecord(cache, createApsFetch({ manifest: 'success' }).handler);

  const second = createApsFetch({ manifest: 'success' });
  const restore = useMocks(second.handler, cache);
  try {
    const context = createContext();
    const view = await worker.fetch(new Request(VIEW_URL, { method: 'POST' }), env, context);
    assert.equal(view.status, 200);
    assert.equal((await view.json()).status, 'success');
    await context.done();
  } finally {
    restore();
  }
  assert.ok(second.calls.manifest >= 1);
  assert.equal(second.calls.job, 0);
});

test('un manifeste disparu (transient expiré) relance la traduction au lieu de resservir l’URN', async () => {
  const cache = createCache();
  await seedSuccessRecord(cache, createApsFetch({ manifest: 'success' }).handler);

  const expired = createApsFetch({ manifest: 'missing' });
  const restore = useMocks(expired.handler, cache);
  try {
    const context = createContext();
    const view = await worker.fetch(new Request(VIEW_URL, { method: 'POST' }), env, context);
    assert.equal(view.status, 200);
    const payload = await view.json();
    assert.equal(payload.status, 'inprogress');
    assert.equal(payload.cacheStatus, 'new');
    await context.done();
  } finally {
    restore();
  }
  assert.equal(expired.calls.job, 1);
});

test('/api/aps/status signale expired quand le manifeste du succès a disparu', async () => {
  const cache = createCache();
  await seedSuccessRecord(cache, createApsFetch({ manifest: 'success' }).handler);

  const expired = createApsFetch({ manifest: 'missing' });
  const restore = useMocks(expired.handler, cache);
  try {
    const context = createContext();
    const status = await worker.fetch(new Request(STATUS_URL), env, context);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).status, 'expired');
    await context.done();
  } finally {
    restore();
  }
});
