import test from 'node:test';
import assert from 'node:assert/strict';
import { modelViewerKind } from '../src/utils/files.js';
import worker, {
  getModel3dConvertUrl,
  hasGlbMagic,
  isModel3dQuality,
  isModelGlbExtension,
  makeModel3dSourceKey,
} from '../worker/index.js';

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
  MODEL3D_CONVERT_URL: 'https://convert3d.example',
  MODEL3D_CACHE_TTL: '604800',
  MAX_MODEL3D_BYTES: '26214400',
  ASSETS: { fetch: () => new Response('asset') },
};

test('le rendu GLB est détecté côté front et Worker pour les mêmes extensions', () => {
  const glb = ['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'sldprt'];
  for (const extension of glb) {
    assert.equal(modelViewerKind(extension), 'glb');
    assert.equal(isModelGlbExtension(extension), true);
  }
  const autodeskOnly = ['dwg', 'rvt', 'rfa', 'catpart', 'catproduct', 'ifc', '3dm', 'f3d', 'sldasm', 'pdf', ''];
  for (const extension of autodeskOnly) {
    assert.equal(modelViewerKind(extension), null);
    assert.equal(isModelGlbExtension(extension), false);
  }
  assert.equal(modelViewerKind('STEP'), 'glb');
  assert.equal(isModelGlbExtension('SLDPRT'), true);
});

test('les qualités de tessellation sont validées', () => {
  assert.equal(isModel3dQuality('draft'), true);
  assert.equal(isModel3dQuality('standard'), true);
  assert.equal(isModel3dQuality('fine'), true);
  assert.equal(isModel3dQuality('STANDARD'), true);
  assert.equal(isModel3dQuality('ultra'), false);
  assert.equal(isModel3dQuality(''), false);
  assert.equal(isModel3dQuality(), false);
});

test('l’URL de conversion 3D pointe vers Rupture par défaut', () => {
  assert.equal(getModel3dConvertUrl({}), 'https://ktongue-rupture.hf.space');
  assert.equal(getModel3dConvertUrl({ MODEL3D_CONVERT_URL: 'https://autre.hf.space///' }), 'https://autre.hf.space');
  assert.equal(getModel3dConvertUrl({ MODEL3D_CONVERT_URL: '' }), '');
  assert.equal(getModel3dConvertUrl({ MODEL3D_CONVERT_URL: '  ' }), '');
});

test('les clés de cache 3D sont courtes, stables et sensibles à la qualité', () => {
  const first = makeModel3dSourceKey('GM/piece.step', '1234', '2026-01-01', 'standard');
  assert.equal(first, makeModel3dSourceKey('GM/piece.step', '1234', '2026-01-01', 'standard'));
  assert.equal(first.length, 32);
  assert.notEqual(first, makeModel3dSourceKey('GM/piece.step', '1234', '2026-01-01', 'fine'));
  assert.notEqual(first, makeModel3dSourceKey('GM/autre.step', '1234', '2026-01-01', 'standard'));
});

test('la signature glTF est vérifiée avant mise en cache', () => {
  const encode = (text) => new TextEncoder().encode(text).buffer;
  assert.equal(hasGlbMagic(encode('glTFpayload')), true);
  assert.equal(hasGlbMagic(encode('NOPE')), false);
  assert.equal(hasGlbMagic(encode('gl')), false);
  assert.equal(hasGlbMagic(null), false);
});

test('/api/model3d/status annonce ready ou not-configured', async () => {
  const ready = await worker.fetch(new Request('https://docs.example/api/model3d/status'), env, createContext());
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).status, 'ready');

  const missing = await worker.fetch(
    new Request('https://docs.example/api/model3d/status'),
    { ...env, MODEL3D_CONVERT_URL: '' },
    createContext(),
  );
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).status, 'not-configured');
});

test('/api/model3d/glb convertit, relaie les métadonnées et met en cache', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const meta = Buffer.from(JSON.stringify({ triangles: 12 })).toString('base64url');
  const glb = new TextEncoder().encode('glTFpayload').buffer;
  let convertCalls = 0;
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/convert-3d')) {
      convertCalls += 1;
      return new Response(glb, { headers: { 'X-Model3D-Meta': meta } });
    }
    return new Response(new TextEncoder().encode('solid fake stl').buffer);
  };

  try {
    const target = 'https://docs.example/api/model3d/glb?path=GM%2Fpiece.stl&quality=fine';
    const firstContext = createContext();
    const first = await worker.fetch(new Request(target), env, firstContext);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('Content-Type'), 'model/gltf-binary');
    assert.equal(first.headers.get('X-Model3D-Meta'), meta);
    assert.equal(first.headers.get('X-Cache-Status'), 'MISS');
    assert.ok(first.headers.get('Content-Disposition').includes('piece.glb'));
    assert.equal(convertCalls, 1);
    await firstContext.done();

    const secondContext = createContext();
    const second = await worker.fetch(new Request(target), env, secondContext);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Cache-Status'), 'HIT');
    assert.equal(second.headers.get('X-Model3D-Meta'), meta);
    assert.equal(convertCalls, 1);
    await secondContext.done();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test('/api/model3d/glb refuse les formats et qualités hors contrat', async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: createCache() };
  globalThis.fetch = async () => {
    throw new Error('aucun appel réseau attendu');
  };

  try {
    const dwg = await worker.fetch(
      new Request('https://docs.example/api/model3d/glb?path=plans%2Fplan.dwg'),
      env,
      createContext(),
    );
    assert.equal(dwg.status, 400);

    const quality = await worker.fetch(
      new Request('https://docs.example/api/model3d/glb?path=GM%2Fpiece.stl&quality=ultra'),
      env,
      createContext(),
    );
    assert.equal(quality.status, 400);

    const missing = await worker.fetch(
      new Request('https://docs.example/api/model3d/glb?path=GM%2Fpiece.stl'),
      { ...env, MODEL3D_CONVERT_URL: '' },
      createContext(),
    );
    assert.equal(missing.status, 501);
    assert.equal((await missing.json()).status, 'not-configured');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
