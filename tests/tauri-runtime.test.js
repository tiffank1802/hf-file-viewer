import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker/index.js';
import { fileProxyUrl, mediaFileUrl, shareCadFrameUrl } from '../src/services/api.js';
import {
  DEFAULT_PUBLIC_API_ORIGIN,
  apiCredentials,
  apiUrl,
  isAndroidRuntime,
  isTauriRuntime,
  publicApiOrigin,
  publicApiUrl,
  tauriSchemeOrigin,
} from '../src/utils/runtime.js';

const workerEnv = {
  HF_BUCKET_ID: 'ktongue/ENISE-SITE',
  ASSETS: { fetch: () => new Response('asset') },
};

test('sur le Web standard, apiUrl et publicApiUrl conservent les routes relatives', () => {
  const webWin = { location: { origin: 'https://enise-docs.workers.dev', protocol: 'https:' } };
  assert.equal(isTauriRuntime(webWin), false);
  assert.equal(apiUrl('/api/tree?prefix=GM', { win: webWin, env: {} }), '/api/tree?prefix=GM');
  assert.equal(publicApiUrl('/api/file?path=GM%2Fcours.pdf', { win: webWin, env: {}, relativeOnWeb: true }), '/api/file?path=GM%2Fcours.pdf');
  assert.equal(publicApiUrl('/api/file/GM/piece.stp', { win: webWin, env: {} }), 'https://enise-docs.workers.dev/api/file/GM/piece.stp');
  assert.equal(apiCredentials({ win: webWin, env: {} }), 'same-origin');
});

test('sous Tauri macOS / iOS, apiUrl passe par eniseapi://localhost sans encoder la query string', () => {
  const appleTauriWin = {
    isTauri: true,
    location: { origin: 'tauri://localhost', protocol: 'tauri:' },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
    __TAURI_INTERNALS__: {
      convertFileSrc: (filePath, protocol) => `${protocol}://localhost/${encodeURIComponent(filePath)}`,
    },
  };
  assert.equal(isTauriRuntime(appleTauriWin), true);
  assert.equal(tauriSchemeOrigin(appleTauriWin), 'eniseapi://localhost');
  assert.equal(
    apiUrl('/api/tree?prefix=GM%2F3A%20GM', { win: appleTauriWin, env: {} }),
    'eniseapi://localhost/api/tree?prefix=GM%2F3A%20GM',
  );
  assert.equal(publicApiOrigin({ win: appleTauriWin, env: {} }), DEFAULT_PUBLIC_API_ORIGIN);
  assert.equal(apiCredentials({ win: appleTauriWin, env: {} }), 'omit');
});

test('sous Tauri Windows / Android, apiUrl passe par http://eniseapi.localhost et détecte Android', () => {
  const androidTauriWin = {
    isTauri: true,
    location: { origin: 'http://tauri.localhost', protocol: 'http:' },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36' },
    __TAURI_INTERNALS__: {
      convertFileSrc: (filePath, protocol) => `http://${protocol}.localhost/${encodeURIComponent(filePath)}`,
    },
  };
  assert.equal(isAndroidRuntime(androidTauriWin.navigator), true);
  assert.equal(
    apiUrl('/api/reader/document?path=GM%2Fcours.pdf', { win: androidTauriWin, env: {} }),
    'http://eniseapi.localhost/api/reader/document?path=GM%2Fcours.pdf',
  );
  assert.equal(
    publicApiUrl('/api/file?path=GM%2Fvideo.mp4', { win: androidTauriWin, env: { VITE_API_ORIGIN: 'https://docs.enise.example/' }, relativeOnWeb: true }),
    'https://docs.enise.example/api/file?path=GM%2Fvideo.mp4',
  );
});

test('sous Tauri, ShareCAD, téléchargements et médias pointent vers une URL HTTPS publique', () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    isTauri: true,
    location: { origin: 'tauri://localhost', protocol: 'tauri:' },
    __TAURI_INTERNALS__: {
      convertFileSrc: (_filePath, protocol) => `${protocol}://localhost/`,
    },
  };
  try {
    assert.equal(fileProxyUrl('GM/cours.pdf', false), 'eniseapi://localhost/api/file?path=GM%2Fcours.pdf');
    assert.equal(fileProxyUrl('GM/cours.pdf', true), `${DEFAULT_PUBLIC_API_ORIGIN}/api/file?path=GM%2Fcours.pdf&download=1`);
    assert.equal(mediaFileUrl('TOEIC/audio.mp3'), `${DEFAULT_PUBLIC_API_ORIGIN}/api/file?path=TOEIC%2Faudio.mp3`);
    const shareCad = new URL(shareCadFrameUrl({ path: 'GM/piece.stp' }));
    assert.equal(shareCad.searchParams.get('url'), `${DEFAULT_PUBLIC_API_ORIGIN}/api/file/GM/piece.stp`);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('le Worker autorise les origines WebView Tauri en CORS et ignore les origines tierces non déclarées', async () => {
  const preflight = await worker.fetch(
    new Request('https://docs.example/api/tree', {
      method: 'OPTIONS',
      headers: { Origin: 'tauri://localhost' },
    }),
    workerEnv,
    { waitUntil() {} },
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'tauri://localhost');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');

  const androidHealth = await worker.fetch(
    new Request('https://docs.example/api/health', {
      headers: { Origin: 'http://tauri.localhost' },
    }),
    workerEnv,
    { waitUntil() {} },
  );
  assert.equal(androidHealth.status, 200);
  assert.equal(androidHealth.headers.get('Access-Control-Allow-Origin'), 'http://tauri.localhost');

  const untrusted = await worker.fetch(
    new Request('https://docs.example/api/health', {
      headers: { Origin: 'https://untrusted.example' },
    }),
    workerEnv,
    { waitUntil() {} },
  );
  assert.equal(untrusted.headers.get('Access-Control-Allow-Origin'), null);
});
