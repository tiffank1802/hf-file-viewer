import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  getBreadcrumbs,
  getFileKind,
  normalizeBucketItem,
  searchItems,
  sortItems,
} from '../src/utils/files.js';

test('les types de documents sont reconnus', () => {
  assert.equal(getFileKind('cours.pdf'), 'pdf');
  assert.equal(getFileKind('audio.m4a'), 'audio');
  assert.equal(getFileKind('notes.md'), 'text');
  assert.equal(getFileKind('GM', 'directory'), 'folder');
});

test('la recherche ignore les accents et favorise le nom', () => {
  const items = [
    { type: 'file', path: 'GM/Mécanique/solides.pdf', size: 10 },
    { type: 'directory', path: 'GM/Mecanique des fluides' },
    { type: 'file', path: 'TOEIC/mecanique.mp3', size: 10 },
  ];
  const results = searchItems(items, 'mecanique');
  assert.equal(results.length, 3);
  assert.deepEqual(
    new Set(results.slice(0, 2).map((item) => item.name)),
    new Set(['Mecanique des fluides', 'mecanique.mp3']),
  );
});

test('les dossiers restent avant les fichiers lors du tri', () => {
  const items = [
    normalizeBucketItem({ type: 'file', path: 'A.pdf', size: 100 }),
    normalizeBucketItem({ type: 'directory', path: 'Z' }),
  ];
  assert.equal(sortItems(items, 'name')[0].type, 'directory');
  assert.equal(sortItems(items, 'size')[0].type, 'directory');
});

test('le fil d’Ariane reconstruit chaque niveau', () => {
  assert.deepEqual(getBreadcrumbs('GM/3A GM/S5'), [
    { label: 'Bibliothèque', path: '' },
    { label: 'GM', path: 'GM' },
    { label: '3A GM', path: 'GM/3A GM' },
    { label: 'S5', path: 'GM/3A GM/S5' },
  ]);
});

test('formatBytes retourne une valeur française lisible', () => {
  assert.equal(formatBytes(1024), '1 Ko');
  assert.equal(formatBytes(0), '—');
});
