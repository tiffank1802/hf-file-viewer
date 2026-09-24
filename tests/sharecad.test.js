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

test('les trois formes /api/file servent le fichier (query, suffixe décoratif, chemin complet)', async () => {
  const cache = createCache();
  const restore = useMocks(hfFetch, cache);
  try {
    const cases = [
      // Forme historique à paramètres.
      { url: 'https://docs.example/api/file?path=GM%2Fpiece.stp', filename: 'piece.stp' },
      // Suffixe décoratif : `path` reste la source de vérité.
      { url: 'https://docs.example/api/file/piece.stp?path=GM%2Fpiece.stp', filename: 'piece.stp' },
      // Chemin complet dans le path, sans query string (URL ShareCAD).
      { url: 'https://docs.example/api/file/GM/autre.stp', filename: 'autre.stp' },
    ];
    for (const { url, filename } of cases) {
      const ctx = createContext();
      const response = await worker.fetch(new Request(url), env, ctx);
      await ctx.done();
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('Content-Disposition') || '',
        new RegExp(filename.replace('.', '\\.')),
      );
    }
  } finally {
    restore();
  }
});

test('un suffixe /api/file invalide ou vide répond 400, pas 500', async () => {
  const cache = createCache();
  const restore = useMocks(hfFetch, cache);
  try {
    for (const url of [
      'https://docs.example/api/file/%zz',
      'https://docs.example/api/file/',
    ]) {
      const ctx = createContext();
      const response = await worker.fetch(new Request(url), env, ctx);
      await ctx.done();
      assert.equal(response.status, 400);
    }
  } finally {
    restore();
  }
});

test('shareCadFrameUrl expose une URL propre se terminant par le vrai nom de fichier', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://docs.example' } };
  try {
    const frame = new URL(shareCadFrameUrl({ path: 'GM/sous dossier/piece.stp' }));
    assert.equal(frame.origin, 'https://iframe.sharecad.org');
    assert.equal(
      frame.searchParams.get('url'),
      'https://docs.example/api/file/GM/sous%20dossier/piece.stp',
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
