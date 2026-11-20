import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditReaderRollout,
  renderAuditReport,
  selectPilotDocuments,
} from '../scripts/reader-rollout-audit.mjs';

function entry(sourcePath, overrides = {}) {
  return {
    sourcePath,
    status: 'ready',
    sourcePresent: true,
    sourceSize: 100,
    artifactId: `artifact-${sourcePath}`,
    blockCount: 10,
    assetCount: 0,
    ...overrides,
  };
}

test('la sélection pilote privilégie diversité, assets et fichiers légers', () => {
  const items = [
    entry('Cours,non-représentable.pdf', { sourceSize: 1, assetCount: 8 }),
    entry('Cours/texte.pdf', { sourceSize: 20 }),
    entry('Cours/figure.pdf', { sourceSize: 30, assetCount: 2 }),
    entry('Cours/long.pdf', { sourceSize: 900, blockCount: 900 }),
    entry('Cours/support.docx', { sourceSize: 40 }),
    entry('Cours/tableau.xlsx', { sourceSize: 50 }),
    entry('Cours/notes.md', { sourceSize: 5 }),
    entry('Cours/ancien.pdf', { status: 'failed', sourceSize: 1 }),
  ];
  const catalog = { documents: Object.fromEntries(items.map((item) => [item.sourcePath, item])) };
  const selected = selectPilotDocuments(catalog, 6);
  assert.deepEqual(selected.map((item) => item.reason), [
    'pdf-with-assets',
    'pdf-text',
    'format-document',
    'format-spreadsheet',
    'format-text',
    'long-structured-pdf',
  ]);
  assert.ok(selected.every((item) => item.status === 'ready'));
  assert.ok(selected.every((item) => !item.sourcePath.includes(',')));
});

test('l’audit vérifie métadonnées, blocs, navigation directe et Range sans conversion', async () => {
  const sourcePath = 'Cours/énergie.pdf';
  const artifactId = 'artifact-energy';
  const requests = [];
  let healthAttempts = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    if (url.pathname === '/api/health') {
      healthAttempts += 1;
      if (healthAttempts === 1) {
        const error = new Error('socket disconnected');
        error.code = 'ECONNRESET';
        throw error;
      }
      return Response.json({ ok: true, backend: 'go', index: 'ready' });
    }
    if (url.pathname === '/api/reader/document') {
      return Response.json({
        schemaVersion: 'reader-ui/v1',
        sourcePath,
        artifactId,
        status: 'structured-ready',
      });
    }
    if (url.pathname === '/api/reader/blocks' && url.searchParams.has('blockId')) {
      return Response.json({
        schemaVersion: 'reader-ui/v1',
        sourcePath,
        artifactId,
        blocks: [{ id: 'b-1', ordinal: 1, type: 'text' }],
      });
    }
    if (url.pathname === '/api/reader/blocks') {
      const from = Number(url.searchParams.get('from')) || 1;
      return Response.json({
        schemaVersion: 'reader-ui/v1',
        sourcePath,
        artifactId,
        from,
        blocks: [{ id: from === 1 ? 'b-1' : 'b-2', ordinal: from, type: from === 1 ? 'text' : 'table' }],
        total: 2,
        nextFrom: from === 1 ? 2 : 0,
      });
    }
    if (url.pathname === '/api/file') {
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/100' },
      });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  const catalog = {
    updatedAt: '2026-09-28T00:00:00Z',
    pipelineVersion: 'docling-test',
    documents: {
      [sourcePath]: entry(sourcePath, { artifactId }),
    },
  };
  const report = await auditReaderRollout({
    origin: 'https://reader.example.test/path-ignored',
    catalog,
    documents: [sourcePath],
    fetchImpl,
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.passed, 1);
  assert.equal(healthAttempts, 2);
  assert.equal(report.documents[0].checks.pdfRange, 'ok');
  assert.equal(report.documents[0].checks.blockWindows, 2);
  assert.deepEqual(report.documents[0].blockTypes, ['table', 'text']);
  assert.deepEqual(report.pilotPaths, [sourcePath]);
  assert.ok(requests.every((request) => !request.url.pathname.includes('convert') && !request.url.pathname.includes('sync')));
  assert.ok(requests.every((request) => request.options.method === undefined));
  assert.equal(requests.find((request) => request.url.pathname === '/api/file').options.headers.Range, 'bytes=0-1023');
  assert.match(renderAuditReport(report), /VITE_READER_ROLLOUT="pilot"/);
});

test('un backend sans routes lecteur bloque le passage en pilote', async () => {
  const sourcePath = 'Cours/cours.pdf';
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/health') return Response.json({ ok: true, backend: 'go', index: 'cold' });
    return Response.json({ error: 'Route API introuvable.' }, { status: 404 });
  };
  const report = await auditReaderRollout({
    origin: 'https://old.example.test',
    catalog: { documents: { [sourcePath]: entry(sourcePath) } },
    documents: [sourcePath],
    fetchImpl,
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.failed, 1);
  assert.match(report.documents[0].errors.join(' '), /404/);
  assert.deepEqual(report.pilotPaths, []);
  assert.doesNotMatch(renderAuditReport(report), /VITE_READER_PILOT_PATHS/);
});
