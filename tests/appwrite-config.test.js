import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  APPWRITE_DATABASE_ID,
  APPWRITE_FLAVOR,
  APPWRITE_ENDPOINT,
  APPWRITE_FAVORITES_TABLE_ID,
  APPWRITE_PROFILE_TABLE_ID,
  APPWRITE_PROJECT_ID,
  APPWRITE_PROJECT_NAME,
} from '../src/config.js';

const ROOT = resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8');

test('le projet Django objects est câblé en dur dans src/config.js', () => {
  assert.equal(APPWRITE_ENDPOINT, 'https://fra.cloud.appwrite.io/v1');
  assert.equal(APPWRITE_PROJECT_ID, '69cedb12002acdd498e0');
  assert.equal(APPWRITE_PROJECT_NAME, 'Django objects');
});

test('les identifiants publics restent des littéraux dans le source', () => {
  const config = read('src/config.js');
  assert.match(config, /'https:\/\/fra\.cloud\.appwrite\.io\/v1'/);
  assert.match(config, /'69cedb12002acdd498e0'/);
});

test('les ressources provisionnées portent des ID stables', () => {
  assert.equal(APPWRITE_PROFILE_TABLE_ID, 'profiles');
  assert.equal(APPWRITE_FAVORITES_TABLE_ID, 'favorites');
  // Volontairement vide tant que la base n'existe pas : les appels données
  // sont court-circuités plutôt que de partir en 404.
  assert.equal(APPWRITE_DATABASE_ID, '');
});

test('aucune clé API Appwrite ne transite par le frontend', () => {
  for (const file of ['src/config.js', 'src/services/appwrite.js', 'src/services/appwriteAuth.js']) {
    assert.doesNotMatch(read(file), /setKey\s*\(/, `${file} ne doit pas appeler client.setKey`);
  }
  const tracked = [
    'src/config.js', 'src/services/appwrite.js', 'src/main.jsx',
    '.env.example', 'package.json', 'wrangler.jsonc',
  ];
  for (const file of tracked) {
    const content = read(file);
    if (file === '.env.example' || file === 'src/config.js' || file === 'package.json' || file === 'wrangler.jsonc') {
      assert.doesNotMatch(content, /VITE_APPWRITE_API_KEY/, `${file} expose une clé via VITE_`);
    }
  }
  // La clé serveur n'existe qu'en commentaire, côté .dev.vars.
  assert.match(read('.dev.vars.example'), /# APPWRITE_API_KEY=""/);
});

test('le dialecte des données est choisi par une variable publique, pas par du code', () => {
  // TablesDB est la norme sur Appwrite 2.x ; 'databases' sert de repli sur les
  // instances qui ne servent pas encore /v1/tablesdb.
  assert.equal(APPWRITE_FLAVOR, 'tablesdb');
  assert.match(read('src/config.js'), /VITE_APPWRITE_FLAVOR === 'databases' \? 'databases' : 'tablesdb'/);
});

test('le ping de configuration est appelé une seule fois au démarrage', () => {
  assert.match(read('src/main.jsx'), /ensureAppwritePing\(\)/);
  const service = read('src/services/appwrite.js');
  assert.match(service, /if \(pingPromise\) return pingPromise;/, 'le ping doit être mémoïsé');
  assert.match(service, /\.setEndpoint\(APPWRITE_ENDPOINT\)[\s\S]*\.setProject\(APPWRITE_PROJECT_ID\)/);
});
