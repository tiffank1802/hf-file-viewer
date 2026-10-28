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
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const captured = { method: request.method, url: request.url, ...(raw ? { body: JSON.parse(raw) } : {}) };
    requests.push(captured);
    const result = await handler(captured);
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

const errorResponse = (status, type = 'test_error') => ({
  status,
  body: { message: 'test error', type },
});

const liveTable = (table, overrides = {}) => ({
  columns: table.columns.map((column) => ({ ...column, status: 'available' })),
  indexes: table.indexes.map((index) => ({ ...index, status: 'available' })),
  rowSecurity: table.rowSecurity,
  enabled: true,
  $permissions: table.permissions,
  ...overrides,
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
    return { status: 200, body: liveTable(table) };
  }, undefined, 'fake-test-key');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /pdf_annotations_v2 : 12\/12 colonnes, 3\/3 index/);
});

test('status retourne une erreur si les permissions diffèrent du modèle', { timeout: 10000 }, async () => {
  const result = await runAgainst((request) => {
    if (request.url === '/v1/tablesdb/test_database') return { status: 200, body: { name: 'Test' } };
    const table = TABLES.find((entry) => request.url === `/v1/tablesdb/test_database/tables/${entry.id}`);
    if (!table) return errorResponse(404);
    return { status: 200, body: liveTable(table, { $permissions: table.id === 'pdf_annotations_v2' ? [] : table.permissions }) };
  }, undefined, 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /aucune permission au niveau table/);
  assert.match(result.output, /permissions de ligne peuvent néanmoins autoriser l’accès/);
  assert.ok(result.requests.every(({ method }) => method === 'GET'));
});

test('setup sans clé conseille de la stocker localement et ne contacte pas le serveur', { timeout: 10000 }, async () => {
  const result = await runAgainst(() => errorResponse(500), ['--flavor=tablesdb', '--apply', '--table=pdf_annotations_v2']);
  assert.equal(result.code, 1);
  assert.match(result.output, /APPWRITE_API_KEY manquante/);
  assert.match(result.output, /\.dev\.vars/);
  assert.doesNotMatch(result.output, /read -s/);
  assert.deepEqual(result.requests, []);
});

test('setup refuse toute écriture implicite, même avec une clé', { timeout: 10000 }, async () => {
  for (const args of [
    ['--flavor=tablesdb'],
    ['--flavor=tablesdb', '--apply'],
    ['--flavor=tablesdb', '--apply', '--table=pdf_annotations_v2', '--dr-run'],
    ['--flavor=tablesdb', '--apply', '--table=pdf_annotations_v2', '--drop'],
  ]) {
    const result = await runAgainst(() => errorResponse(500), args, 'fake-test-key');
    assert.equal(result.code, 1, result.output);
    assert.deepEqual(result.requests, []);
  }
});

test('help et le plan ciblé ne contactent pas Appwrite', { timeout: 10000 }, async () => {
  const help = await runAgainst(() => errorResponse(500), ['--help'], 'fake-test-key');
  assert.equal(help.code, 0);
  assert.deepEqual(help.requests, []);
  const plan = await runAgainst(() => errorResponse(500), [
    '--dry-run', '--flavor=tablesdb', '--table=pdf_annotations_v2', '--new-table-only',
  ], 'fake-test-key');
  assert.equal(plan.code, 0, plan.output);
  assert.deepEqual(plan.requests, []);
  assert.match(plan.output, /Simulation statique/);
  assert.match(plan.output, /"key":"anchorJson","size":16384/);
  assert.doesNotMatch(plan.output, /tables\/profiles|tables\/annotations\//);
});

test('status détecte les permissions supplémentaires, les champs absents et une sécurité désactivée', { timeout: 10000 }, async () => {
  const table = TABLES.find((entry) => entry.id === 'annotations');
  const result = await runAgainst((request) => {
    if (request.url === '/v1/tablesdb/test_database') return { status: 200, body: { name: 'Test' } };
    if (request.url === '/v1/tablesdb/test_database/tables/annotations') {
      return { status: 200, body: liveTable(table, {
        columns: table.columns.slice(0, 6).map((column) => ({ ...column, status: 'available' })),
        indexes: [],
        rowSecurity: false,
        $permissions: [...table.permissions, 'read("any")'],
      }) };
    }
    return errorResponse(404);
  }, ['--status', '--flavor=tablesdb', '--table=annotations'], 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /colonne absente : anchorJson/);
  assert.match(result.output, /index absente : idx_annotation_document/);
  assert.match(result.output, /sécurité par ligne différente/);
  assert.match(result.output, /accès supplémentaires à examiner.*read\("any"\)/);
  assert.ok(result.requests.every(({ method }) => method === 'GET'));
});

test('status ne valide pas une colonne ou un index encore en attente', { timeout: 10000 }, async () => {
  const table = TABLES.find((entry) => entry.id === 'pdf_annotations_v2');
  const row = liveTable(table);
  row.columns.find((column) => column.key === 'anchorJson').status = 'processing';
  row.indexes.find((index) => index.key === 'idx_pdf_annot_document').status = 'failed';
  const result = await runAgainst((request) => request.url.endsWith('/test_database')
    ? { status: 200, body: { name: 'Test' } }
    : { status: 200, body: row }, ['--status', '--flavor=tablesdb', '--table=pdf_annotations_v2'], 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /colonne anchorJson non disponible.*processing/);
  assert.match(result.output, /index idx_pdf_annot_document non disponible.*failed/);
});

test('new-table-only ne modifie jamais une table déjà présente', { timeout: 10000 }, async () => {
  const result = await runAgainst(() => ({ status: 200, body: { name: 'Existe' } }), [
    '--apply', '--flavor=tablesdb', '--table=pdf_annotations_v2', '--new-table-only',
  ], 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /existe déjà.*aucun changement/);
  assert.equal(result.requests.length, 2);
  assert.ok(result.requests.every(({ method }) => method === 'GET'));
});

test('403 et 404 ambigu ne déclenchent jamais une création', { timeout: 10000 }, async () => {
  for (const response of [errorResponse(403), errorResponse(404, 'general_route_not_found')]) {
    for (const newOnly of [false, true]) {
      const result = await runAgainst((request) => request.url.endsWith('/test_database')
        ? { status: 200, body: { name: 'Test' } } : response, [
        '--apply', '--flavor=tablesdb', '--table=pdf_annotations_v2', ...(newOnly ? ['--new-table-only'] : []),
      ], 'fake-test-key');
      assert.equal(result.code, 1, result.output);
      assert.ok(result.requests.every(({ method }) => method === 'GET'));
    }
  }
});

function freshTableHandler({ onTableCreate = null, onPermissions = null } = {}) {
  const table = TABLES.find((entry) => entry.id === 'pdf_annotations_v2');
  const base = '/v1/tablesdb/test_database';
  const target = `${base}/tables/${table.id}`;
  let created = false;
  return (request) => {
    if (request.url === base && request.method === 'GET') return { status: 200, body: { name: 'Test' } };
    if (request.url === target && request.method === 'GET') {
      return created ? { status: 200, body: liveTable(table) } : errorResponse(404, 'table_not_found');
    }
    if (request.url === `${base}/tables` && request.method === 'POST') {
      if (onTableCreate) return onTableCreate();
      created = true;
      return { status: 201, body: {} };
    }
    if (request.url.startsWith(`${target}/columns/`) && request.method === 'GET') return errorResponse(404, 'column_not_found');
    if (request.url.startsWith(`${target}/indexes/`) && request.method === 'GET') return errorResponse(404, 'column_index_not_found');
    if (request.url.startsWith(`${target}/`) && request.method === 'POST') return { status: 201, body: {} };
    if (request.url === target && request.method === 'PUT') return onPermissions ? onPermissions() : { status: 200, body: {} };
    return errorResponse(500);
  };
}

test('la création ciblée ne touche ni aux anciennes tables ni à la base', { timeout: 10000 }, async () => {
  const result = await runAgainst(freshTableHandler(), [
    '--apply', '--flavor=tablesdb', '--table=pdf_annotations_v2', '--new-table-only',
  ], 'fake-test-key');
  assert.equal(result.code, 0, result.output);
  const writes = result.requests.filter(({ method }) => method !== 'GET');
  assert.ok(writes.length > 2);
  assert.ok(writes.every(({ method, url }) => method !== 'DELETE' && (
    url === '/v1/tablesdb/test_database/tables' || url.startsWith('/v1/tablesdb/test_database/tables/pdf_annotations_v2')
  )));
  assert.equal(writes.find(({ body }) => body?.key === 'anchorJson').body.size, 16384);
  assert.ok(result.requests.some(({ method, url }) => method === 'PUT' && url.endsWith('/pdf_annotations_v2')));
});

test('un conflit concurrent à la création arrête le plan au lieu de modifier la table', { timeout: 10000 }, async () => {
  const result = await runAgainst(freshTableHandler({ onTableCreate: () => errorResponse(409, 'table_already_exists') }), [
    '--apply', '--flavor=tablesdb', '--table=pdf_annotations_v2', '--new-table-only',
  ], 'fake-test-key');
  assert.equal(result.code, 1);
  assert.deepEqual(result.requests.filter(({ method }) => method !== 'GET').map(({ method, url }) => ({ method, url })), [
    { method: 'POST', url: '/v1/tablesdb/test_database/tables' },
  ]);
});

test('un refus de permissions termine le setup en erreur sans prétendre avoir réussi', { timeout: 10000 }, async () => {
  const result = await runAgainst(freshTableHandler({ onPermissions: () => errorResponse(403) }), [
    '--apply', '--flavor=tablesdb', '--table=pdf_annotations_v2', '--new-table-only',
  ], 'fake-test-key');
  assert.equal(result.code, 1);
  assert.match(result.output, /403/);
  assert.doesNotMatch(result.output, /permissions appliquées/);
});

test('fix-enums refuse une dérive mixte ou des éléments inconnus sans écrire', { timeout: 10000 }, async () => {
  const table = TABLES.find((entry) => entry.id === 'annotations');
  for (const mixed of [true, false]) {
    const row = liveTable(table);
    const column = row.columns.find((item) => item.key === 'kind');
    if (mixed) {
      column.elements = ['highlight'];
      column.required = true;
    } else {
      delete column.elements;
    }
    const result = await runAgainst(() => ({ status: 200, body: row }), [
      '--apply', '--flavor=tablesdb', '--table=annotations', '--fix-enums',
    ], 'fake-test-key');
    assert.equal(result.code, 1, result.output);
    assert.ok(result.requests.every(({ method }) => method === 'GET'));
  }
});
