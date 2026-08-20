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

test('le premier index compte les fichiers et le JSON sert ensuite /api/counts', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let upstreamCalls = 0;
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json([
      { type: 'directory', path: 'GM' },
      { type: 'directory', path: 'GM/3A GM' },
      { type: 'file', path: 'GM/3A GM/poly.pdf', size: 12 },
      { type: 'file', path: 'GM/3A GM/td.pdf', size: 12 },
      { type: 'file', path: 'GM/4A GM/projet.pdf', size: 12 },
      { type: 'file', path: 'TOEIC/audio.mp3', size: 12 },
    ]);
  };

  try {
    const indexContext = createContext();
    const index = await worker.fetch(new Request('https://docs.example/api/index'), env, indexContext);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('X-Cache-Status'), 'MISS');
    assert.equal(index.headers.get('X-Data-Source'), 'index-json');

    const indexPayload = await index.json();
    assert.equal(indexPayload.totalFiles, 4);
    assert.equal(indexPayload.counts.GM, 3);
    assert.equal(indexPayload.counts['GM/3A GM'], 2);
    assert.equal(indexPayload.counts.TOEIC, 1);
    await indexContext.done();

    const countsContext = createContext();
    const counts = await worker.fetch(new Request('https://docs.example/api/counts'), env, countsContext);
    assert.equal(counts.status, 200);
    assert.equal(counts.headers.get('X-Cache-Status'), 'HIT');
    assert.equal(counts.headers.get('X-Data-Source'), 'index-json');

    const countsPayload = await counts.json();
    assert.equal(countsPayload.source, 'index-json');
    assert.equal(countsPayload.totalFiles, 4);
    assert.equal(countsPayload.counts['GM/3A GM'], 2);

    const scopedContext = createContext();
    const scoped = await worker.fetch(
      new Request('https://docs.example/api/counts?prefix=GM'),
      env,
      scopedContext,
    );
    const scopedPayload = await scoped.json();
    assert.equal(scopedPayload.prefix, 'GM');
    assert.equal(scopedPayload.totalFiles, 3);
    assert.equal(scopedPayload.counts['GM/3A GM'], 2);
    assert.equal(scopedPayload.counts.TOEIC, undefined);

    // Un seul parcours Hugging Face pour l’index, aucun recompte live ensuite.
    assert.equal(upstreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('/api/counts réutilise le document d’index stocké dans Workers KV', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const document = JSON.stringify({
    bucketId: 'ktongue/ENISE-SITE',
    items: [{ type: 'directory', path: 'GM' }],
    counts: { GM: 42, 'GM/3A GM': 12 },
    totalFiles: 42,
    complete: true,
    fetchedAt: '2026-08-20T10:00:00Z',
  });
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async () => {
    throw new Error('Hugging Face ne doit pas être relu pour un comptage');
  };

  try {
    const context = createContext();
    const response = await worker.fetch(
      new Request('https://docs.example/api/counts?prefix=GM'),
      { ...env, METADATA_KV: { get: async () => document, put: async () => {} } },
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Cache-Status'), 'KV-HIT');
    assert.equal(response.headers.get('X-Data-Source'), 'index-json');
    const payload = await response.json();
    assert.equal(payload.totalFiles, 42);
    assert.equal(payload.counts['GM/3A GM'], 12);
    await context.done();
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
