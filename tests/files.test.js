import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFolderCounts,
  countFilesByDirectory,
  formatBytes,
  getBreadcrumbs,
  getFileKind,
  normalizeBucketItem,
  searchItems,
  sortItems,
} from '../src/utils/files.js';
import { getFallbackCatalog } from '../src/data/fallbackData.js';

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

test('les effectifs sont calculés une fois pour tous les dossiers parents', () => {
  const { counts, totalFiles } = countFilesByDirectory([
    { type: 'directory', path: 'GM' },
    { type: 'file', path: 'GM/3A GM/S5/poly.pdf' },
    { type: 'file', path: 'GM/3A GM/S6/td.pdf' },
    { type: 'file', path: 'TOEIC/audio.mp3' },
  ]);
  assert.equal(totalFiles, 3);
  assert.equal(counts.GM, 2);
  assert.equal(counts['GM/3A GM/S5'], 1);
  assert.equal(counts.TOEIC, 1);
});

test('applyFolderCounts complète les dossiers depuis le JSON d’index', () => {
  const items = [
    normalizeBucketItem({ type: 'directory', path: 'GM' }),
    normalizeBucketItem({ type: 'file', path: 'GM/poly.pdf', size: 10 }),
  ];
  const [folder, file] = applyFolderCounts(items, { GM: 128 });
  assert.equal(folder.count, 128);
  assert.equal(file.count, null);
  assert.equal(applyFolderCounts(items, {})[0].count, null);
});

test('le catalogue d’aperçu local fournit des effectifs hors ligne', () => {
  const { counts, totalFiles, items } = getFallbackCatalog();
  assert.ok(items.length > 0);
  assert.ok(totalFiles > 0);
  assert.ok(Number.isFinite(counts.GM));
});
