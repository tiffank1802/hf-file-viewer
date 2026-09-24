import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, normalizeOrigin } from '../scripts/set-api-origin.js';

test('l’origine Render est normalisée et le HTTP simple refusé', () => {
  assert.equal(normalizeOrigin('https://enise-docs-api.onrender.com/'), 'https://enise-docs-api.onrender.com');
  assert.equal(normalizeOrigin('  https://api.exemple.fr  '), 'https://api.exemple.fr');
  assert.throws(() => normalizeOrigin(''), /URL manquante/);
  assert.throws(() => normalizeOrigin('http://enise-docs-api.onrender.com'), /HTTPS/);
  assert.throws(() => normalizeOrigin('https://enise-docs-api.onrender.com/api/chat'), /sans chemin/);
  assert.throws(() => normalizeOrigin('pas une url'), /invalide/);
});

test('la vérification attend la sortie de veille avant d’écrire l’origine', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) throw new Error('service endormi');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const health = await checkHealth('https://enise-docs-api.onrender.com', { attempts: 3, delayMs: 1 });
    assert.deepEqual(health, { ok: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'https://enise-docs-api.onrender.com/api/health');
  } finally {
    globalThis.fetch = original;
  }
});

test('une API qui ne répond jamais fait échouer la commande', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('Not Found', { status: 404 });
  try {
    await assert.rejects(
      checkHealth('https://enise-docs-api.onrender.com', { attempts: 2, delayMs: 1 }),
      /ne répond pas.*404/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
