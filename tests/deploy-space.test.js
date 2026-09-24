import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPACE_FILES,
  createSpace,
  parseArgs,
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
  for (const file of SPACE_FILES) {
    writeFileSync(join(dir, file), `contenu de ${file}\n`);
  }
  return dir;
}

test('les arguments CLI du déploiement sont parsés', () => {
  assert.deepEqual(parseArgs([]), { spaceId: null, private: false, skipFiles: false });
  assert.deepEqual(parseArgs(['--space-id', 'ktongue/Rupture', '--private', '--skip-files']), {
    spaceId: 'ktongue/Rupture',
    private: true,
    skipFiles: true,
  });
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

test('la création envoie un nom de dépôt (jamais un booléen)', async () => {
  let seenUrl = '';
  let payload = {};
  const restore = mockFetch(async (url, init) => {
    seenUrl = String(url);
    payload = JSON.parse(init.body);
    return Response.json({});
  });
  try {
    assert.equal(await createSpace('ktongue/Rupture', 'ktongue', false), true);
  } finally {
    restore();
  }
  assert.equal(seenUrl, 'https://huggingface.co/api/repos/create');
  assert.equal(typeof payload.name, 'string');
  assert.equal(payload.name, 'Rupture');
  assert.equal(payload.organization, 'ktongue');
  assert.equal(payload.type, 'space');
  assert.equal(payload.sdk, 'docker');
  assert.equal(payload.hardware, 'cpu-basic');
  assert.equal(payload.private, false);
});

test('la création sans namespace n’envoie pas d’organisation', async () => {
  let payload = {};
  const restore = mockFetch(async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({});
  });
  try {
    await createSpace('mon-space', 'ktongue', true);
  } finally {
    restore();
  }
  assert.equal(payload.name, 'mon-space');
  assert.equal(payload.organization, null);
  assert.equal(payload.private, true);
});

test('un Space déjà existant (409) n’est pas une erreur', async () => {
  const restore = mockFetch(async () => new Response('{}', { status: 409 }));
  try {
    assert.equal(await createSpace('ktongue/Rupture', 'ktongue', false), false);
  } finally {
    restore();
  }
});

test('l’upload pousse un commit NDJSON atomique vers /api/spaces', async () => {
  let seenUrl = '';
  let seenContentType = '';
  let lines = [];
  const restore = mockFetch(async (url, init) => {
    seenUrl = String(url);
    seenContentType = init.headers['Content-Type'];
    lines = String(init.body).split('\n').map((line) => JSON.parse(line));
    return Response.json({ commitOid: 'abc' });
  });
  try {
    await uploadSpaceFiles('ktongue/Rupture', fixtureDir());
  } finally {
    restore();
  }
  assert.equal(seenUrl, 'https://huggingface.co/api/spaces/ktongue/Rupture/commit/main');
  assert.equal(seenContentType, 'application/x-ndjson');
  assert.equal(lines[0].key, 'header');
  assert.ok(lines[0].value.summary.length > 0);
  const files = lines.slice(1);
  assert.equal(files.length, SPACE_FILES.length);
  assert.deepEqual(
    files.map((operation) => operation.value.path).sort(),
    [...SPACE_FILES].sort(),
  );
  for (const operation of files) {
    assert.equal(operation.key, 'file');
    assert.equal(operation.value.encoding, 'base64');
    const decoded = Buffer.from(operation.value.content, 'base64').toString('utf8');
    assert.equal(decoded, `contenu de ${operation.value.path}\n`);
  }
});

test('l’upload échoue vite si un fichier source manque', async () => {
  const restore = mockFetch(async () => {
    throw new Error('aucun appel réseau attendu');
  });
  try {
    await assert.rejects(uploadSpaceFiles('ktongue/Rupture', fixtureDir() + '-inexistant'), /manquant/);
  } finally {
    restore();
  }
});
