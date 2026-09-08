import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { shareCadFrameUrl } from '../src/services/api.js';

const env = {
  HF_BUCKET_ID: 'ktongue/ENISE-SITE',
  ASSETS: { fetch: () => new Response('asset') },
};

function createCache() {
  const entries = new Map();
  const key = (request) => (request instanceof Request ? request.url : String(request));
  return {
    async match(request) {
      return entries.get(key(request))?.clone();
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

const hfFetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('huggingface.co')) {
    return new Response('fake-cad-bytes');
  }
  throw new Error(`unexpected fetch ${url}`);
};

test('la route /api/file/<nom> sert le fichier comme /api/file (extension visible pour ShareCAD)', async () => {
  const cache = createCache();
  const restore = useMocks(hfFetch, cache);
  try {
    for (const pathname of ['/api/file', '/api/file/piece.stp']) {
      const ctx = createContext();
      const response = await worker.fetch(
        new Request(`https://docs.example${pathname}?path=GM%2Fpiece.stp`),
        env,
        ctx,
      );
      await ctx.done();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Disposition') || '', /piece\.stp/);
    }
  } finally {
    restore();
  }
});

test('shareCadFrameUrl expose le nom du fichier avec extension dans l’URL', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://docs.example' } };
  try {
    const frame = new URL(shareCadFrameUrl({ path: 'GM/piece.stp' }));
    assert.equal(frame.origin, 'https://iframe.sharecad.org');
    assert.equal(
      frame.searchParams.get('url'),
      'https://docs.example/api/file/piece.stp?path=GM%2Fpiece.stp',
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
