import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SPACE_ID,
  SPACE_FILES,
  buildSyncOperations,
  createSpace,
  listRemoteSpaceFiles,
  parseArgs,
  setSpaceSecret,
  setSpaceVariable,
  spaceExists,
  uploadSpaceFiles,
} from '../scripts/deploy-space.js';

process.env.HF_TOKEN = 'test-token';

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'space-fixtures-'));
  for (const file of SPACE_FILES) writeFileSync(join(dir, file), `contenu de ${file}\n`);
  return dir;
}

test('le déploiement cible Rupture et active le nettoyage par défaut', () => {
  assert.deepEqual(parseArgs([]), {
    spaceId: DEFAULT_SPACE_ID,
    private: false,
    skipFiles: false,
    prune: true,
    configureHfToken: true,
    configureVariables: true,
  });
  assert.equal(DEFAULT_SPACE_ID, 'ktongue/Rupture');
  assert.deepEqual(
    parseArgs([
      '--space-id', 'org/indexer', '--private', '--skip-files', '--no-prune',
      '--skip-hf-token-secret', '--skip-variables',
    ]),
    {
      spaceId: 'org/indexer',
      private: true,
      skipFiles: true,
      prune: false,
      configureHfToken: false,
      configureVariables: false,
    },
  );
  assert.throws(() => parseArgs(['--inconnue']), /Option inconnue/);
  assert.throws(() => parseArgs(['--space-id', 'sans-namespace']), /invalide/);
});

test('la liste distante conserve uniquement les entrées fichier', async () => {
  let seenUrl = '';
  const restore = mockFetch(async (url) => {
    seenUrl = String(url);
    return Response.json([
      { type: 'file', path: 'app.py' },
      { type: 'directory', path: '__pycache__' },
      { type: 'file', path: '__pycache__/old.pyc' },
    ]);
  });
  try {
    assert.deepEqual(await listRemoteSpaceFiles('ktongue/Rupture'), [
      'app.py', '__pycache__/old.pyc',
    ]);
  } finally {
    restore();
  }
  assert.equal(
    seenUrl,
    'https://huggingface.co/api/spaces/ktongue/Rupture/tree/main?recursive=true&expand=false',
  );
});

test('l’existence du Space est détectée avant création', async () => {
  const restore = mockFetch(async (url) => {
    assert.equal(url, 'https://huggingface.co/api/spaces/ktongue/Rupture');
    return new Response('{}', { status: 200 });
  });
  try {
    assert.equal(await spaceExists('ktongue/Rupture'), true);
  } finally {
    restore();
  }

  const restoreMissing = mockFetch(async () => new Response('{}', { status: 404 }));
  try {
    assert.equal(await spaceExists('ktongue/Rupture'), false);
  } finally {
    restoreMissing();
  }

  const restoreAuth = mockFetch(async () => new Response('{}', { status: 401 }));
  try {
    await assert.rejects(spaceExists('ktongue/Rupture'), /Token HF_TOKEN invalide/);
  } finally {
    restoreAuth();
  }
});

test('la création envoie le nom, le namespace et le SDK Docker', async () => {
  let payload = {};
  const restore = mockFetch(async (url, init) => {
    assert.equal(url, 'https://huggingface.co/api/repos/create');
    payload = JSON.parse(init.body);
    return Response.json({});
  });
  try {
    assert.equal(await createSpace('ktongue/Rupture', 'ktongue', false), true);
  } finally {
    restore();
  }
  assert.deepEqual(payload, {
    type: 'space',
    name: 'Rupture',
    organization: 'ktongue',
    sdk: 'docker',
    hardware: 'cpu-basic',
    private: false,
  });
});

test('un Space déjà existant (409) n’est pas une erreur', async () => {
  const restore = mockFetch(async () => new Response('{}', { status: 409 }));
  try {
    assert.equal(await createSpace('ktongue/Rupture', 'ktongue', false), false);
  } finally {
    restore();
  }
});

test('les opérations atomiques écrivent l’allowlist et suppriment tout héritage', () => {
  const remote = [
    '.gitattributes',
    'CAL_IA.py',
    'Dockerfile',
    'ELEMENT.txt',
    'NODE.txt',
    'README.md',
    'U.txt',
    '__pycache__/CAL_IA.cpython-312.pyc',
    'app.py',
    'config.yaml',
    'freecad_cad_convert.py',
    'freecad_convert.py',
    'requirements.txt',
  ];
  const operations = buildSyncOperations(fixtureDir(), remote);
  const writes = operations.filter((operation) => operation.key === 'file');
  const deletes = operations.filter((operation) => operation.key === 'deletedFile');

  assert.deepEqual(writes.map((operation) => operation.value.path), SPACE_FILES);
  assert.deepEqual(deletes.map((operation) => operation.value.path), [
    '__pycache__/CAL_IA.cpython-312.pyc',
    'CAL_IA.py',
    'config.yaml',
    'ELEMENT.txt',
    'freecad_cad_convert.py',
    'freecad_convert.py',
    'NODE.txt',
    'U.txt',
  ]);
  assert.ok(!deletes.some((operation) => operation.value.path === '.gitattributes'));
  assert.ok(!deletes.some((operation) => operation.value.path === 'app.py'));
});

test('--no-prune ne génère aucune suppression distante', () => {
  const operations = buildSyncOperations(
    fixtureDir(),
    ['CAL_IA.py', 'freecad_convert.py'],
    { prune: false },
  );
  assert.ok(operations.every((operation) => operation.key === 'file'));
});

test('le commit NDJSON réunit écritures et suppressions', async () => {
  let seenUrl = '';
  let seenContentType = '';
  let lines = [];
  const remoteFiles = ['.gitattributes', 'CAL_IA.py', 'freecad_cad_convert.py'];
  const restore = mockFetch(async (url, init) => {
    seenUrl = String(url);
    seenContentType = init.headers['Content-Type'];
    lines = String(init.body).split('\n').map((line) => JSON.parse(line));
    return Response.json({ commitOid: 'abc' });
  });
  try {
    const result = await uploadSpaceFiles('ktongue/Rupture', fixtureDir(), { remoteFiles });
    assert.deepEqual(result, { uploaded: SPACE_FILES.length, deleted: 2 });
  } finally {
    restore();
  }

  assert.equal(seenUrl, 'https://huggingface.co/api/spaces/ktongue/Rupture/commit/main');
  assert.equal(seenContentType, 'application/x-ndjson');
  assert.equal(lines[0].key, 'header');
  assert.match(lines[0].value.summary, /Docling/);
  assert.deepEqual(
    lines.filter((line) => line.key === 'deletedFile').map((line) => line.value.path),
    ['CAL_IA.py', 'freecad_cad_convert.py'],
  );
  for (const operation of lines.filter((line) => line.key === 'file')) {
    assert.equal(operation.value.encoding, 'base64');
    assert.equal(
      Buffer.from(operation.value.content, 'base64').toString('utf8'),
      `contenu de ${operation.value.path}\n`,
    );
  }
});

test('la synchronisation échoue avant le réseau si un fichier source manque', async () => {
  const restore = mockFetch(async () => {
    throw new Error('aucun appel réseau attendu');
  });
  try {
    await assert.rejects(
      uploadSpaceFiles('ktongue/Rupture', fixtureDir() + '-absent', { remoteFiles: [] }),
      /manquant/,
    );
  } finally {
    restore();
  }
});

test('secrets et variables sont envoyés aux endpoints Space sans fuite console', async () => {
  const requests = [];
  const restore = mockFetch(async (url, init) => {
    requests.push({ url: String(url), payload: JSON.parse(init.body) });
    return Response.json({});
  });
  try {
    await setSpaceSecret('ktongue/Rupture', 'HF_TOKEN', 'hf_secret', 'bucket access');
    await setSpaceVariable('ktongue/Rupture', 'SOURCE_BUCKET_ID', 'ktongue/ENISE-SITE');
  } finally {
    restore();
  }
  assert.deepEqual(requests, [
    {
      url: 'https://huggingface.co/api/spaces/ktongue/Rupture/secrets',
      payload: { key: 'HF_TOKEN', value: 'hf_secret', description: 'bucket access' },
    },
    {
      url: 'https://huggingface.co/api/spaces/ktongue/Rupture/variables',
      payload: { key: 'SOURCE_BUCKET_ID', value: 'ktongue/ENISE-SITE' },
    },
  ]);
});
