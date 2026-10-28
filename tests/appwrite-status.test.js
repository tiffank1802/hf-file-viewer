import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TABLES } from '../scripts/appwrite-spec.js';

const script = fileURLToPath(new URL('../scripts/appwrite-setup.mjs', import.meta.url));

async function runAgainst(handler, args = ['--status', '--flavor=tablesdb'], key = '') {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    const result = handler(request);
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    const child = spawn(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        APPWRITE_ENDPOINT: `http://127.0.0.1:${address.port}/v1`,
        APPWRITE_PROJECT_ID: 'test_project',
        APPWRITE_DATABASE_ID: 'test_database',
        APPWRITE_API_KEY: key,
        APPWRITE_FLAVOR: 'tablesdb',
        APPWRITE_TIMEOUT_MS: '5000',
        APPWRITE_PROFILE_TABLE_ID: 'profiles',
        APPWRITE_FAVORITES_TABLE_ID: 'favorites',
        APPWRITE_CONVERSATIONS_TABLE_ID: 'conversations',
        APPWRITE_MESSAGES_TABLE_ID: 'messages',
        APPWRITE_ANNOTATIONS_TABLE_ID: 'annotations',
        APPWRITE_PDF_ANNOTATIONS_TABLE_ID: 'pdf_annotations_v2',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close');
    return { code, output: stdout + stderr, requests };
  } finally {
    server.close();
    await once(server, 'close');
  }
}

const errorResponse = (status) => ({
  status,
  body: { message: 'test error', type: 'test_error' },
});

test('status ne présente pas une base 401 comme absente', { timeout: 10000 }, async () => {
  const result = await runAgainst(() => errorResponse(401));
  assert.equal(result.code, 1);
  assert.match(result.output, /base test_database : impossible à vérifier \(401\)/);
  assert.match(result.output, /existence de la ressource est inconnue/);
  assert.doesNotMatch(result.output, /base test_database : absente/);
  assert.deepEqual(result.requests, [{ method: 'GET', url: '/v1/tablesdb/test_database' }]);
});

test('status distingue un refus 403 sur les tables de leur absence', { timeout: 10000 }, async () => {
  const result = await runAgainst((request) => (
    request.url === '/v1/tablesdb/test_database'
      ? { status: 200, body: { name: 'Test' } }
      : errorResponse(403)
  ), undefined, 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /table pdf_annotations_v2 : impossible à vérifier \(403\)/);
  assert.doesNotMatch(result.output, /pdf_annotations_v2 : absente/);
  assert.ok(result.requests.every(({ method }) => method === 'GET'));
});

test('status signale une base introuvable ou une route incorrecte pour 404', { timeout: 10000 }, async () => {
  const result = await runAgainst(() => errorResponse(404), undefined, 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /base test_database : introuvable ou route incorrecte \(404\)/);
});

test('status réussit pour un schéma et des permissions conformes', { timeout: 10000 }, async () => {
  const result = await runAgainst((request) => {
    if (request.url === '/v1/tablesdb/test_database') return { status: 200, body: { name: 'Test' } };
    const table = TABLES.find((entry) => request.url === `/v1/tablesdb/test_database/tables/${entry.id}`);
    if (!table) return errorResponse(404);
    return {
      status: 200,
      body: {
        columns: table.columns,
        indexes: table.indexes,
        rowSecurity: table.rowSecurity,
        $permissions: table.permissions,
      },
    };
  }, undefined, 'fake-test-key');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /pdf_annotations_v2 : 12\/12 colonnes, 3\/3 index/);
});

test('status retourne une erreur si les permissions diffèrent du modèle', { timeout: 10000 }, async () => {
  const result = await runAgainst((request) => {
    if (request.url === '/v1/tablesdb/test_database') return { status: 200, body: { name: 'Test' } };
    const table = TABLES.find((entry) => request.url === `/v1/tablesdb/test_database/tables/${entry.id}`);
    if (!table) return errorResponse(404);
    return {
      status: 200,
      body: {
        columns: table.columns,
        indexes: table.indexes,
        rowSecurity: table.rowSecurity,
        $permissions: table.id === 'pdf_annotations_v2' ? [] : table.permissions,
      },
    };
  }, undefined, 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /aucune permission sur la table/);
  assert.ok(result.requests.every(({ method }) => method === 'GET'));
});

test('setup sans clé conseille de la stocker localement et ne contacte pas le serveur', { timeout: 10000 }, async () => {
  const result = await runAgainst(() => errorResponse(500), ['--flavor=tablesdb']);
  assert.equal(result.code, 1);
  assert.match(result.output, /APPWRITE_API_KEY manquante/);
  assert.match(result.output, /\.dev\.vars/);
  assert.doesNotMatch(result.output, /read -s/);
  assert.deepEqual(result.requests, []);
});
