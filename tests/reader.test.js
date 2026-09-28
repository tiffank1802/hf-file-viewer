import assert from 'node:assert/strict';
import test from 'node:test';

import { readerFileFromRoute } from '../src/reader/route.js';
import {
  buildSelectionAnchor,
  canonicalReaderText,
  findSelectionBlock,
  normalizedSelectionRects,
} from '../src/reader/selectionAnchor.js';

test('la route /read accepte uniquement un PDF et conserve la page demandée', () => {
  const file = readerFileFromRoute('/read', '?path=Cours%2Fm%C3%A9canique.pdf&page=7');
  assert.equal(file.path, 'Cours/mécanique.pdf');
  assert.equal(file.kind, 'pdf');
  assert.equal(file.previewPage, 7);
  assert.equal(readerFileFromRoute('/read', '?path=Cours%2Fnotes.docx'), null);
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
