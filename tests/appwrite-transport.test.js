import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cspAllowsOrigin,
  describeTransportVerdict,
  isTransportError,
  parseCsp,
  probeAppwriteTransport,
  setCachedTransportVerdict,
} from '../src/services/appwriteTransport.js';
import { describeAppwriteError } from '../src/services/appwrite.js';

const ENDPOINT = 'https://fra.cloud.appwrite.io/v1';
const PAGE = 'https://enise-docs.demo.workers.dev/';
const here = dirname(fileURLToPath(import.meta.url));
const realCsp = readFileSync(resolve(here, '../public/_headers'), 'utf8')
  .split('\n')
  .find((line) => line.trim().startsWith('Content-Security-Policy:'))
  .trim()
  .replace(/^Content-Security-Policy:\s*/, '');

/** `fetch` simulé : on pilote la CSP de la page et le sort de chaque sonde. */
function fakeFetch({ csp = null, noCorsOk = true, corsOk = true, throwOnPing = false } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, mode: init.mode ?? 'cors', headers: init.headers });
    if (init.method === 'HEAD') return { headers: new Map([['content-security-policy', csp]]) };
    if (throwOnPing) throw new TypeError('Failed to fetch');
    if (init.mode === 'no-cors') return noCorsOk ? {} : (() => { throw new TypeError('Load failed'); })();
    return corsOk ? { ok: true } : (() => { throw new TypeError('Failed to fetch'); })();
  };
  impl.calls = calls;
  return impl;
}

test('parseCsp lit les directives et ignore le reste', () => {
  const directives = parseCsp(realCsp);
  assert.ok(directives['connect-src'].includes('https://fra.cloud.appwrite.io'));
  assert.ok(directives['connect-src'].includes('wss://fra.cloud.appwrite.io'));
  assert.deepEqual(parseCsp(''), {});
  assert.deepEqual(parseCsp(null), {});
});

test('la CSP déployée autorise Appwrite, une CSP « self » seule la bloque', () => {
  assert.equal(cspAllowsOrigin(realCsp, ENDPOINT, PAGE).allowed, true);
  assert.equal(cspAllowsOrigin("default-src 'self'; connect-src 'self';", ENDPOINT, PAGE).allowed, false);
  // default-src sert de repli quand connect-src est absent.
  assert.equal(cspAllowsOrigin("default-src 'self';", ENDPOINT, PAGE).allowed, false);
  // Aucune directive de connexion = aucune restriction.
  assert.equal(cspAllowsOrigin("img-src 'self';", ENDPOINT, PAGE).allowed, true);
  assert.equal(cspAllowsOrigin(null, ENDPOINT, PAGE).allowed, true);
  // Jokers et schémas.
  assert.equal(cspAllowsOrigin('connect-src https://*.cloud.appwrite.io;', ENDPOINT, PAGE).allowed, true);
  assert.equal(cspAllowsOrigin('connect-src https:;', ENDPOINT, PAGE).allowed, true);
  assert.equal(cspAllowsOrigin('connect-src https://elsewhere.example;', ENDPOINT, PAGE).allowed, false);
  assert.equal(cspAllowsOrigin("connect-src 'self';", ENDPOINT, 'https://x.test').allowed, false);
});

test('isTransportError ne capture que les échecs sans réponse HTTP', () => {
  assert.equal(isTransportError(new TypeError('Failed to fetch')), true);
  assert.equal(isTransportError(new Error('Load failed')), true);
  assert.equal(isTransportError(new Error('NetworkError when attempting to retrieve the resource.')), true);
  assert.equal(isTransportError({ message: 'user_missing', code: 401, type: 'user_missing' }), false);
  assert.equal(isTransportError({ response: 'Missing or unknown project', code: 400 }), false);
  // Un « type » générique collé sur une panne de transport ne doit pas masquer
  // le diagnostic : c'est le statut HTTP absent qui fait la décision.
  assert.equal(isTransportError({ message: 'fetch failed', type: 'general_unknown' }), true);
  assert.equal(isTransportError({ message: 'Failed to fetch', status: 0 }), true);
  assert.equal(isTransportError(null), false);
});

test('CSP qui n’autorise pas l’hôte : le verdict nomme connect-src', async () => {
  setCachedTransportVerdict(null);
  const verdict = await probeAppwriteTransport({
    endpoint: ENDPOINT,
    pageUrl: PAGE,
    fetchImpl: fakeFetch({ csp: "default-src 'self'; connect-src 'self';" }),
  });
  assert.equal(verdict.code, 'csp');
  assert.match(describeTransportVerdict(verdict), /connect-src/);
  assert.match(describeTransportVerdict(verdict), /fra\.cloud\.appwrite\.io/);
});

test('CSP correcte mais hôte refusé en CORS : origine non déclarée', async () => {
  setCachedTransportVerdict(null);
  const fetchImpl = fakeFetch({ csp: realCsp, noCorsOk: true, corsOk: false });
  const verdict = await probeAppwriteTransport({ endpoint: ENDPOINT, pageUrl: PAGE, fetchImpl });
  assert.equal(verdict.code, 'origin');
  // La sonde no-cors est passée, la sonde cors a été refusée : c'est le test
  // qui discrimine « réseau coupé » de « CORS/non déclaré ».
  assert.deepEqual(fetchImpl.calls.map((call) => call.mode), ['cors', 'no-cors', 'cors']);
});

test('hôte injoignable même en no-cors : réseau, pas configuration', async () => {
  setCachedTransportVerdict(null);
  const verdict = await probeAppwriteTransport({
    endpoint: ENDPOINT,
    pageUrl: PAGE,
    fetchImpl: fakeFetch({ csp: null, noCorsOk: false }),
  });
  assert.equal(verdict.code, 'unreachable');
  assert.match(describeTransportVerdict(verdict), /4G/);
});

test('hors ligne détecté avant toute sonde réseau', async () => {
  setCachedTransportVerdict(null);
  const fetchImpl = fakeFetch({ csp: null, throwOnPing: true });
  const verdict = await probeAppwriteTransport({ endpoint: ENDPOINT, pageUrl: PAGE, fetchImpl, online: false });
  assert.equal(verdict.code, 'offline');
  assert.equal(fetchImpl.calls.length, 1, 'aucune sonde réseau quand onLine est faux');
});

test('tout répond : le blocage n’est pas transport', async () => {
  setCachedTransportVerdict(null);
  const verdict = await probeAppwriteTransport({ endpoint: ENDPOINT, pageUrl: PAGE, fetchImpl: fakeFetch({ csp: realCsp }) });
  assert.equal(verdict.code, 'ok');
});

test('aucune sonde hors navigateur : le module reste inerte', async () => {
  setCachedTransportVerdict(null);
  assert.equal(await probeAppwriteTransport({ fetchImpl: fakeFetch() }), null);
});

test('un verdict mis en cache enrichit describeAppwriteError', async () => {
  setCachedTransportVerdict(null);
  const before = describeAppwriteError(new TypeError('Failed to fetch'));
  assert.match(before, /Domains & Platforms/);
  assert.match(before, /Refused to connect/);

  await probeAppwriteTransport({
    endpoint: ENDPOINT,
    pageUrl: PAGE,
    fetchImpl: fakeFetch({ csp: "connect-src 'self';" }),
  });
  const after = describeAppwriteError(new TypeError('Failed to fetch'));
  assert.match(after, /connect-src/, 'le message doit citer la directive fautive');
  assert.ok(after !== before);
  setCachedTransportVerdict(null);
});
