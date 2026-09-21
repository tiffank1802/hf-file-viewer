import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { APPWRITE_ENDPOINT } from '../src/config.js';

/**
 * Garde-fou de déploiement.
 *
 * `public/_headers` est appliqué par Cloudflare Workers Assets à toutes les
 * réponses. Si `connect-src` omet l'origine Appwrite utilisée par
 * `src/config.js`, chaque appel de l'SDK (inscription, connexion, favoris,
 * realtime) est bloqué par le navigateur — en production uniquement, puisque
 * `vite dev` ne sert pas `_headers`. Ce test relie les deux fichiers.
 */
const here = dirname(fileURLToPath(import.meta.url));
const headersPath = resolve(here, '../public/_headers');
const directives = readFileSync(headersPath, 'utf8')
  .split('\n')
  .find((line) => line.trim().startsWith('Content-Security-Policy:'))
  .replace(/^\s*Content-Security-Policy:\s*/, '')
  .split(';')
  .map((entry) => entry.trim().split(/\s+/))
  .filter(([name]) => name)
  .reduce((all, [name, ...sources]) => ({ ...all, [name]: sources }), {});

test('_headers déclare une CSP avec une directive connect-src', () => {
  assert.ok(directives, 'directive Content-Security-Policy absente de public/_headers');
  assert.ok(Array.isArray(directives['connect-src']), 'connect-src absente de la CSP');
});

test('connect-src autorise l’origine Appwrite configurée, en https et en wss', () => {
  const { protocol, host } = new URL(APPWRITE_ENDPOINT);
  assert.equal(protocol, 'https:', 'endpoint Appwrite attendu en https');
  const sources = new Set(directives['connect-src']);
  for (const expected of [`${protocol}//${host}`, `wss://${host}`]) {
    assert.ok(sources.has(expected), `connect-src doit contenir « ${expected} » (sinon CSP bloque l'appel en production)`);
  }
});

test('la CSP reste restrictive : pas d’inline ni de wildcard dans les sources', () => {
  assert.ok(!directives['script-src'].includes("'unsafe-inline'"), 'script-src ne doit pas autoriser l’inline');
  assert.ok(!directives['script-src'].includes('appwrite'), 'l’SDK est bundlé : Appwrite ne doit pas être chargé en <script>');
  assert.ok(!directives['connect-src'].some((source) => source === 'https:' || source === '*'),
    'connect-src ne doit pas ouvrir https: en entier');
  assert.ok(directives['object-src'].includes("'none'"), 'object-src doit rester « none »');
  assert.ok(directives['base-uri'].includes("'self'"), 'base-uri doit rester « self »');
});
