import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { APPWRITE_API_BASE, APPWRITE_ENDPOINT } from '../src/config.js';
import { looksLikeAppwriteResponse, normalizeAppwriteEndpoint } from '../src/utils/appwriteEndpoint.js';

const ROOT = resolve(import.meta.dirname, '..');
const script = readFileSync(resolve(ROOT, 'scripts/appwrite-setup.mjs'), 'utf8');

test('normalizeAppwriteEndpoint ajoute /v1 une fois, jamais deux', () => {
  assert.equal(normalizeAppwriteEndpoint('https://fra.cloud.appwrite.io/v1'), 'https://fra.cloud.appwrite.io/v1');
  assert.equal(normalizeAppwriteEndpoint('https://fra.cloud.appwrite.io'), 'https://fra.cloud.appwrite.io/v1');
  assert.equal(normalizeAppwriteEndpoint('https://fra.cloud.appwrite.io/v1/'), 'https://fra.cloud.appwrite.io/v1');
  assert.equal(normalizeAppwriteEndpoint('  https://example.com/v1///  '), 'https://example.com/v1');
  assert.equal(normalizeAppwriteEndpoint(''), '');
  assert.equal(normalizeAppwriteEndpoint(undefined), '');
  // Idempotent : repasser le résultat ne change rien (c'était le bug du /v1/v1).
  const once = normalizeAppwriteEndpoint(APPWRITE_ENDPOINT);
  assert.equal(normalizeAppwriteEndpoint(once), once);
  assert.equal(APPWRITE_API_BASE, 'https://fra.cloud.appwrite.io/v1');
  assert.equal(APPWRITE_API_BASE.match(/\/v1/g)?.length, 1, 'un seul /v1 dans la base');
});

test('le script de provisioning colle ses chemins derrière la base normalisée', () => {
  assert.match(script, /const url = `\$\{API_BASE\}\$\{path\}`;/);
  assert.doesNotMatch(script, /\$\{ENDPOINT\}\/v1/, 'aucun /v1 ne doit être ajouté à la main');
  assert.doesNotMatch(script, /\/v1\$\{path\}/);
  // Les chemins du script sont relatifs à /v1 : ils ne doivent pas le porter.
  assert.doesNotMatch(script, /path: '\/v1\//, "les chemins ne doivent pas commencer par /v1/");
});

test('une réponse HTML avec server=Appwrite inculpe la route, pas le réseau', () => {
  const proxy = looksLikeAppwriteResponse({ server: null, contentType: 'text/html' });
  assert.equal(proxy.fromAppwrite, false);
  assert.equal(proxy.json, false);
  const appwritePage = looksLikeAppwriteResponse({ server: 'Appwrite', contentType: 'text/html; charset=UTF-8' });
  assert.equal(appwritePage.fromAppwrite, true, 'Appwrite a bien répondu');
  assert.equal(appwritePage.json, false, 'mais ce n’est pas l’API : route inconnue');
  const apiError = looksLikeAppwriteResponse({ server: 'Appwrite', contentType: 'application/json' });
  assert.equal(apiError.json, true);
});
