import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from '../src/services/annotations.js';
import { canOpenStructuredReader, readerFileFromRoute } from '../src/reader/route.js';
import {
  fetchReaderBlock,
  fetchReaderBlocks,
  readerAssetUrl,
} from '../src/services/reader.js';
import {
  buildSelectionAnchor,
  buildStructuredSelectionAnchor,
  canonicalReaderText,
  findSelectionBlock,
  normalizedSelectionRects,
} from '../src/reader/selectionAnchor.js';
import { parseMarkdownTable } from '../src/reader/structured/structuredBlocks.js';

test('la route /read accepte les formats Docling connus et conserve la page demandée', () => {
  const file = readerFileFromRoute('/read', '?path=Cours%2Fm%C3%A9canique.pdf&page=7');
  assert.equal(file.path, 'Cours/mécanique.pdf');
  assert.equal(file.kind, 'pdf');
  assert.equal(file.previewPage, 7);
  assert.equal(readerFileFromRoute('/read', '?path=Cours%2Fnotes.docx')?.kind, 'office');
  assert.equal(readerFileFromRoute('/read', '?path=Cours%2Fnotes.epub')?.path, 'Cours/notes.epub');
  assert.equal(canOpenStructuredReader('Cours/tableau.xlsx'), true);
  assert.equal(readerFileFromRoute('/read', '?path=Cours%2Fscript.js'), null);
  assert.equal(readerFileFromRoute('/read', '?path=..%2Fsecret.pdf'), null);
  assert.equal(readerFileFromRoute('/', '?path=Cours%2Fmecanique.pdf'), null);
});

test('la sélection est canonicalisée et reliée à un bloc Docling', () => {
  const blocks = [{ id: 'text/42', text: 'La méca-\nnique des solides décrit ce modèle.' }];
  assert.equal(canonicalReaderText('  MÉCA-\nNIQUE  '), 'mécanique');
  assert.equal(findSelectionBlock(blocks, 'mécanique des solides')?.id, 'text/42');

  const anchor = buildSelectionAnchor({
    quote: 'mécanique des solides',
    page: 3,
    pageText: 'Introduction à la mécanique des solides et à ses modèles.',
    blocks,
    rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
  });
  assert.equal(anchor.blockId, 'text/42');
  assert.equal(anchor.page, 3);
  assert.equal(anchor.quote, 'mécanique des solides');
  assert.ok(anchor.prefix.endsWith('la '));
  assert.ok(anchor.suffix.startsWith(' et'));
  assert.deepEqual(anchor.rects, [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }]);
});

test('les rectangles de sélection sont normalisés, bornés et limités', () => {
  const page = { left: 100, top: 200, width: 400, height: 800 };
  const rects = Array.from({ length: 40 }, (_, index) => ({
    left: index === 0 ? 50 : 140,
    top: 280,
    width: 80,
    height: 20,
  }));
  const normalized = normalizedSelectionRects(rects, page);
  assert.equal(normalized.length, 32);
  assert.deepEqual(normalized[0], { x: 0, y: 0.1, w: 0.2, h: 0.025 });
});

test('une sélection vide ou démesurée ne produit aucune ancre', () => {
  assert.equal(buildSelectionAnchor({ quote: ' ' }), null);
  assert.equal(buildSelectionAnchor({ quote: 'x'.repeat(2001) }), null);
});

test('la sélection structurée conserve le blockId sans inventer de géométrie PDF', () => {
  const anchor = buildStructuredSelectionAnchor({
    quote: 'énergie cinétique',
    blockId: 'b-energy',
    blockText: 'Dans ce chapitre, l’énergie cinétique dépend de la vitesse.',
  });
  assert.equal(anchor.blockId, 'b-energy');
  assert.equal(anchor.page, 0);
  assert.deepEqual(anchor.rects, []);
  assert.ok(anchor.prefix.endsWith('l’'));
  assert.equal(buildStructuredSelectionAnchor({ quote: 'passage absent', blockId: 'b-energy', blockText: 'autre texte' }), null);
});

test('les tableaux Docling sont convertis en cellules textuelles sûres', () => {
  const table = parseMarkdownTable('| Force | Valeur |\n|:---|---:|\n| Traction | 12 \\| 14 N |');
  assert.deepEqual(table.headers, ['Force', 'Valeur']);
  assert.deepEqual(table.rows, [['Traction', '12 | 14 N']]);
});

test('le client structuré borne les fenêtres et construit les URL d’assets', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ blocks: [], nextFrom: 0 }), { status: 200 });
  };
  try {
    await fetchReaderBlocks('GM/cours.docx', 'artifact-2', 41, 40);
    await fetchReaderBlock('GM/cours.docx', 'artifact-2', 'b-target');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(requests[0], /\/api\/reader\/blocks\?/);
  assert.match(requests[0], /from=41/);
  assert.match(requests[1], /blockId=b-target/);
  assert.match(readerAssetUrl('GM/cours.docx', 'artifact-2', 'figure-1'), /asset=figure-1/);
});

test('le client d’annotations utilise le CRUD privé et encode le chemin', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), ...options });
    return new Response(JSON.stringify(options.method === 'DELETE' ? { ok: true } : { ok: true, items: [], item: { id: 'ann-1' } }), {
      status: options.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await listAnnotations('GM/énergie & vitesse.pdf', 'artifact-1');
    await createAnnotation({ sourcePath: 'GM/cours.pdf', artifactId: 'artifact-1', anchor: { quote: 'énergie', page: 2 } });
    await updateAnnotation('ann-1', { body: 'À relire' });
    await deleteAnnotation('ann-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(requests[0].url, /path=GM%2F%C3%A9nergie\+%26\+vitesse.pdf/);
  assert.deepEqual(requests.map((request) => request.method || 'GET'), ['GET', 'POST', 'PATCH', 'DELETE']);
  assert.ok(requests.every((request) => request.credentials === 'same-origin'));
  assert.match(requests[1].body, /artifact-1/);
});
