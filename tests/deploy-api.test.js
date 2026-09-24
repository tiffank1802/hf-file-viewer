import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_SPACE_NAME,
  apiSpaceUrl,
  collectApiFiles,
  parseApiArgs,
  uploadApiFiles,
  writeOrigin,
} from '../scripts/deploy-api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.HF_TOKEN = 'test-token';

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test('les arguments du déploiement API sont parsés', () => {
  assert.deepEqual(parseApiArgs([]), {
    spaceId: null,
    private: false,
    skipFiles: false,
    writeOrigin: false,
  });
  assert.deepEqual(parseApiArgs(['--space-id', 'ktongue/enise-api', '--private', '--write-origin']), {
    spaceId: 'ktongue/enise-api',
    private: true,
    skipFiles: false,
    writeOrigin: true,
  });
});

test('les sources poussées contiennent l’enveloppe Docker et tout le Go utile', () => {
  const files = collectApiFiles(root);
  const paths = files.map((file) => file.path);

  assert.ok(paths.includes('Dockerfile'), 'Dockerfile absent');
  assert.ok(paths.includes('README.md'), 'README du Space absent');
  assert.ok(paths.includes('go.mod'), 'go.mod absent');
  assert.ok(paths.includes('cmd/enise-api/main.go'), 'point d’entrée absent');
  assert.ok(paths.includes('internal/api/chat.go'), 'assistant absent');
  assert.ok(paths.includes('internal/chat/retrieve.go'), 'recherche absente');

  // Les tests et les binaires ne servent à rien dans le Space.
  assert.equal(
    paths.filter((file) => file.endsWith('_test.go')).length,
    0,
    'les tests ne doivent pas être déployés',
  );
  assert.equal(
    paths.filter((file) => file.includes('internal/config/config_test.go')).length,
    0,
  );
  // Les chemins restent lisibles côté Linux.
  for (const path of paths) {
    assert.ok(!path.includes('\\'), `chemin Windows: ${path}`);
  }
});

test('l’URL d’exécution du Space est dérivée de son identifiant', () => {
  assert.equal(API_SPACE_NAME, 'enise-docs-api');
  assert.equal(apiSpaceUrl('ktongue/ENISE-Docs-Api'), 'https://ktongue-enise-docs-api.hf.space');
});

test('l’upload pousse un commit NDJSON atomique', async () => {
  const files = collectApiFiles(root);
  let body = '';
  let url = '';
  const restore = mockFetch(async (target, init) => {
    url = target;
    body = init.body;
    assert.equal(init.headers['Content-Type'], 'application/x-ndjson');
    return new Response('{}', { status: 200 });
  });
  try {
    const count = await uploadApiFiles('ktongue/enise-docs-api', files);
    assert.equal(count, files.length);
  } finally {
    restore();
  }

  assert.equal(url, 'https://huggingface.co/api/spaces/ktongue/enise-docs-api/commit/main');
  const lines = body.split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].key, 'header');
  assert.equal(lines[0].value.summary, 'Deploy ENISE Docs API (Go)');
  const pushed = lines.slice(1).map((line) => line.value.path);
  assert.ok(pushed.includes('Dockerfile'));
  assert.ok(pushed.includes('internal/api/chat.go'));
  // Le contenu est bien encodé, pas envoyé en clair dans le NDJSON.
  const goFile = lines.slice(1).find((line) => line.value.path === 'go.mod');
  assert.equal(goFile.value.encoding, 'base64');
  assert.ok(Buffer.from(goFile.value.content, 'base64').toString('utf8').includes('module'));
});

test('--write-origin met à jour GO_API_ORIGIN dans wrangler.jsonc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrangler-'));
  const file = join(dir, 'wrangler.jsonc');
  writeFileSync(file, '{\n  "vars": {\n    "GO_API_ORIGIN": ""\n  }\n}\n');

  writeOrigin(dir, 'https://ktongue-enise-docs-api.hf.space');
  const updated = readFileSync(file, 'utf8');
  assert.match(updated, /"GO_API_ORIGIN": "https:\/\/ktongue-enise-docs-api\.hf\.space"/);
  assert.ok(updated.startsWith('{\n  "vars": {'), 'le reste du fichier est préservé');
});

test('--write-origin échoue proprement sans variable GO_API_ORIGIN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wrangler-'));
  writeFileSync(join(dir, 'wrangler.jsonc'), '{\n  "name": "enise-docs"\n}\n');
  assert.throws(() => writeOrigin(dir, 'https://api.test'), /GO_API_ORIGIN introuvable/);
});
