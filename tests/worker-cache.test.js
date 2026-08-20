import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

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
    waitUntil(promise) { promises.push(promise); },
    async done() { await Promise.all(promises); },
  };
}

const env = {
  HF_BUCKET_ID: 'ktongue/ENISE-SITE',
  TREE_CACHE_TTL: '21600',
  INDEX_CACHE_TTL: '43200',
  FILE_CACHE_TTL: '604800',
  MAX_CACHEABLE_FILE_BYTES: '26214400',
  ASSETS: { fetch: () => new Response('asset') },
};

test('le second appel tree est servi par le Cache API', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let upstreamCalls = 0;
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json([
      { type: 'directory', path: 'GM', uploadedAt: '2026-08-20T10:00:00Z' },
      { type: 'directory', path: 'TOEIC', uploadedAt: '2026-08-20T10:00:00Z' },
    ]);
  };

  try {
    const firstContext = createContext();
    const first = await worker.fetch(new Request('https://docs.example/api/tree'), env, firstContext);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache-Status'), 'MISS');
    assert.equal((await first.json()).items.length, 2);
    await firstContext.done();

    const secondContext = createContext();
    const second = await worker.fetch(new Request('https://docs.example/api/tree'), env, secondContext);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Cache-Status'), 'HIT');
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('Workers KV sert de cache global optionnel après un MISS Edge', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const payload = JSON.stringify({
    bucketId: 'ktongue/ENISE-SITE',
    prefix: '',
    items: [{ type: 'directory', path: 'GM' }],
    complete: true,
    fetchedAt: '2026-08-20T10:00:00Z',
  });
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async () => {
    throw new Error('Hugging Face ne doit pas être appelé sur un KV-HIT');
  };

  try {
    const context = createContext();
    const response = await worker.fetch(
      new Request('https://docs.example/api/tree'),
      { ...env, METADATA_KV: { get: async () => payload, put: async () => {} } },
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Cache-Status'), 'KV-HIT');
    assert.equal((await response.json()).items[0].path, 'GM');
    await context.done();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('GET /api/counts relit Hugging Face sans Cache API ni KV', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let cacheOps = 0;
  let kvOps = 0;
  let upstreamCalls = 0;
  let liveInit;
  globalThis.caches = {
    default: {
      async match() { cacheOps += 1; return undefined; },
      async put() { cacheOps += 1; },
    },
  };
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    liveInit = options;
    return Response.json([
      { type: 'file', path: 'GM/3A GM/poly.pdf' },
      { type: 'file', path: 'GM/4A GM/td.pdf' },
      { type: 'directory', path: 'GM' },
    ]);
  };

  try {
    const context = createContext();
    const envWithKv = {
      ...env,
      METADATA_KV: {
        get: async () => { kvOps += 1; return '{"should":"not"}'; },
        put: async () => { kvOps += 1; },
      },
    };
    const first = await worker.fetch(new Request('https://docs.example/api/counts'), envWithKv, context);
    const second = await worker.fetch(new Request('https://docs.example/api/counts?prefix=GM'), envWithKv, context);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('X-Cache-Status'), 'BYPASS-LIVE');
    assert.equal(first.headers.get('X-Data-Source'), 'huggingface-live');
    assert.equal(first.headers.get('Cache-Control'), 'no-store, max-age=0');
    assert.equal((await first.json()).counts.GM, 2);
    assert.equal(second.status, 200);
    assert.equal(upstreamCalls, 2);
    assert.equal(cacheOps, 0);
    assert.equal(kvOps, 0);
    assert.equal(liveInit.cache, 'no-store');
    assert.equal(liveInit.headers.get('Cache-Control'), 'no-cache, no-store, max-age=0');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('une requête Range est transmise et n’est pas mise en cache', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let receivedRange;
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async (_url, options) => {
    receivedRange = options.headers.get('Range');
    return new Response('data', {
      status: 206,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': '4',
        'Content-Range': 'bytes 0-3/100',
      },
    });
  };

  try {
    const context = createContext();
    const response = await worker.fetch(
      new Request('https://docs.example/api/file?path=GM%2Fpoly.pdf', {
        headers: { Range: 'bytes=0-3' },
      }),
      env,
      context,
    );
    assert.equal(response.status, 206);
    assert.equal(receivedRange, 'bytes=0-3');
    assert.equal(response.headers.get('X-Cache-Status'), 'BYPASS-RANGE');
    assert.equal(response.headers.get('Content-Disposition'), "inline; filename*=UTF-8''poly.pdf");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
